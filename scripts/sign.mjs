#!/usr/bin/env node
// Identity, the signature contract and the canonical form. One module, because a rule
// implemented twice always drifts apart: server.mjs and build.mjs
// IMPORT from here, they never reimplement it.
//
//   node scripts/sign.mjs keygen [file.pem] [--force]
//   node scripts/sign.mjs whoami [file.pem]
//   node scripts/sign.mjs sign <key.pem> <action> <json|@file|->

import { generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey, createHash } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The signature contract. A change here invalidates EVERY existing signature.
export const PREFIX = "exit0/v2";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const bytes = (s) => Buffer.byteLength(s, "utf8");

// Budgets are in utf-8 BYTES, not characters.
export const MAXLEN = { title: 120, problem: 4000, how: 2000, metric: 200, model: 80, note: 280, repo: 300, ref: 80, body: 400, output: 32768 };

export const bad = (code, msg, extra) => {
  const e = new Error(msg);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
};

// The public key in CANONICAL FORM. base64 is ambiguous: four different
// strings decode to the same 32 bytes, so comparing strings lets
// self-verification through. Compare keyId ONLY.
export const keyId = (b64) => {
  if (typeof b64 !== "string") throw bad(400, "key must be a string");
  const r = Buffer.from(b64, "base64");
  if (r.length !== 32) throw bad(400, "an Ed25519 public key is 32 bytes in base64");
  return r.toString("base64");
};

export const fp32 = (b64) => sha(Buffer.from(keyId(b64), "base64"));
export const fingerprint = (b64) => fp32(b64).slice(0, 12);

// Number token: "%.9f" with trailing zeros stripped. The same rule in every language.
export const numToken = (n) => {
  if (typeof n !== "number" || !Number.isFinite(n)) throw bad(400, "must be a JSON number (not a string, not null)");
  const x = n + 0;
  if (Math.abs(x) >= 1e15) throw bad(400, "number too large: |value| < 1e15");
  let t = x.toFixed(9);
  if (t.includes(".")) t = t.replace(/0+$/, "").replace(/\.$/, "");
  if (Number(t) !== x) throw bad(400, "number: max 9 decimal places");
  if (t.replace(/[-.]/g, "").replace(/^0+/, "").length > 15) throw bad(400, "number: max 15 significant digits");
  return t;
};

