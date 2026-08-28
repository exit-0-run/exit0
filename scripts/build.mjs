#!/usr/bin/env node
// Validator and generator. The order of the steps is part of the contract:
//   1. parse  2. derived fields  3. schema  4. semantics  5. signatures and evidence  6. write
// The write happens ONLY when there is not a single error, otherwise a run
// that ended in an error would leave computed fields in the source files.
// Zero dependencies. Run in CI on every PR and by the server before every commit.

import { readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  MAXLEN, keyId, fingerprint, check, payload, problemFields,
  canonUrl, canonText, canonLine, solutionId, verificationId, findingId,
  evidencePath, checkVerification, cell, mdUrl, solCmp, verdictHeads, verdictStrength, canonNeeds, DOMAINS, KINDS, AREAS, probCmp,
  docketId,
} from "./sign.mjs";

const DIR = "problems";
const README = "README.md";
const INDEX = "index.json";
const SCHEMA = join(DIR, "_schema.json");
const DOCKET = "docket.json";
const START = "<!-- INDEX:START -->";
const END = "<!-- INDEX:END -->";
const CHECK = process.argv.includes("--check");

const errors = [];
const sha = (b) => createHash("sha256").update(b).digest("hex");

// --- 1. parse ---

// Paths are relative to the CURRENT DIRECTORY, so running this by absolute path
// from someone else's directory validates someone else's registry. Without this gate
// that produced a confident "OK" about a completely different tree (RUNBOOK, Recovery).
const dirList = (dir) => {
  try {
    return readdirSync(dir);
  } catch (e) {
    console.error(`no ${dir}/ directory in ${process.cwd()} (${e.code ?? e.message}). build.mjs reads paths relative to the current directory, so run it from the registry directory: cd <registry> && node scripts/build.mjs`);
    process.exit(1);
  }
};

const files = dirList(DIR).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort();
const loaded = [];
for (const file of files) {
  const path = join(DIR, file);
  let text, p;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    errors.push(`${path}: cannot be read (${e.message})`);
    continue;
  }
  try {
    p = JSON.parse(text);
  } catch (e) {
    errors.push(`${path}: does not parse as JSON (${e.message})`);
    continue;
  }
  if (p === null || typeof p !== "object" || Array.isArray(p)) {
    errors.push(`${path}: a problem must be a JSON object`);
    continue;
  }
  loaded.push({ path, file, p, text });
}

// --- 2. derived fields ---
// This is the only place in the whole repo that writes verified, disputed, settled,
// verified_by and status. The server does not touch them, the client does not send them.

const derive = (p) => {
  for (const s of p.solutions) {
    // The counting verdict of a verifier is the head of THEIR chain, not their last
    // record in the array. Nothing derived here may depend on the order of records
    // in the file: that order is what a pull request can change without touching a
    // single signature. Structural faults in a chain are reported in step 4; here we
    // only skip the group, so one broken chain does not take the whole file down.
    const counting = verdictHeads(s.verifications).heads;
    const oks = counting.filter((v) => v.verdict === "ok");
    const mismatches = counting.filter((v) => v.verdict === "mismatch");
    s.verified = oks.length > 0;
    s.disputed = mismatches.length > 0;
    s.settled = oks.length > mismatches.length;
    if (s.verified) s.verified_by = oks[0].verifier;
    else delete s.verified_by;
  }
  // The frontier: what to clone and what number to beat. Derived here and nowhere else
  // (invariant 7), so it cannot be asserted by a client or written by the server.
  //
  // `best` counts SETTLED entries only. An unverified score is a claim, and a frontier a
  // claim can move is a scoreboard again.
  //
  // The plan this came from also asked for a `verified_best` over entries that are
  // verified and not disputed, described as a cheaper signal. It is the opposite:
  // verified && !disputed means oks >= 1 and mismatches == 0, which IMPLIES
  // oks > mismatches, so it is a strict SUBSET of settled and could only ever be lower.
  // The field that actually adds something is the top CLAIM, verified or not: it is the
  // number nobody has checked yet, which is the same thing as saying it is the work
  // /work exists to hand out.
  const hib = !!(p.acceptance && p.acceptance.higher_is_better);
  const better = (a, b) => (hib ? a.score > b.score : a.score < b.score);
  // Deterministic to the last element: ties go to the earlier date, then the lower sid.
  // Without this the frontier could differ between two clones of the same commit.
  const pick = (list) =>
    list.reduce((acc, s) => {
      if (!acc) return s;
      if (better(s, acc)) return s;
      if (s.score !== acc.score) return acc;
      const at = String(s.at ?? ""), aat = String(acc.at ?? "");
      if (at !== aat) return at < aat ? s : acc;
      return s.sid < acc.sid ? s : acc;
    }, null);

  const settled = p.solutions.filter((s) => s.settled);
  const best = pick(settled);
  const claimed = pick(p.solutions);
  p.frontier = {
    best: best ? best.sid : null,
    best_score: best ? best.score : null,
    claimed: claimed ? claimed.sid : null,
    claimed_score: claimed ? claimed.score : null,
    attempts: p.solutions.length,
    keys: new Set(p.solutions.map((s) => { try { return keyId(s.key); } catch { return s.author; } })).size,
    // Did the verdict that settled this carry conditions. A verification can now say what
    // it was asserting, and without this the caveat reached exactly one page: the problem
    // detail. Every surface a passer-by actually reads - the listing, README, the badge -
    // showed an unqualified "solved". That was measured on a live write, not imagined: a
    // verdict whose own note said "not independent" rendered as plain SOLVED everywhere
    // except the one page nobody lands on first.
    // It says a caveat EXISTS, never what it says: summarising somebody's signed sentence
    // into a flag would be the registry paraphrasing a claim it did not make.
    caveat: best
      ? verdictHeads(best.verifications).heads.some((v) => v.verdict === "ok" && v.note)
      : false,
  };

  if (p.status === "dead") return p;
  p.status = p.solutions.some((s) => s.settled) ? "solved" : p.solutions.length ? "in-progress" : "open";
  return p;
};

