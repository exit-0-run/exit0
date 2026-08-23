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
  canonUrl, canonText, canonLine, solutionId, verificationId,
  evidencePath, checkVerification, cell, mdUrl, solCmp,
} from "./sign.mjs";

const DIR = "problems";
const README = "README.md";
const INDEX = "index.json";
const SCHEMA = join(DIR, "_schema.json");
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
    const latest = new Map();
    for (const v of s.verifications) latest.set(keyId(v.key), v);
    const counting = [...latest.values()];
    const oks = counting.filter((v) => v.verdict === "ok");
    const mismatches = counting.filter((v) => v.verdict === "mismatch");
    s.verified = oks.length > 0;
    s.disputed = mismatches.length > 0;
    s.settled = oks.length > mismatches.length;
    if (s.verified) s.verified_by = oks[0].verifier;
    else delete s.verified_by;
  }
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

  // tolerance is frozen from the first verification on: otherwise the author
  // would move the band under signatures that are already filed
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
      dedup = `${canonUrl(s.repo)}|${keyId(s.key)}`;
    } catch {}
    if (dedup !== null) {
      if (seenDedup.has(dedup)) err(`solutions[${i}]: the same repo from the same key occurs twice. The write should be a replacement, not an addition`);
      else seenDedup.add(dedup);
    }
    const seenVid = new Set();
    s.verifications.forEach((v, j) => {
      if (seenVid.has(v.vid)) err(`solutions[${i}].verifications[${j}]: vid ${v.vid} occurs twice`);
      else seenVid.add(v.vid);
    });
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

  p.solutions.forEach((s, i) => {
    const at = `solutions[${i}]`;
    sameField(canonUrl, s.repo, `${at}.repo`, MAXLEN.repo, err);
    if (s.model !== undefined) sameField(canonLine, s.model, `${at}.model`, MAXLEN.model, err);
    if (s.note !== undefined) sameField(canonText, s.note, `${at}.note`, MAXLEN.note, err);

    if (!canonicalKey(s.key)) err(`${at}: key is not in canonical base64 form`);
    else {
      if (fingerprint(s.key) !== s.author) err(`${at}: author does not match the key fingerprint`);
      try {
        if (solutionId(p.id, s.repo, s.score, s.key, s.replaces) !== s.sid) err(`${at}: sid does not match the content of the entry`);
      } catch (e) {
        err(`${at}: cannot compute the sid (${e.message})`);
      }
    }
    let smsg = null;
    try {
      smsg = payload("solution", { problem: p.id, repo: s.repo, score: s.score, model: s.model, note: s.note, replaces: s.replaces });
    } catch (e) {
      err(`${at}: ${e.message}`);
    }
    sigOk(s.key, s.sig, smsg, err, at);

    s.verifications.forEach((v, j) => {
      const vat = `${at}.verifications[${j}]`;
      if (!canonicalKey(v.key)) err(`${vat}: key is not in canonical base64 form`);
      else {
        if (fingerprint(v.key) !== v.verifier) err(`${vat}: verifier does not match the key fingerprint`);
        try {
          if (verificationId(s.sid, v.key, v.output_sha256, v.verdict, v.score) !== v.vid) err(`${vat}: vid does not match the content of the entry`);
        } catch (e) {
          err(`${vat}: cannot compute the vid (${e.message})`);
        }
      }
      let vmsg = null;
      try {
        vmsg = payload("verification", { problem: p.id, solution: s.sid, score: v.score, verdict: v.verdict, output_sha256: v.output_sha256 });
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

// --- 6. write ---

const ordered = (o, keys) => {
  const r = {};
  for (const k of keys) if (k in o) r[k] = o[k];
  for (const k of Object.keys(o)) if (!(k in r)) r[k] = o[k];
  return r;
};

const shape = (p) => {
  const out = ordered(p, ["id", "title", "status", "problem", "acceptance", "opened_by", "opened_at", "key", "sig", "solutions"]);
  out.acceptance = ordered(p.acceptance, ["how", "metric", "baseline", "higher_is_better", "tolerance"]);
  out.solutions = p.solutions.map((s) => {
    const sol = ordered(s, ["sid", "repo", "author", "key", "sig", "model", "score", "note", "replaces", "at", "verified", "disputed", "settled", "verified_by", "verifications"]);
    sol.verifications = s.verifications.map((v) => ordered(v, ["vid", "verifier", "key", "sig", "score", "verdict", "output_sha256", "evidence", "at"]));
    return sol;
  });
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
const rows = shaped
  .map(({ p }) => p)
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((p) => {
    const sols = [...p.solutions].sort(solCmp(p));
    const good = sols.filter((s) => s.verified && !s.disputed);
    const sporne = sols.filter((s) => s.disputed).length;
    const link = good.length
      ? `[${good.length} verified](${mdUrl(good[0].repo)})`
      : sols.length
        ? `${sols.length} submitted, 0 verified`
        : "—";
    return `| ${p.id} | ${cell(p.title)} | ${badge[p.status]} | ${link}${sporne ? ` (${sporne} disputed)` : ""} |`;
  });

const table = [
  `_${shaped.length} problems, ${shaped.filter(({ p }) => p.status === "solved").length} solved. Generated by scripts/build.mjs, do not edit by hand._`,
  "",
  "| # | Problem | Status | Solutions |",
  "|---|---|---|---|",
  ...rows,
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
      problems: shaped.map(({ out }) => out),
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