// Two fields carry a URL now - a solution's repo and a problem's subject - and they get
// ONE rule, not two that drift. The label is a parameter only so the refusal names the
// field the caller actually sent; assertCanon already passes it through.
export const canonUrl = (raw, label = "repo", max = MAXLEN.repo) => {
  if (typeof raw !== "string") throw bad(400, `${label} must be a string`);
  if (bytes(raw) > max) throw bad(400, `${label}: max ${max} bytes`);
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw bad(400, `${label} is not a URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw bad(400, `${label} must be http(s)`);
  if (!u.hostname) throw bad(400, `${label} has no host`);
  u.hash = "";
  u.username = "";
  u.password = "";
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "");
  let s = u.toString();
  if (s.endsWith("?")) s = s.slice(0, -1);
  return s;
};

// C0 controls, DEL, line separators and BiDi controls. Tab and LF are
// outside the set on purpose: the regexes below normalize them. The set is built from
// escapes inside a string, because a non-printing literal makes this file binary.
const CTRL = new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F\\u200E\\u200F\\u202A-\\u202E\\u2028\\u2029\\u2066-\\u2069]", "g");
const NUL = String.fromCharCode(0);

export const canonText = (raw, label, max) => {
  if (typeof raw !== "string") throw bad(400, `${label} must be a string`);
  const s = raw
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(CTRL, "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (bytes(s) > max) throw bad(400, `${label}: max ${max} bytes, has ${bytes(s)}`);
  return s;
};

export const canonLine = (raw, label, max) => {
  const s = canonText(raw, label, Infinity).replace(/\n/g, " ").replace(/ +/g, " ").trim();
  if (bytes(s) > max) throw bad(400, `${label}: max ${max} bytes, has ${bytes(s)}`);
  return s;
};

// The server NEVER fixes anything silently. Either the canonical form, or a 400 with a hint.
export const assertCanon = (fn, v, label, max) => {
  const c = fn(v, label, max);
  if (c !== v) throw bad(400, `${label}: send the canonical form`, { canonical: c });
  return v;
};

// The raw verification output is NOT canonicalized: it is evidence, not prose.
// We store it byte for byte and sign its sha256.
export const evidenceBytes = (raw) => {
  if (typeof raw !== "string") throw bad(400, "output must be a string");
  if (!raw.trim()) throw bad(400, "raw output is required");
  if (raw.indexOf(NUL) !== -1) throw bad(400, "output must not contain a zero byte");
  const b = Buffer.from(raw, "utf8");
  if (b.length > MAXLEN.output) throw bad(400, `output: max ${MAXLEN.output} bytes, has ${b.length}. Link to it instead of pasting it`);
  return b;
};

export const pubToB64 = (keyObject) =>
  keyObject.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");

export const b64ToPub = (b64) => {
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(keyId(b64), "base64")]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
};

export const check = (keyB64, sigB64, msg) => {
  try {
    return verify(null, Buffer.from(msg, "utf8"), b64ToPub(keyB64), Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
};

// --- signature contract ---
// Every variable-length field is framed as <utf8len>:<value>,
// every other one is a token from a grammar that cannot contain "|".
// Injectivity is therefore structural, and the payload stays readable inside a 403.

const F = (s) => `${bytes(s)}:${s}`;

const pid = (v) => {
  if (typeof v !== "string" || !/^\d{4}$/.test(v)) throw bad(400, 'problem: 4 digits, e.g. "0001"');
  return v;
};
const hex16 = (v, l) => {
  if (typeof v !== "string" || !/^[0-9a-f]{16}$/.test(v)) throw bad(400, `${l}: 16 hex characters`);
  return v;
};
const hex64 = (v, l) => {
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) throw bad(400, `${l}: 64 hex characters`);
  return v;
};
const verdictT = (v) => {
  if (v !== "ok" && v !== "mismatch") throw bad(400, 'verdict must be "ok" or "mismatch"');
  return v;
};
const boolT = (v, l) => {
  if (v === undefined || v === null) return "0";
  if (typeof v !== "boolean") throw bad(400, `${l} must be true/false`);
  return v ? "1" : "0";
};
const optNum = (v) => (v === undefined || v === null ? "-" : numToken(v));
// Absent is "-", present is length-prefixed like every other string, so the two can never
// be read as each other: a present value always carries its "N:" and "-" is not a URL.
// An attempt can live as a ref inside a repository instead of as a repository of its own.
// The shape is fixed and checked, not just carried: the fingerprint segment is what makes
// "you can only claim a ref under your own key" checkable at all, and a free-form string
// would make the whole namespace a place to write anything.
export const REF_RE = /^refs\/attempts\/[0-9]{4}\/[0-9a-f]{12}\/[a-z0-9][a-z0-9._-]{0,39}$/;
// One rule, two shapes: the body carries the plain string and the payload carries it
// framed. Two separate checks would drift, and the one that drifts is the one nobody runs.
export const canonRef = (v) => {
  if (v === undefined || v === null || v === "" || v === "-") return "-";
  if (typeof v !== "string") throw bad(400, "ref must be a string");
  if (bytes(v) > MAXLEN.ref) throw bad(400, `ref: max ${MAXLEN.ref} bytes`);
  if (!REF_RE.test(v)) throw bad(400, "ref: refs/attempts/<4 digits>/<12 hex>/<slug>, or - when the repo is a repo of its own");
  return v;
};
const refT = (v) => {
  const c = canonRef(v);
  return c === "-" ? "-" : F(c);
};

const optUrl = (v, label) => (v === undefined || v === null || v === "" ? "-" : F(assertCanon(canonUrl, v, label, MAXLEN.repo)));
// The state this submission replaces: "-" when nothing sits under (problem, repo, key)
// yet, or the sid of the entry that sat there at signing time. Without this
// token a signed body stays valid forever: anyone who saw it, and the whole
// registry sees it, because key and sig are in git, can roll the author back to
// an older score, wipe the verifications and spend the author's quota on the way.
export const replacesT = (v, label = "replaces") => (v === undefined || v === null || v === "-" ? "-" : hex16(v, label));
const tolT = (v) => {
  const t = v ?? 0.02;
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > 0.5)
    throw bad(400, "tolerance: a number in [0, 0.5]");
  return numToken(t);
};

// --- the two drawers ---
// A registry with a thousand problems is unusable without a filter, and a filter is
// only worth anything if the values are closed. Free tags rot in one predictable way:
// "llm", "LLMs" and "language-model" become three drawers for one thing, and no
// filter ever sees all three. So both axes are CLOSED SETS, extended by pull request
// the same way the schema is. This is the one place they are declared; _schema.json
// and the documentation are checked against it by the test suite.
//
// DOMAIN answers "is this my area", one value per problem.
export const DOMAINS = ["routing", "compression", "memory", "retrieval", "agents", "eval", "cost", "infra", "security", "other"];
// NEEDS answers "can I even run this", which is the filter that actually saves an
// agent time. Empty means: node, git and a network connection, nothing else. It is
// about the COMMAND in `how`, not about the problem being interesting.
export const NEEDS = ["gpu", "api-key", "dataset", "docker", "browser"];

// KIND is the third closed drawer, and the only one that is not about a problem's
// content. It answers "what kind of thing is a stranger telling me here", and it is
// closed for a reason the other two do not have: the OPEN version of this field is a
// comment box, and a comment box is the feature this registry exists not to be. Every
// value here is a report about RUNNING something, so a finding is still a result and
// not an opinion:
//   deadend   I ran this approach, it does not reach the bar. Do not spend the compute.
//   ambiguous `how` does not pin a number down: two honest runs disagree and the
//             statement does not settle which is right.
//   blocked   `how` cannot be run at all any more: the corpus 404s, the pinned commit
//             is gone, the dependency was yanked. Problems rot and nothing else notices.
// "interesting", "agree", "+1" and "have you tried" are absent on purpose. If a value
// does not describe an attempt to run something, it does not belong in this drawer.
export const KINDS = ["deadend", "ambiguous", "blocked"];

const domainT = (v) => {
  if (typeof v !== "string" || !DOMAINS.includes(v)) throw bad(400, `domain: one of ${DOMAINS.join(", ")}`, { canonical: "other" });
  return v;
};

// No canonical suggestion here, unlike domain. domain has a defensible default
// ("other" is a real drawer); a finding whose kind we had to guess would be a
// statement the registry made up on the sender's behalf.
const kindT = (v) => {
  if (typeof v !== "string" || !KINDS.includes(v)) throw bad(400, `kind: one of ${KINDS.join(", ")}`);
  return v;
};

// Canonical form is sorted and deduplicated, in the order NEEDS declares. Sorting it
// for the sender would make two different bodies produce one signature, and then the
// stored bytes would not be the bytes that were signed.
export const canonNeeds = (v) => {
  const a = v ?? [];
  if (!Array.isArray(a) || a.some((x) => typeof x !== "string")) throw bad(400, "needs: an array of strings");
  const bad_ = a.filter((x) => !NEEDS.includes(x));
  if (bad_.length) throw bad(400, `needs: unknown value ${bad_.join(", ")}. Allowed: ${NEEDS.join(", ")}`);
  return NEEDS.filter((n) => a.includes(n));
};

const needsT = (v) => {
  const c = canonNeeds(v);
  const given = v ?? [];
  if (given.length !== c.length || given.some((x, i) => x !== c[i]))
    throw bad(400, "needs: send the canonical form (sorted, no repeats)", { canonical: c });
  return c.length ? c.join(",") : "-";
};

// The ONLY place where the flat body and the stored file meet.
export const problemFields = (x) => ({
  title: x.title,
  problem: x.problem,
  how: x.acceptance ? x.acceptance.how : x.how,
  metric: x.acceptance ? x.acceptance.metric : x.metric,
  higher_is_better: x.acceptance ? x.acceptance.higher_is_better : x.higher_is_better,
  baseline: x.acceptance ? x.acceptance.baseline : x.baseline,
  tolerance: (x.acceptance ? x.acceptance.tolerance : x.tolerance) ?? 0.02,
  domain: x.domain,
  needs: x.needs,
  subject: x.subject,
});

export const payload = (action, f) => {
  if (action === "solution")
    return [
      PREFIX,
      "solution",
      pid(f.problem),
      F(assertCanon(canonUrl, f.repo, "repo", MAXLEN.repo)),
      numToken(f.score),
      F(assertCanon(canonLine, f.model ?? "?", "model", MAXLEN.model)),
      F(assertCanon(canonText, f.note ?? "", "note", MAXLEN.note)),
      replacesT(f.replaces),
      // Where the CODE came from: another entry's sid, or "-" for from scratch. Same
      // grammar as replaces and a different meaning entirely. replaces is a state token
      // and decides what this entry supersedes; builds_on decides nothing at all, it only
      // records an origin. It is signed because an unsigned origin is a claim anyone with
      // commit access could rewrite, and lineage that can be rewritten is worse than none.
      // Deliberately NOT part of solutionId: identity stays a function of state, so two
      // bodies differing only in builds_on are one entry, and relabelling your own
      // ancestry after the fact is not something this registry offers.
      replacesT(f.builds_on, "builds_on"),
      // Where the code IS, when it is not a repository of its own: a ref inside one. The
      // pair (repo, ref) is the address, so both are signed and both are part of the
      // chain. Without this a submitter with nowhere to publish has to either turn away
      // or point at somebody else's host.
      refT(f.ref),
    ].join("|");
  // tolerance is signed by the VERIFIER, not only by the problem author. A verdict
  // is meaningless without the band it was judged under, and a problem opened by
  // pull request carries no signature at all, so the band under it was free to move
  // after the fact. Now moving it breaks every verdict already filed, in any clone,
  // with no git history needed.
  if (action === "verification")
    return [
      PREFIX,
      "verification",
      pid(f.problem),
      hex16(f.solution, "solution"),
      numToken(f.score),
      verdictT(f.verdict),
      hex64(f.output_sha256, "output_sha256"),
      tolT(f.tolerance),
      // The conditions the verdict was reached under, in the verdict itself. This is the
      // same argument that already puts `tolerance` in here one step further: a verdict is
      // meaningless without the band it was judged under, and on a problem whose `how`
      // admits two honest readings it is equally meaningless without WHICH READING. Two
      // independent verifiers walked 0014 and both reported the same structural hole: the
      // record that flips a problem to `solved` could not say what it was asserting, and
      // the escape hatch (file a finding) is a record that changes nothing and needs
      // standing the verifier earns from this very write. So the caveat could only ever
      // arrive after the status it qualifies.
      // Empty is normal and costs one byte. It is NOT part of the vid, exactly as a
      // solution's note is not part of the sid: identity stays a function of state.
      F(assertCanon(canonText, f.note ?? "", "note", MAXLEN.note)),
      replacesT(f.replaces),
    ].join("|");
  if (action === "problem")
    return [
      PREFIX,
      "problem",
      F(assertCanon(canonLine, f.title, "title", MAXLEN.title)),
      F(assertCanon(canonText, f.problem, "problem", MAXLEN.problem)),
      F(assertCanon(canonText, f.how, "how", MAXLEN.how)),
      F(assertCanon(canonLine, f.metric, "metric", MAXLEN.metric)),
      boolT(f.higher_is_better, "higher_is_better"),
      optNum(f.baseline),
      tolT(f.tolerance),
      domainT(f.domain),
      needsT(f.needs),
      // The repository the problem is ABOUT, when there is one. Signed like everything
      // else: an unsigned field inside a signed record is a channel for a claim nobody
      // checked, and this one points a stranger at code they are about to run.
      optUrl(f.subject, "subject"),
    ].join("|");
  // A finding is the ONLY write that carries prose as its point rather than as a label,
  // which is why it is the shortest payload here and why it has no score, no repo and no
  // ref. Those three were all drafted and all cut: a number nobody can run is a claim,
  // and this registry already has a place for a runnable claim with a number on it. It is
  // called a solution. Keeping the two from overlapping is what keeps either legible.
  // There is deliberately no parent field. A finding cannot answer another finding, so
  // there are no threads, no last word, and no depth to moderate.
  if (action === "finding")
    return [
      PREFIX,
      "finding",
      pid(f.problem),
      kindT(f.kind),
      F(assertCanon(canonText, f.body, "body", MAXLEN.body)),
      replacesT(f.replaces),
    ].join("|");
  throw bad(404, "unknown action");
};

// --- content-derived identifiers ---

// sid is a CHAIN, not a content address: each one carries the sid of the state it
// replaced. Without that link "a signed body lands exactly once" was true
// for exactly one step. A sid computed only from (problem, repo, score, key)
// returns to the same value when the author returns to an earlier score
// (0.42 -> 0.39 -> 0.42), and with it EVERY historical body whose
// replaces pointed at that state comes back to life, rolls the author back again, wipes
// other people's verifications and spends the author's quota. Measured: the state returned to sid_1 in three moves.
// With the link the state cannot repeat: a repeat would need a sha256 collision,
// because "-" occurs exactly once (a record never disappears) and every next
// link commits to the previous one.
// ref is in here, not only in the payload. Two attempts by one key can now share a repo
// URL and differ only by ref (that is the whole point of hosting them as refs), so leaving
// it out would give them one sid and collapse two independent chains into one.
export const solutionId = (problemId, repo, score, key, replaces, ref) =>
  sha(
    Buffer.from(
      [PREFIX, "sid", pid(problemId), F(canonUrl(repo)), numToken(score), keyId(key), replacesT(replaces), refT(ref)].join("|"),
      "utf8"
    )
  ).slice(0, 16);

// vid is a chain link too, for the same reason sid is: a verifier who goes
// ok -> mismatch -> ok would otherwise land back on the first vid, and with it the
// first signed body would describe the current state again and go in a second time.
// fid is a chain link for the same reason sid and vid are, and it carries the BODY,
// not only the kind: without the body a key that corrects the text of its own finding
// lands on the fid it already used, and the correction reads as a replay.
// The chain key is (problem, kind, key), which is also the volume cap and the reason
// this feature cannot turn into a comment section. One key holds at most one live
// finding per kind per problem, corrected in place, so the most a problem can ever
// accumulate is (distinct keys x KINDS.length) - and standing has to be earned before
// the first one of those. Rate limits cap how fast; this caps how many, which is the
// number that decides whether a page stays readable.
export const findingId = (problemId, kind, key, body, replaces) =>
  sha(
    Buffer.from(
      [PREFIX, "fid", pid(problemId), kindT(kind), keyId(key), F(assertCanon(canonText, body, "body", MAXLEN.body)), replacesT(replaces)].join("|"),
      "utf8"
    )
  ).slice(0, 16);

export const verificationId = (sid, key, outSha, verdict, score, replaces) =>
  sha(
    Buffer.from(
      [PREFIX, "vid", hex16(sid, "sid"), keyId(key), hex64(outSha, "output_sha256"), verdictT(verdict), numToken(score), replacesT(replaces)].join("|"),
      "utf8"
    )
  ).slice(0, 16);

// --- the verdict chain ---
// Which verdict of a given verifier counts is decided by the CHAIN, never by the
// order of records in the file. Order was authoritative before this: two records
// that were both correctly signed, swapped in a pull request, flipped a problem
// from in-progress to solved and build.mjs --check stayed green, because each
// record on its own was still valid. Now every record commits to the one it
// replaces, so the counting record is the one nothing points at, and a swap in the
// file changes nothing at all.
//
// Returns { heads, errors }: heads = one counting record per verifier key,
// ordered by (at, vid) so it does not depend on file order either. NEVER throws:
// it runs inside build.mjs, where an exception is a crash instead of an error list.
export const verdictHeads = (list) => {
  const errors = [];
  const groups = new Map();
  (Array.isArray(list) ? list : []).forEach((v, i) => {
    let k;
    try {
      k = keyId(v && v.key);
    } catch {
      errors.push({ at: i, error: "key outside the base64 grammar, this record has no verifier" });
      return;
    }
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ v, i });
  });

  const heads = [];
  for (const recs of groups.values()) {
    const byVid = new Map();
    for (const r of recs) if (!byVid.has(r.v.vid)) byVid.set(r.v.vid, r);
    const rep = (r) => r.v.replaces ?? "-";
    const roots = recs.filter((r) => rep(r) === "-");
    if (roots.length !== 1) {
      for (const r of (roots.length ? roots.slice(1) : recs))
        errors.push({ at: r.i, error: roots.length ? 'this verifier has more than one record with "replaces":"-" on this solution' : 'this verifier has no record with "replaces":"-", so their chain has no beginning' });
      continue;
    }
    const next = new Map();
    let broken = false;
    for (const r of recs) {
      if (rep(r) === "-") continue;
      if (!byVid.has(rep(r))) {
        errors.push({ at: r.i, error: `replaces points at ${rep(r)}, and this verifier has no such record on this solution` });
        broken = true;
      } else if (next.has(rep(r))) {
        errors.push({ at: r.i, error: `two records replace the same ${rep(r)}: a chain, not a fork` });
        broken = true;
      } else next.set(rep(r), r);
    }
    if (broken) continue;
    let cur = roots[0];
    const walked = new Set([cur]);
    while (next.has(cur.v.vid)) {
      cur = next.get(cur.v.vid);
      if (walked.has(cur)) break;
      walked.add(cur);
    }
    const lost = recs.filter((r) => !walked.has(r));
    if (lost.length) {
      for (const r of lost) errors.push({ at: r.i, error: "the chain of this verifier does not reach this record: it hangs off a loop instead of the root" });
      continue;
    }
    heads.push(cur.v);
  }
  heads.sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")) || String(a.vid ?? "").localeCompare(String(b.vid ?? "")));
  return { heads, errors };
};

// The head for ONE key: what the next record of this verifier has to replace.
// "-" means this verifier has not spoken on this solution yet.
export const verdictHead = (list, key) => {
  const k = keyId(key);
  const mine = (Array.isArray(list) ? list : []).filter((v) => {
    try {
      return keyId(v.key) === k;
    } catch {
      return false;
    }
  });
  if (!mine.length) return { head: "-", errors: [] };
  const { heads, errors } = verdictHeads(mine);
  return { head: errors.length || heads.length !== 1 ? null : heads[0].vid, errors };
};

export const evidencePath = (problemId, outSha) =>
  `problems/evidence/${pid(problemId)}-${hex64(outSha, "output_sha256")}.txt`;

// --- acceptance rule: invariant 3 plus tolerance ---
// Called from server.mjs AND from build.mjs. Returns null or {code, error}: the code
// goes to the client unmapped, the validator treats every non-null as an error.

// Fails CLOSED. keyId throws on a key outside the grammar, and this predicate must
// not throw: it runs inside build.mjs, where an exception is a crash instead of an
// error list. It used to fall back to comparing the strings, which was safe only as
// long as the server rejected a non-canonical key before getting here: the whole
// point of comparing keyId is that the same 32 bytes have four base64 spellings, so
// a string comparison lets a spelling variant verify its own solution. A key we
// cannot read is now a named 400, not a silent downgrade of invariant 3.
const keyOr400 = (k, label) => {
  try {
    keyId(k);
    return null;
  } catch (e) {
    return { code: 400, error: `${label}: ${e.message}` };
  }
};

// The band is a product of two floats, so 0.02 * 0.39 comes out as
// 0.0078000000000000005. The comparison below stays EXACT: we trim only the form
// shown in the message, and downwards, so we never promise a wider band than we enforce.
const bandText = (b) => {
  const t = (Math.floor(b * 1e9) / 1e9).toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
  return t === "-0" ? "0" : t;
};

export const checkVerification = (p, sol, v) => {
  const kv = keyOr400(v.key, "verification key") ?? keyOr400(sol.key, "solution key");
  if (kv) return kv;
  if (keyId(v.key) === keyId(sol.key)) return { code: 403, error: "you cannot verify your own solution" };
  if (v.verdict !== "ok" && v.verdict !== "mismatch") return { code: 400, error: 'verdict must be "ok" or "mismatch"' };
  if (typeof v.score !== "number" || !Number.isFinite(v.score)) return { code: 400, error: "the verification score must be a number" };
  if (typeof sol.score !== "number" || !Number.isFinite(sol.score)) return { code: 400, error: "the solution score must be a number" };
  const tol = p.acceptance.tolerance ?? 0.02;
  const band = tol * Math.abs(sol.score);
  const diff = Math.abs(v.score - sol.score);
  if (v.verdict === "ok" && diff > band)
    return { code: 422, error: `verdict "ok" requires a score within the band +/-${bandText(band)} of ${sol.score}; you have ${v.score}. Send verdict "mismatch"` };
  if (v.verdict === "mismatch" && diff <= band)
    return { code: 422, error: `verdict "mismatch" requires a score OUTSIDE the band +/-${bandText(band)} of ${sol.score}; you have ${v.score}. That is a match, send verdict "ok"` };
  return null;
};

// --- rendering, shared by the server and build.mjs ---

// A continuation line of a multi-line field gets a marker that canonicalization
// will NOT produce: after canonText no content line starts with a space,
// so "<indent>| " is unreachable for foreign text. Indentation alone was not
// enough: the record lines ("metric:", "solutions:") stand in the same
// column as a continuation, so a multi-line `how` impersonated them.
const CONT = "| ";
export const fieldBlock = (label, value, indent = 6) =>
  value.split("\n").map((l, i) => " ".repeat(indent) + (i ? CONT : label + ": ") + l).join("\n");

// A README table cell. "\|" alone is not enough, for two reasons, both
// measured on a running server:
//   1. a title carrying "<!-- INDEX:END -->" lands INSIDE the generated region,
//      so build.mjs cuts README at a FOREIGN marker and stops converging:
//      one signed POST disabled writes for the whole registry permanently,
//   2. "[click](https://phish)" renders on GitHub as a real link
//      inside a table that the whole project presents as verified.
// So: "<", ">" and "&" become entities (that kills the marker), the rest of the
// Markdown punctuation gets a backslash. Order matters: the entities go
// first, otherwise the backslash would land in the middle of "&amp;".
const ENT = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
export const cell = (s) =>
  String(s)
    .replace(/[&<>]/g, (c) => ENT[c])
    .replace(/[\\`*_[\]()~|!]/g, "\\$&")
    .replace(/\r?\n/g, " ");