for (const { path, p } of loaded) {
  try {
    derive(p);
  } catch (e) {
    errors.push(`${path}: cannot compute the derived fields (${e.message}). Check the shape of solutions/verifications`);
  }
}

// --- 3. schema ---
// A subset of JSON Schema, deliberately narrow. A keyword outside the list is
// an error, not a silent skip: otherwise a typo in the schema looks
// like a passing test.

const KEYWORDS = new Set(["type", "required", "properties", "items", "enum", "pattern", "minLength", "maxLength", "minimum", "maximum", "additionalProperties"]);
const ANNOTATIONS = new Set(["$schema", "title", "description", "$comment"]);
const TYPES = new Set(["object", "array", "string", "number", "boolean", "null"]);

const schemaKeywords = (node, at) => {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    errors.push(`${SCHEMA}: ${at} is not a schema object`);
    return;
  }
  for (const k of Object.keys(node)) {
    if (ANNOTATIONS.has(k)) continue;
    if (!KEYWORDS.has(k)) {
      errors.push(`${SCHEMA}: unsupported keyword "${k}" in ${at}. build.mjs knows only: ${[...KEYWORDS].join(", ")}`);
      continue;
    }
    if (k === "additionalProperties" && node[k] !== false)
      errors.push(`${SCHEMA}: additionalProperties in ${at}: the only supported value is false`);
    if (k === "type") {
      for (const t of Array.isArray(node.type) ? node.type : [node.type])
        if (!TYPES.has(t)) errors.push(`${SCHEMA}: unsupported type "${t}" in ${at}`);
    }
  }
  if (node.properties) for (const [k, v] of Object.entries(node.properties)) schemaKeywords(v, `${at}.properties.${k}`);
  if (node.items) schemaKeywords(node.items, `${at}.items`);
};

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

const validate = (node, value, at, err) => {
  if (node.type) {
    const want = Array.isArray(node.type) ? node.type : [node.type];
    if (!want.includes(typeOf(value))) {
      err(`${at}: expected ${want.join(" or ")}, got ${typeOf(value)}`);
      return;
    }
  }
  if (node.enum && !node.enum.includes(value)) {
    err(`${at}: the allowed values are ${node.enum.map((x) => JSON.stringify(x)).join(", ")}`);
    return;
  }
  const t = typeOf(value);
  if (t === "string") {
    if (node.pattern !== undefined && !new RegExp(node.pattern).test(value)) err(`${at}: does not match the pattern ${node.pattern}`);
    if (node.minLength !== undefined && value.length < node.minLength) err(`${at}: min ${node.minLength} characters`);
    if (node.maxLength !== undefined && value.length > node.maxLength) err(`${at}: max ${node.maxLength} characters`);
  }
  if (t === "number") {
    if (node.minimum !== undefined && value < node.minimum) err(`${at}: minimum ${node.minimum}`);
    if (node.maximum !== undefined && value > node.maximum) err(`${at}: maximum ${node.maximum}`);
  }
  if (t === "object") {
    for (const r of node.required ?? []) if (!(r in value)) err(`${at}: missing required field "${r}"`);
    if (node.additionalProperties === false)
      for (const k of Object.keys(value)) if (!(node.properties && k in node.properties)) err(`${at}: unknown field "${k}"`);
    if (node.properties) for (const [k, sub] of Object.entries(node.properties)) if (k in value) validate(sub, value[k], `${at}.${k}`, err);
  }
  if (t === "array" && node.items) value.forEach((x, i) => validate(node.items, x, `${at}[${i}]`, err));
};

let schema = null;
const beforeSchema = errors.length;
try {
  schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
  schemaKeywords(schema, "$");
} catch (e) {
  errors.push(`${SCHEMA}: ${e.message}`);
}