// The link target. A closing parenthesis survives canonUrl (checked:
// "https://example.com/a)x" comes out unchanged), and in the [text](target) form
// it ends the link too early, so the rest of the URL becomes page text.
// The <target> form has no such problem; only "<", ">" and whitespace break it, and
// canonUrl already percent-encodes those, so the below is a safety net, not
// an address rewrite.
export const mdUrl = (s) =>
  `<${String(s).replace(/[<>\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)}>`;

// The order of the listing, shared by the server and by the README generator: a rule
// written twice drifts apart. Open problems first, and inside a status the ones nobody
// has touched, because that is where a newcomer is worth most. Deterministic down to
// the last element, or a listing could not be paged.
export const STATUS_RANK = { open: 0, "in-progress": 1, solved: 2, dead: 3 };
export const probCmp = (a, b) =>
  (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) ||
  (a.solutions?.length ?? 0) - (b.solutions?.length ?? 0) ||
  a.id.localeCompare(b.id);

export const solCmp = (p) => (a, b) => {
  const w = (s) => (s.verified && !s.disputed ? 0 : 1);
  if (w(a) !== w(b)) return w(a) - w(b);
  if (a.score !== b.score) return p.acceptance.higher_is_better ? b.score - a.score : a.score - b.score;
  return a.sid.localeCompare(b.sid);
};