// A broken schema holds up validation of every file. ONE broken problem
// file does not hold up the rest: each answers for itself.
const clean = new Set();
if (schema && errors.length === beforeSchema) {
  for (const { path, p } of loaded) {
    const before = errors.length;
    validate(schema, p, "$", (m) => errors.push(`${path}: ${m}`));
    if (errors.length === before) clean.add(path);
  }
}

// --- 4. semantics ---
// Checked only for files that passed the schema: otherwise we would repeat
// the same shape error in several wordings.

// --no-optional-locks on EVERY git read: otherwise the validator started by the
// server competes for .git/index.lock with the very commit it is there to let through.
const gitRead = (...a) => execFileSync("git", ["--no-optional-locks", ...a], { stdio: ["ignore", "pipe", "ignore"] });

const seenIds = new Set();
const fromHead = (path) => {
  try {
    return gitRead("show", `HEAD:${path}`).toString("utf8");
  } catch {
    return null;
  }
};

// The blob id git will give THESE bytes. We compute it ourselves so that a single
// git call covers the whole batch of evidence: the sha256 of the working-tree file
// is checked below, and this checks whether git committed EXACTLY those bytes.
// Without it a line-ending conversion at `git add` goes unnoticed by the
// writer and shows up only in someone else's clone, which is where there is no one left to ask.
const NUL = String.fromCharCode(0);
const gitOid = (buf) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${buf.length}${NUL}`, "utf8"), buf])).digest("hex");

const headOids = (paths) => {
  const out = new Map();
  if (!paths.length) return out;
  let lines;
  try {
    lines = execFileSync("git", ["--no-optional-locks", "cat-file", "--batch-check"], {
      input: paths.map((p) => `HEAD:${p}`).join("\n") + "\n",
      stdio: ["pipe", "pipe", "ignore"],
      maxBuffer: 1 << 24,
    }).toString("utf8").trim().split("\n");
  } catch {
    return out; // no HEAD (first commit) or no git: we check the working tree only
  }
  paths.forEach((p, i) => {
    const [oid, type] = String(lines[i] ?? "").split(" ");
    if (type === "blob") out.set(p, oid);
  });
  return out;
};

for (const { path, file, p } of loaded) {
  if (!clean.has(path)) continue;
  const err = (m) => errors.push(`${path}: ${m}`);

  if (seenIds.has(p.id)) err(`id ${p.id} already exists in another file`);
  else seenIds.add(p.id);
  if (!file.startsWith(`${p.id}-`)) err(`the file name must start with ${p.id}-`);

  // tolerance is frozen from the first verification on: otherwise the author would
  // move the band under signatures that are already filed. This check is the
  // DIAGNOSIS, not the enforcement: it compares against HEAD, so it says nothing in
  // a pull request, where HEAD already is the change. The enforcement is that every
  // verifier signs the band, so moving it breaks their signatures below, in any
  // clone, with no history. Kept because "open a new problem" reads better than
  // twelve broken signatures.
  if (p.solutions.some((s) => s.verifications.length)) {
    const prev = fromHead(path);
    let old = null;
    try {
      old = prev === null ? null : JSON.parse(prev);
    } catch {}
    const was = old && old.acceptance ? old.acceptance.tolerance : undefined;
    if (was !== undefined && was !== p.acceptance.tolerance)
      err(`acceptance.tolerance changed from ${was} to ${p.acceptance.tolerance} while the problem already has verifications. Open a new problem`);
  }

  const seenSid = new Set();
  const seenDedup = new Set();
  p.solutions.forEach((s, i) => {
    if (seenSid.has(s.sid)) err(`solutions[${i}]: sid ${s.sid} occurs twice`);
    else seenSid.add(s.sid);
    let dedup = null;
    try {
      // (repo, ref, key), the same key the server chains on. Hosted attempts are branches
      // in ONE repository, so every entry from one key shares a repo URL and differs only
      // by ref: a dedup that stopped at (repo, key) would call the second one a duplicate
      // and refuse a write the server had every reason to accept.
      dedup = `${canonUrl(s.repo)}|${s.ref ?? "-"}|${keyId(s.key)}`;
    } catch {}
    if (dedup !== null) {
      if (seenDedup.has(dedup)) err(`solutions[${i}]: the same (repo, ref) from the same key occurs twice. The write should be a replacement, not an addition`);
      else seenDedup.add(dedup);
    }
    const seenVid = new Set();
    s.verifications.forEach((v, j) => {
      if (seenVid.has(v.vid)) err(`solutions[${i}].verifications[${j}]: vid ${v.vid} occurs twice`);
      else seenVid.add(v.vid);
    });
    // Every verifier's records must form ONE chain, rooted at the record whose
    // replaces is "-" and ending in a single head. Without this a swap of two
    // correctly signed records changed the status of the problem and --check
    // stayed green.
    for (const e of verdictHeads(s.verifications).errors)
      err(`solutions[${i}].verifications[${e.at}]: ${e.error}`);
  });
}

// --- 5. signatures, canonical form, evidence ---
// Everything the server accepted can be recomputed here from scratch, with no network.

const sameField = (fn, v, label, max, err) => {
  try {
    if (fn(v, label, max) !== v) err(`${label}: the stored value is not canonical`);
  } catch (e) {
    err(`${label}: ${e.message}`);
  }
};

// Every signature check is spelled out in full: check(key, sig, payload(action, fields)).
// No wrapper, because a wrapper hides the contract: that is exactly how verifyEntry died.
const sigOk = (key, sig, msg, err, what) => {
  if (msg !== null && !check(key, sig, msg)) err(`${what}: the signature does not match the content (payload: ${msg.slice(0, 200)})`);
};

// keyId throws on a key outside the grammar. The schema will not let one through here, but build.mjs
// runs inside the server write path: an exception instead of an error is a 500 instead of a 422.
const canonicalKey = (k) => {
  try {
    return k === keyId(k);
  } catch {
    return false;
  }
};

// One git call for the whole run, not one per piece of evidence.
const wanted = [];
for (const { path, p } of loaded) {
  if (!clean.has(path)) continue;
  for (const s of p.solutions)
    for (const v of s.verifications) {
      try {
        wanted.push(evidencePath(p.id, v.output_sha256));
      } catch {}
    }
}
const committed = headOids(wanted);

for (const { path, p } of loaded) {
  if (!clean.has(path)) continue;
  const err = (m) => errors.push(`${path}: ${m}`);

  sameField(canonLine, p.title, "title", MAXLEN.title, err);
  // The schema already checked membership. This checks the ORDER, which the schema
  // has no way to express and which the signature depends on.
  try {
    const c = canonNeeds(p.needs);
    if (c.length !== p.needs.length || c.some((x, i) => x !== p.needs[i]))
      err(`needs: the stored value is not canonical, expected ${JSON.stringify(c)}`);
  } catch (e) {
    err(`needs: ${e.message}`);
  }
  sameField(canonText, p.problem, "problem", MAXLEN.problem, err);
  sameField(canonText, p.acceptance.how, "acceptance.how", MAXLEN.how, err);
  sameField(canonLine, p.acceptance.metric, "acceptance.metric", MAXLEN.metric, err);

  // a problem with no key is legal: that is an entry opened by pull request. But a name
  // derived from a key needs a key, otherwise a PR impersonates someone else's fingerprint.
  if (p.key === undefined && /^[0-9a-f]{12}$/.test(p.opened_by ?? ""))
    err("opened_by looks like a key fingerprint, but the problem is not signed");
  if (p.key !== undefined || p.sig !== undefined) {
    if (p.key === undefined || p.sig === undefined) err("there is a key or a sig, there must be both");
    else if (!canonicalKey(p.key)) err("the problem key is not in canonical base64 form");
    else {
      if (fingerprint(p.key) !== p.opened_by) err("opened_by does not match the key fingerprint");
      let msg = null;
      try {
        msg = payload("problem", problemFields(p));
      } catch (e) {
        err(`problem: ${e.message}`);
      }
      sigOk(p.key, p.sig, msg, err, "problem");
    }
  }

  // Lineage, offline. THREE rules, and the one that is deliberately absent matters as much
  // as the three: a parent that is not in the array is NOT an error. A replaced entry is
  // overwritten in place by the server, so the sid a submitter legitimately built on stops
  // existing the moment its author corrects their own result. Treating that as invalid
  // would turn one stranger's correction into a permanently red --check for every clone,
  // which is the same shape of fault as a title that blew the README markers apart.
  // A dangling parent renders as an origin whose entry has since been superseded, and that
  // is the truth: the code it came from was real when it was taken.
  {
    const bySid = new Map(p.solutions.map((s) => [s.sid, s]));
    p.solutions.forEach((s, i) => {
      const at = `solutions[${i}]`;
      const bo = s.builds_on;
      if (bo === undefined) return err(`${at}: builds_on is missing ("-" when the attempt started from scratch)`);
      if (bo !== "-" && !/^[0-9a-f]{16}$/.test(bo)) return err(`${at}: builds_on must be "-" or 16 hex characters`);
      if (bo === s.sid) return err(`${at}: builds_on names the entry itself`);
      const seen = new Set([s.sid]);
      let cur = bo === "-" ? null : bySid.get(bo);
      for (let d = 0; cur && d < 64; d++) {
        if (seen.has(cur.sid)) return err(`${at}: builds_on closes a loop at ${cur.sid}`);
        seen.add(cur.sid);
        cur = cur.builds_on && cur.builds_on !== "-" ? bySid.get(cur.builds_on) ?? null : null;
      }
      if (cur) err(`${at}: builds_on chain is deeper than 64`);
    });
  }

  // Findings. Everything here is checkable from the file alone: the signature, the fid,
  // the canonical body, and the one-live-record-per (kind, key) rule that caps how many
  // of these a problem can ever hold.
  //
  // STANDING IS NOT RE-DERIVED HERE, on purpose. It is a fact about the moment the write
  // happened, and re-deriving it offline would repeat the mistake invariant 13 already
  // paid for: a key's only solution can be superseded by that key's own later correction,
  // and this pass runs BEFORE every commit (invariant 2), so a finding that went stale
  // would not merely redden --check - it would 422 an unrelated write and freeze the file.
  const notes = Array.isArray(p.findings) ? p.findings : [];
  if (p.findings !== undefined && !Array.isArray(p.findings)) err("findings: an array or absent");
  const seenFid = new Set();
  const liveBy = new Map();
  notes.forEach((n, i) => {
    const at = `findings[${i}]`;
    if (!KINDS.includes(n.kind)) err(`${at}: kind is not one of ${KINDS.join(", ")}`);
    sameField(canonText, n.body, `${at}.body`, MAXLEN.body, err);
    if (seenFid.has(n.fid)) err(`${at}: two records share the fid ${n.fid}`);
    seenFid.add(n.fid);
    if (!canonicalKey(n.key)) err(`${at}: key is not in canonical base64 form`);
    else {
      if (fingerprint(n.key) !== n.author) err(`${at}: author does not match the key fingerprint`);
      // One live record per (kind, key): the server replaces in place, so a second one
      // here means the file was edited by hand into a state the write path cannot reach.
      const slot = `${n.kind}|${keyId(n.key)}`;
      if (liveBy.has(slot)) err(`${at}: this key already has a ${n.kind} finding on this problem (${liveBy.get(slot)}); a correction REPLACES, it does not append`);
      else liveBy.set(slot, at);
      try {
        if (findingId(p.id, n.kind, n.key, n.body, n.replaces) !== n.fid) err(`${at}: fid does not match the content of the entry`);
      } catch (e) {
        err(`${at}: cannot compute the fid (${e.message})`);
      }
    }
    if (n.replaces !== undefined && n.replaces !== "-" && n.replaces === n.fid) err(`${at}: this record replaces itself`);
    let nmsg = null;
    try {
      nmsg = payload("finding", { problem: p.id, kind: n.kind, body: n.body, replaces: n.replaces });
    } catch (e) {
      err(`${at}: ${e.message}`);
    }
    sigOk(n.key, n.sig, nmsg, err, at);
  });

  p.solutions.forEach((s, i) => {
    const at = `solutions[${i}]`;
    sameField(canonUrl, s.repo, `${at}.repo`, MAXLEN.repo, err);
    if (s.model !== undefined) sameField(canonLine, s.model, `${at}.model`, MAXLEN.model, err);
    if (s.note !== undefined) sameField(canonText, s.note, `${at}.note`, MAXLEN.note, err);

    if (!canonicalKey(s.key)) err(`${at}: key is not in canonical base64 form`);
    else {
      if (fingerprint(s.key) !== s.author) err(`${at}: author does not match the key fingerprint`);
      try {
        if (solutionId(p.id, s.repo, s.score, s.key, s.replaces, s.ref) !== s.sid) err(`${at}: sid does not match the content of the entry`);
      } catch (e) {
        err(`${at}: cannot compute the sid (${e.message})`);
      }
    }
    let smsg = null;
    try {
      smsg = payload("solution", { problem: p.id, repo: s.repo, score: s.score, model: s.model, note: s.note, replaces: s.replaces, builds_on: s.builds_on, ref: s.ref });
    } catch (e) {
      err(`${at}: ${e.message}`);
    }
    sigOk(s.key, s.sig, smsg, err, at);

    s.verifications.forEach((v, j) => {
      const vat = `${at}.verifications[${j}]`;
      if (v.note !== undefined) sameField(canonText, v.note, `${vat}.note`, MAXLEN.note, err);
      if (!canonicalKey(v.key)) err(`${vat}: key is not in canonical base64 form`);
      else {
        if (fingerprint(v.key) !== v.verifier) err(`${vat}: verifier does not match the key fingerprint`);
        try {
          if (verificationId(s.sid, v.key, v.output_sha256, v.verdict, v.score, v.replaces) !== v.vid) err(`${vat}: vid does not match the content of the entry`);
        } catch (e) {
          err(`${vat}: cannot compute the vid (${e.message})`);
        }
      }
      let vmsg = null;
      try {
        // tolerance comes from the problem, never from the record: that is what makes
        // a later change of the band break this signature instead of going unnoticed.
        vmsg = payload("verification", {
          problem: p.id, solution: s.sid, score: v.score, verdict: v.verdict,
          output_sha256: v.output_sha256, tolerance: p.acceptance.tolerance, note: v.note, replaces: v.replaces,
        });
      } catch (e) {
        err(`${vat}: ${e.message}`);
      }
      sigOk(v.key, v.sig, vmsg, err, vat);

      // invariant 3 and the tolerance band: the same function the server uses
      const verdict = checkVerification(p, s, v);
      if (verdict) err(`${vat}: ${verdict.error}`);

      // we derive the path BEFORE touching the disk, never from the evidence field
      let want = null;
      try {
        want = evidencePath(p.id, v.output_sha256);
      } catch (e) {
        err(`${vat}: ${e.message}`);
      }
      if (want !== null) {
        if (v.evidence !== want) err(`${vat}: evidence must point at ${want}`);
        let blob = null;
        try {
          blob = readFileSync(want);
        } catch {
          err(`${vat}: the evidence file ${want} is missing. A flag with no evidence is not a flag`);
        }
        if (blob !== null && sha(blob) !== v.output_sha256)
          err(`${vat}: the sha256 of the evidence file does not match output_sha256 (in a fresh clone this means git rewrote the bytes, check .gitattributes and core.autocrlf)`);
        // The evidence must be the same IN GIT, not only on the writer's disk.
        const oid = committed.get(want);
        if (blob !== null && oid !== undefined && oid !== gitOid(blob))
          err(`${vat}: the committed evidence has different bytes than the file in the working tree. git converts line endings, so a clone will not reproduce the sum (problems/evidence/** -text in .gitattributes)`);
      }
    });
  });
}

// --- 5b. the docket ---
// The docket is validated here for the same reason everything else is: the server runs
// build.mjs before every commit (invariant 2), so a row that cannot be recomputed offline
// never reaches git. What is deliberately NOT computed here is the row's STATUS. That is a
// fold over git history (docketShipped in sign.mjs), it is stored in no record, and if it
// were derived into a file then shipping a row would mean committing the fix and then
// committing a rebuild that says so - two commits, the second of which nobody can check
// against anything. A status that lives only in the log cannot be stale.

const docketRows = (() => {
  let raw;
  try {
    raw = readFileSync(DOCKET, "utf8");
  } catch {
    return []; // absent is legal: a registry that nobody has complained about yet
  }
  let o;
  try {
    o = JSON.parse(raw);
  } catch (e) {
    errors.push(`${DOCKET}: not valid JSON (${e.message})`);
    return [];
  }
  if (o === null || typeof o !== "object" || Array.isArray(o) || !Array.isArray(o.docket)) {
    errors.push(`${DOCKET}: expected {"docket": [...]}`);
    return [];
  }
  return o.docket;
})();

{
  const err = (m) => errors.push(`${DOCKET}: ${m}`);
  const seen = new Set();
  const groups = new Map();

  for (const r of docketRows) {
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      err("a row is not an object");
      continue;
    }
    const at = r.rid ?? "?";
    const e = (m) => err(`${at}: ${m}`);
    if (!/^[0-9a-f]{16}$/.test(r.rid ?? "")) { e("rid is not 16 hex"); continue; }
    if (seen.has(r.rid)) { e("duplicate rid"); continue; }
    seen.add(r.rid);
    if (!AREAS.includes(r.area)) { e(`area: one of ${AREAS.join(", ")}`); continue; }
    if (typeof r.key !== "string" || typeof r.sig !== "string") { e("key and sig must be strings"); continue; }
    if (!canonicalKey(r.key)) { e("the key is not in canonical base64 form"); continue; }
    if (fingerprint(r.key) !== r.author) { e("author does not match the key fingerprint"); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.at ?? "")) { e("at is not a YYYY-MM-DD date"); continue; }
    if (r.replaces !== "-" && !/^[0-9a-f]{16}$/.test(r.replaces ?? "")) { e('replaces is "-" or a rid'); continue; }
    sameField(canonText, r.body, "body", MAXLEN.body, e);

    // rid is recomputed, never trusted: it is the chain link, and a row whose stored id
    // does not follow from its own content could name a predecessor it never had.
    let want = null;
    try {
      want = docketId(r.area, r.key, r.body, r.replaces);
    } catch (x) {
      e(`rid: ${x.message}`);
    }
    if (want !== null && want !== r.rid) e(`rid does not match the content, expected ${want}`);

    let msg = null;
    try {
      msg = payload("docket", { area: r.area, body: r.body, replaces: r.replaces });
    } catch (x) {
      e(`payload: ${x.message}`);
    }
    sigOk(r.key, r.sig, msg, e, "docket");

    let id;
    try { id = keyId(r.key); } catch { continue; }
    const g = `${r.area}\u0000${id}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }

  // The chain, per (area, key). Same shape as the verdict chain and enforced for the same
  // reason (invariant 8): which row is LIVE must not depend on the order of lines in a
  // file, because order is the one thing a pull request can change without touching a
  // signature. One root, one head, no forks, no cycles.
  for (const [g, rows] of groups) {
    const [area] = g.split("\u0000");
    const e = (m) => err(`${area} chain: ${m}`);
    const byRid = new Map(rows.map((r) => [r.rid, r]));
    const roots = rows.filter((r) => r.replaces === "-");
    if (roots.length !== 1) e(`expected exactly one row with replaces "-", found ${roots.length}`);
    const targets = new Map();
    for (const r of rows) {
      if (r.replaces === "-") continue;
      if (!byRid.has(r.replaces)) e(`${r.rid} replaces ${r.replaces}, which is not this key's row in this area`);
      if (targets.has(r.replaces)) e(`${r.replaces} is replaced twice (${targets.get(r.replaces)} and ${r.rid})`);
      targets.set(r.replaces, r.rid);
    }
    const heads = rows.filter((r) => !targets.has(r.rid));
    if (heads.length !== 1) e(`expected exactly one head, found ${heads.length}`);
    // Walk it. A cycle would otherwise pass every check above and make the live row
    // undecidable - the same class of fault the verdict chain closes with a step cap.
    if (heads.length === 1 && roots.length === 1) {
      let cur = heads[0];
      let n = 0;
      while (cur && n <= rows.length) {
        n++;
        if (cur.replaces === "-") break;
        cur = byRid.get(cur.replaces);
      }
      if (n !== rows.length) e(`the chain covers ${n} of ${rows.length} rows: it is broken or has a cycle`);
    }
  }
}

// --- 6. write ---

const ordered = (o, keys) => {
  const r = {};
  for (const k of keys) if (k in o) r[k] = o[k];
  for (const k of Object.keys(o)) if (!(k in r)) r[k] = o[k];
  return r;
};

const shape = (p) => {
  const out = ordered(p, ["id", "title", "status", "domain", "needs", "problem", "subject", "acceptance", "frontier", "opened_by", "opened_at", "key", "sig", "solutions", "findings"]);
  out.acceptance = ordered(p.acceptance, ["how", "metric", "baseline", "higher_is_better", "tolerance"]);
  out.solutions = p.solutions.map((s) => {
    const sol = ordered(s, ["sid", "repo", "author", "key", "sig", "model", "score", "note", "replaces", "builds_on", "ref", "at", "verified", "disputed", "settled", "verified_by", "verifications"]);
    sol.verifications = s.verifications.map((v) => ordered(v, ["vid", "verifier", "key", "sig", "score", "verdict", "output_sha256", "note", "replaces", "evidence", "at"]));
    return sol;
  });
  // findings LAST in the file, after solutions, because that is their standing in this
  // registry: a report is what you read once the measurements have run out.
  if (Array.isArray(p.findings) && p.findings.length)
    out.findings = p.findings.map((n) => ordered(n, ["fid", "author", "key", "sig", "kind", "body", "replaces", "at"]));
  else delete out.findings;
  return out;
};

if (errors.length) {
  console.error("FAILED:\n" + errors.map((e) => "  - " + e).join("\n"));
  process.exit(1);
}

const shaped = loaded.map(({ path, text, p }) => {
  const out = shape(p);
  return { path, text, p, out, next: JSON.stringify(out, null, 2) + "\n" };
});

const badge = { open: "open", "in-progress": "in progress", solved: "SOLVED", dead: "dead" };

// A thousand rows is not a table, it is a wall. The README carries the shape of the
// registry (how much of what, and where the work is) plus the head of the listing;
// the whole thing lives behind GET /api/problems, which can be filtered.
const ROWS = 60;
const listed = shaped.map(({ p }) => p).sort(probCmp);

const counts = {};
for (const p of listed) {
  const d = counts[p.domain] ?? (counts[p.domain] = { open: 0, "in-progress": 0, solved: 0, dead: 0 });
  if (p.status in d) d[p.status]++;
}
const drawers = DOMAINS.filter((d) => counts[d]).map(
  (d) => `| ${d} | ${counts[d].open} | ${counts[d]["in-progress"]} | ${counts[d].solved} | ${counts[d].dead} |`
);

const rows = listed.slice(0, ROWS).map((p) => {
  const sols = [...p.solutions].sort(solCmp(p));
  const good = sols.filter((s) => s.verified && !s.disputed);
  const sporne = sols.filter((s) => s.disputed).length;
  const link = good.length
    ? `[${good.length} verified](${mdUrl(good[0].repo)})`
    : sols.length
      ? `${sols.length} submitted, 0 verified`
      : "—";
  const needs = (Array.isArray(p.needs) ? p.needs : []).join(", ") || "—";
  // "solved" on its own reads like a closed door. A problem with a frontier is a floor:
  // somebody hit a number and it is there to be beaten. The number comes from a derived
  // field, never from user content, so it needs no cell() - but it goes through one
  // anyway, because the day somebody makes it a string is the day that reasoning rots.
  // How many distinct keys ran that number. "best 72.4" reads the same whether one stranger
  // reproduced it or four did, and this table is the surface every passer-by reads first.
  // Counted from the verdict heads (invariant 8), never from the length of the array.
  const front = p.frontier && p.frontier.best ? sols.find((s) => s.sid === p.frontier.best) : null;
  const keys = front ? verdictStrength(front.verifications).confirms : 0;
  const state = p.frontier && p.frontier.best_score !== null && p.frontier.best_score !== undefined
    ? `${badge[p.status]} best ${cell(String(p.frontier.best_score))}, beat it, confirmed by ${keys} ${keys === 1 ? "key" : "keys"}${p.frontier.caveat ? ", verdict has conditions" : ""}`
    : badge[p.status];
  return `| ${p.id} | ${cell(p.title)} | ${cell(p.domain)} | ${cell(needs)} | ${state} | ${link}${sporne ? ` (${sporne} disputed)` : ""} |`;
});

const table = [
  `_${shaped.length} problems, ${shaped.filter(({ p }) => p.status === "solved").length} solved. Generated by scripts/build.mjs, do not edit by hand._`,
  "",
  ...(drawers.length ? ["| domain | open | in progress | solved | dead |", "|---|---|---|---|---|", ...drawers, ""] : []),
  "| # | Problem | Domain | Needs | Status | Solutions |",
  "|---|---|---|---|---|---|",
  ...rows,
  // Never a silent cut: a truncated list that looks complete is a lie about the state.
  ...(listed.length > ROWS
    ? ["", `_Showing ${ROWS} of ${listed.length}, open problems first. The rest: \`GET /api/problems?offset=${ROWS}\`, filterable by \`?status=\`, \`?domain=\` and \`?have=\`._`]
    : []),
].join("\n");

// The generated region is cut at the markers, so a marker IN THE CONTENT
// blows the boundary apart: one signed POST with a title containing END put
// it into a table row, the next run cut README at it and --check stopped
// converging FOR GOOD (writes for the whole registry down to 503). The first defence is
// cell() with entities, the second one is here: there must be exactly one of each marker,
// and the table has no right to contain them. Every break of this is a loud error,
// never a silent drift.
const count = (s, needle) => s.split(needle).length - 1;

if (table.includes(START) || table.includes(END)) {
  console.error(`${README}: the generated table contains a region marker, which means cell() let user content through and the region will drift`);
  process.exit(1);
}

let readme;
try {
  readme = readFileSync(README, "utf8");
} catch {
  console.error(`${README}: the file is missing, and this is where build.mjs rewrites the table`);
  process.exit(1);
}
const a = readme.indexOf(START);
const b = readme.indexOf(END);
if (a === -1 || b === -1 || b < a) {
  console.error(`${README}: the markers ${START} / ${END} are missing or in the wrong order`);
  process.exit(1);
}
if (count(readme, START) !== 1 || count(readme, END) !== 1) {
  console.error(
    `${README}: a region marker occurs more than once (${count(readme, START)}x START, ${count(readme, END)}x END). ` +
      `The generated region must be bounded by exactly one pair. Remove the extra markers from ${README} and run again.`
  );
  process.exit(1);
}
const nextReadme = readme.slice(0, a + START.length) + "\n" + table + "\n" + readme.slice(b);

// Read API: one file, served by raw.githubusercontent.com. No server.
const nextIndex =
  JSON.stringify(
    {
      generated_at: new Date().toISOString().slice(0, 10),
      counts: {
        total: shaped.length,
        open: shaped.filter(({ p }) => p.status === "open").length,
        solved: shaped.filter(({ p }) => p.status === "solved").length,
      },
      // `file` goes into the INDEX copy only, never into the problem file itself: a record
      // that names its own filename is a second place for the name to be wrong. The server
      // needs it to build a browse URL without a readdir per problem on a read path.
      problems: shaped.map(({ out, path }) => ({ ...out, file: path })),
      // Mirrored verbatim from docket.json so that one file is still the whole read API.
      // No status here on purpose: it is a fold over git log, so a mirror carries the
      // rows and recomputes the rest, exactly as it already does for /keys and /gap.
      docket: docketRows,
    },
    null,
    2
  ) + "\n";

const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

// The temp file name must be unique per process. A shared ".tmp" means
// the second writer swaps it out from under the first and rename ends in ENOENT,
// measured with several instances over one directory.
const writeAtomic = (path, text) => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
};

if (CHECK) {
  // generated_at changes every day, so we compare the content only
  const strip = (s) => s.replace(/"generated_at": "[^"]*",?\n/, "");
  const stale = [
    ...shaped.filter(({ text, next }) => text !== next).map(({ path }) => path),
    ...(strip(read(INDEX)) !== strip(nextIndex) ? [INDEX] : []),
    ...(nextReadme !== readme ? [README] : []),
  ];
  if (stale.length) {
    console.error(`stale: ${stale.join(", ")}. Run \`node scripts/build.mjs\` and add the result to the commit.`);
    process.exit(1);
  }
  console.log(`OK: ${shaped.length} problems, README up to date.`);
} else {
  for (const { path, text, next } of shaped) if (text !== next) writeAtomic(path, next);
  if (nextReadme !== readme) writeAtomic(README, nextReadme);
  if (read(INDEX) !== nextIndex) writeAtomic(INDEX, nextIndex);
  console.log(`OK: ${shaped.length} problems, README + index.json rewritten.`);
}