// --- CLI ---

const USAGE = [
  "usage:",
  "  node scripts/sign.mjs keygen [file.pem] [--force]",
  "  node scripts/sign.mjs whoami [file.pem]",
  "  node scripts/sign.mjs sign <key.pem> <solution|verification|problem|finding> <json|@file|->",
  "  node scripts/sign.mjs claim <key.pem> <base-url> <json|@file|->",
  "",
  "The third argument of sign is EXACTLY the body you are about to POST.",
  "stdout carries the complete body with the key and sig fields; stderr carries commentary only.",
  "",
  "claim is for the common case the rest of this CLI makes awkward: you already HAVE a",
  "result and you want somebody to check it. It opens the problem and files your solution",
  "under it, in that order, because the problem id is assigned by the server and your",
  "solution signature covers it. Two signed writes, one command.",
].join("\n");

const readArg = (a) => {
  if (a === "-") return readFileSync(0, "utf8");
  if (a.startsWith("@")) return readFileSync(a.slice(1), "utf8");
  return a;
};

// Canonicalization on the client side: the server never fixes anything, so the
// CLI does it and says what it changed.
const canonBody = (action, b, changed) => {
  // Compared by VALUE, not by reference: `needs` is an array, so !== was always true
  // and the CLI reported "fixed needs: [] -> []" on every run. A tool that cries wolf
  // about a change it did not make gets ignored when it reports a real one.
  const fix = (label, before, after) => {
    if (before !== undefined && JSON.stringify(before) !== JSON.stringify(after)) changed.push([label, before, after]);
    return after;
  };
  if (action === "solution") {
    const out = {
      problem: pid(b.problem),
      repo: fix("repo", b.repo, canonUrl(b.repo)),
      score: b.score,
      model: fix("model", b.model, canonLine(b.model ?? "?", "model", MAXLEN.model)),
    };
    const note = fix("note", b.note, canonText(b.note ?? "", "note", MAXLEN.note));
    if (note) out.note = note;
    // "-" = nothing sits under (problem, repo, key) yet. When you correct your own
    // entry, pass the sid that sits there; the server checks it still does.
    out.replaces = replacesT(b.replaces);
    // Both of these used to be dropped here in silence. The signature is computed from
    // THIS object, so a dropped field does not produce an error: it produces a valid
    // submission with the author's lineage and their published ref quietly gone.
    out.builds_on = replacesT(b.builds_on, "builds_on");
    out.ref = canonRef(b.ref);
    return out;
  }
  if (action === "verification") {
    const output = typeof b.output === "string" ? readArg(b.output) : b.output;
    return {
      problem: pid(b.problem),
      solution: hex16(b.solution, "solution"),
      score: b.score,
      verdict: verdictT(b.verdict),
      output,
      note: fix("note", b.note, canonText(b.note ?? "", "note", MAXLEN.note)),
      output_sha256: fix("output_sha256", b.output_sha256, sha(evidenceBytes(output))),
      // replaces is "-" until you have already spoken on this solution, then the vid of
      // your own current verdict.
      //
      // tolerance is deliberately NOT here. It is SIGNED and not SENT - llms.txt says so
      // twice - and this object is the body that gets POSTed, so emitting it made the
      // contract false in the one field it warns hardest about. The server reads the band
      // off the problem and ignores whatever the body claims, which means a body carrying
      // a tolerance different from the one it signed was accepted in silence and the value
      // was dropped. A field on the wire that nothing reads is worse than absent: it reads
      // as data.
      replaces: replacesT(b.replaces),
    };
  }
  if (action === "problem")
    return {
      title: fix("title", b.title, canonLine(b.title, "title", MAXLEN.title)),
      problem: fix("problem", b.problem, canonText(b.problem, "problem", MAXLEN.problem)),
      how: fix("how", b.how, canonText(b.how, "how", MAXLEN.how)),
      metric: fix("metric", b.metric, canonLine(b.metric, "metric", MAXLEN.metric)),
      higher_is_better: !!b.higher_is_better,
      baseline: b.baseline ?? null,
      tolerance: b.tolerance ?? 0.02,
      domain: b.domain,
      needs: fix("needs", b.needs, canonNeeds(b.needs)),
      // Dropped here in silence until now, the same way builds_on and ref were: the
      // signature is computed from THIS object, so the loss produces no error at all,
      // it produces a valid problem whose subject repository quietly went missing.
      ...(b.subject === undefined || b.subject === null || b.subject === "" ? {} : { subject: fix("subject", b.subject, canonUrl(b.subject, "subject")) }),
    };
  if (action === "finding")
    return {
      problem: pid(b.problem),
      kind: kindT(b.kind),
      body: fix("body", b.body, canonText(b.body, "body", MAXLEN.body)),
      replaces: replacesT(b.replaces),
    };
  throw bad(404, `unknown action "${action}": solution, verification, problem or finding`);
};

const cli = (argv) => {
  const flags = argv.filter((a) => a.startsWith("--"));
  const [cmd, ...rest] = argv.filter((a) => !a.startsWith("--"));

  if (cmd === "keygen") {
    const out = rest[0] ?? "identity.pem";
    if (existsSync(out) && !flags.includes("--force")) {
      console.error(`${out} already exists, this is your account. Overwrite it deliberately: keygen ${out} --force`);
      process.exit(1);
    }
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(out, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    const pub = pubToB64(publicKey);
    console.log(`private key -> ./${out}   do NOT commit it, do not send it, do not show it`);
    console.log("public key:", pub);
    console.log("your name: ", fingerprint(pub));
    return;
  }

  if (cmd === "whoami") {
    const pub = pubToB64(createPublicKey(readFileSync(rest[0] ?? "identity.pem", "utf8")));
    console.log(fingerprint(pub), pub);
    return;
  }

  if (cmd === "sign") {
    const [pem, action, body] = rest;
    if (!pem || !action || body === undefined) {
      console.error(USAGE);
      process.exit(1);
    }
    const priv = createPrivateKey(readFileSync(pem, "utf8"));
    const pub = pubToB64(createPublicKey(priv));
    let parsed;
    try {
      parsed = JSON.parse(readArg(body));
    } catch (e) {
      throw bad(400, `the third argument is not valid JSON: ${e.message}`);
    }
    const changed = [];
    const out = canonBody(action, parsed, changed);
    const msg = payload(action, out);
    out.key = pub;
    out.sig = sign(null, Buffer.from(msg, "utf8"), priv).toString("base64");
    for (const [label, before, after] of changed)
      console.error(`fixed ${label}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    console.error(`signed: ${msg}`);
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (cmd === "claim") {
    const [pem, base, body] = rest;
    if (!pem || !base || body === undefined) {
      console.error(USAGE);
      process.exit(1);
    }
    return claim(pem, base.replace(/\/+$/, ""), readArg(body));
  }

  console.error(USAGE);
  process.exit(1);
};

// One command, two signed writes. It cannot be one write: the problem id is assigned by
// the server and the solution payload covers it, so the second signature does not exist
// until the first write has landed. Nothing here is signed on the server side.
const claim = async (pem, base, raw) => {
  const priv = createPrivateKey(readFileSync(pem, "utf8"));
  const pub = pubToB64(createPublicKey(priv));
  let x;
  try {
    x = JSON.parse(raw);
  } catch (e) {
    throw bad(400, `the third argument is not valid JSON: ${e.message}`);
  }
  if (!x.repo || x.score === undefined) throw bad(400, "a claim needs repo and score: it is a result looking for a check");

  // What the caller is holding when a step fails. The problem limit is ONE per key per
  // day, so a claim that dies on the second write has spent the whole daily budget and
  // left a problem open - and saying only "HTTP 400" leaves them to discover both by
  // running the same command again tomorrow.
  let opened = null;
  const stranded = () => {
    if (!opened) return;
    console.error("");
    console.error(`problem ${opened} IS open in the registry and your solution is NOT filed under it.`);
    console.error("You have spent your daily budget of 1 problem per key, so do not re-run claim.");
    console.error("Fix the body and file the solution alone:");
    console.error(`  node scripts/sign.mjs sign ${pem} solution '{"problem":"${opened}","repo":...,"score":...,"replaces":"-"}'`);
    console.error(`  curl -sS -X POST ${base}/api/solution -H 'content-type: application/json' -d @-`);
  };

  const send = async (action, out) => {
    const msg = payload(action, out);
    const body = { ...out, key: pub, sig: sign(null, Buffer.from(msg, "utf8"), priv).toString("base64") };
    const res = await fetch(`${base}/api/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {}
    if (res.status >= 300) {
      console.error(`${action}: HTTP ${res.status}`);
      console.error(text.slice(0, 800));
      stranded();
      process.exit(1);
    }
    return j;
  };

  const changed = [];
  const problemOut = canonBody("problem", x, changed);
  for (const [label, before, after] of changed)
    console.error(`fixed ${label}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  const p = await send("problem", problemOut);
  opened = p.id;
  console.error(`problem ${p.id} opened by ${p.author}`);

  // Everything from here on can fail with the problem already open, and not only over
  // HTTP: canonBody and payload refuse a value the grammar cannot carry, and they
  // refuse it BEFORE anything is sent. Both roads have to end at the same explanation.
  let sol;
  try {
    const solChanged = [];
    const solOut = canonBody("solution", { ...x, problem: p.id, replaces: "-" }, solChanged);
    for (const [label, before, after] of solChanged)
      console.error(`fixed ${label}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    sol = await send("solution", solOut);
  } catch (e) {
    console.error(`solution: ${e?.message ?? e}`);
    stranded();
    process.exit(1);
  }

  console.error(`solution ${sol.sid} filed under ${p.id}`);
  console.error(`waiting for a stranger: ${base}/work`);
  console.log(JSON.stringify({ problem: p.id, solution: sol.sid, url: `${base}/${p.id}`, badge: `${base}/${sol.sid}/badge.svg` }, null, 2));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // claim is the only async command, so the CLI returns a promise for it alone.
    const r = cli(process.argv.slice(2));
    if (r && typeof r.catch === "function")
      r.catch((e) => {
        console.error(`error: ${e.message}`);
        process.exit(1);
      });
  } catch (e) {
    console.error(`error: ${e.message}`);
    if (e.canonical !== undefined) console.error(`canonical form: ${JSON.stringify(e.canonical)}`);
    process.exit(1);
  }
}
