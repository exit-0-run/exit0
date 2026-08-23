#!/usr/bin/env node
// Acceptance against a DEPLOYED instance, over HTTP, using only what that instance
// publishes: /llms.txt and /sign.mjs. That is the difference from scripts/test.mjs,
// which tests the code in this directory. This tests the promise: a stranger who has
// nothing but the address can get a verified result in.
//
//   node deploy/acceptance.mjs                      # http://127.0.0.1:8080
//   node deploy/acceptance.mjs https://exit0.run    # writes to a PUBLIC registry
//
// It WRITES: one solution and three verifications, under fresh keys. Against a public
// registry that is real content, so at the end it prints the exact revert commands.
// Nothing here is skipped silently: every check prints PASS or FAIL with the evidence.

import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign as edSign, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const BASE = (process.argv[2] ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const sha256 = (x) => createHash("sha256").update(Buffer.isBuffer(x) ? x : Buffer.from(x, "utf8")).digest("hex");

let pass = 0;
const fails = [];
const check = (name, ok, evidence) => {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}\n      ${String(evidence).replace(/\n/g, "\n      ").slice(0, 600)}`);
  }
  return ok;
};

const hit = async (path, opts = {}) => {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, text, json };
};
const post = (action, body) =>
  hit(`/api/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

console.log(`exit0 acceptance against ${BASE}`);
console.log(`${new Date().toISOString()}\n`);

// --- 1. the published door ---
const llms = await hit("/llms.txt");
check("/llms.txt is served and names the signature grammar", llms.status === 200 && llms.text.includes("exit0/v1|verification|"), `HTTP ${llms.status}, ${llms.text.length} bytes`);

const signer = await hit("/sign.mjs");
check("/sign.mjs is served", signer.status === 200 && signer.text.includes("export const payload"), `HTTP ${signer.status}, ${signer.text.length} bytes`);
if (signer.status !== 200) {
  console.log("\nwithout the signer nothing below can be signed. Stopping.");
  process.exit(1);
}

// The signer is imported from the bytes the SERVER served, not from this directory:
// that is the whole point, a stranger has no copy of this repository.
const dir = mkdtempSync(join(tmpdir(), "exit0-acceptance-"));
const signerPath = join(dir, "sign.mjs");
writeFileSync(signerPath, signer.text);
const sg = await import(pathToFileURL(signerPath).href);
check("the served signer imports and carries the contract", typeof sg.payload === "function" && typeof sg.keyId === "function", "missing exports");

const pulse = await hit("/api/pulse");
check(
  "/api/pulse carries head, limits, contract and writes",
  pulse.status === 200 && pulse.json?.head && pulse.json?.limits && pulse.json?.contract && pulse.json?.writes,
  pulse.text.slice(0, 300)
);
check("the instance takes writes right now", pulse.json?.writes === "ok", `writes=${pulse.json?.writes}, reason=${pulse.json?.reason}`);
check("limits.attempts_left tells this address its own budget", Number.isInteger(pulse.json?.limits?.attempts_left), JSON.stringify(pulse.json?.limits));
check("the served signer is the one the instance runs", sg.PREFIX === "exit0/v1", `PREFIX=${sg.PREFIX}`);

// --- 2. identity ---
const mkKey = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pub: sg.pubToB64(publicKey), priv: privateKey };
};
const sigOf = (k, msg) => edSign(null, Buffer.from(msg, "utf8"), k.priv).toString("base64");
const A = mkKey();
const B = mkKey();
check("keygen from the served signer produces a 12 hex name", /^[0-9a-f]{12}$/.test(sg.fingerprint(A.pub)), sg.fingerprint(A.pub));

// --- 3. what we are going to verify ---
const idx = await hit("/api/index.json");
const problem = (idx.json?.problems ?? []).find((p) => p.status !== "dead");
if (!check("the registry has a problem to submit against", !!problem, "no live problem in /api/index.json")) process.exit(1);
const PID = problem.id;
const TOL = problem.acceptance.tolerance ?? 0.02;

const solFields = { problem: PID, repo: `https://example.com/acceptance-${Date.now()}`, score: 0.31, model: "acceptance", note: "", replaces: "-" };
const solBody = { ...solFields, key: A.pub, sig: sigOf(A, sg.payload("solution", solFields)) };

// --- 4. the write path ---
const tampered = await post("solution", { ...solBody, score: 0.99 });
check("a score swapped after signing is refused with the payload the server verified", tampered.status === 403 && typeof tampered.json?.expected_payload === "string", `HTTP ${tampered.status}: ${tampered.text.slice(0, 200)}`);

const sol = await post("solution", solBody);
if (!check("a signed solution is accepted", sol.status === 201 && /^[0-9a-f]{16}$/.test(sol.json?.sid ?? ""), `HTTP ${sol.status}: ${sol.text.slice(0, 300)}`)) process.exit(1);
const SID = sol.json.sid;

const ver = (k, o) => {
  const output_sha256 = sha256(o.output);
  const signed = { problem: PID, solution: SID, score: o.score, verdict: o.verdict, output_sha256, tolerance: o.tolerance ?? TOL, replaces: o.replaces ?? "-" };
  return { problem: PID, solution: SID, score: o.score, verdict: o.verdict, output_sha256, replaces: signed.replaces, output: o.output, key: k.pub, sig: sigOf(k, sg.payload("verification", signed)) };
};

const self = await post("verification", ver(A, { score: 0.3105, verdict: "ok", output: "acceptance: self\n" }));
check("nobody verifies their own solution", self.status === 403, `HTTP ${self.status}: ${self.text.slice(0, 200)}`);

const band = await post("verification", ver(B, { score: 0.9, verdict: "ok", output: "acceptance: out of band\n" }));
check('an "ok" outside the band is refused and the band is named', band.status === 422 && /band/.test(band.json?.error ?? ""), `HTTP ${band.status}: ${band.text.slice(0, 200)}`);

const wrongTol = await post("verification", ver(B, { score: 0.3105, verdict: "ok", output: "acceptance: wrong band\n", tolerance: TOL === 0.5 ? 0.4 : 0.5 }));
check(
  "a verdict signed under a different band is refused, and the answer names the real one",
  wrongTol.status === 403 && String(wrongTol.json?.expected_payload ?? "").endsWith(`|${sg.payload("verification", { problem: PID, solution: SID, score: 0.3105, verdict: "ok", output_sha256: sha256("acceptance: wrong band\n"), tolerance: TOL, replaces: "-" }).split("|").slice(-2).join("|")}`),
  `HTTP ${wrongTol.status}: ${wrongTol.text.slice(0, 300)}`
);

const v1 = await post("verification", ver(B, { score: 0.3105, verdict: "ok", output: "acceptance: run 1\n" }));
if (!check("a stranger's verification is accepted, with its evidence path", v1.status === 201 && /^problems\/evidence\/\d{4}-[0-9a-f]{64}\.txt$/.test(v1.json?.evidence ?? ""), `HTTP ${v1.status}: ${v1.text.slice(0, 300)}`)) process.exit(1);
const VID = v1.json.vid;

const noReplaces = await post("verification", ver(B, { score: 0.9, verdict: "mismatch", output: "acceptance: run 2\n" }));
check("correcting your own verdict has to name the verdict it replaces", noReplaces.status === 409 && noReplaces.json?.replaces === VID, `HTTP ${noReplaces.status}: ${noReplaces.text.slice(0, 300)}`);

const v2 = await post("verification", ver(B, { score: 0.9, verdict: "mismatch", output: "acceptance: run 2\n", replaces: VID }));
check("a correction that names it is accepted", v2.status === 201, `HTTP ${v2.status}: ${v2.text.slice(0, 300)}`);

// --- 5. derived state, read back over HTTP ---
const after = await hit("/api/index.json");
const entry = (after.json?.problems ?? []).find((p) => p.id === PID)?.solutions?.find((s) => s.sid === SID);
check("the head of the chain is what counts: an ok corrected to mismatch leaves the entry unverified", entry && entry.verified === false && entry.disputed === true && entry.settled === false, JSON.stringify(entry && { verified: entry.verified, disputed: entry.disputed, settled: entry.settled }));
check(
  "both records stay on file, linked into one chain",
  entry?.verifications?.length === 2 && entry.verifications.some((v) => v.replaces === "-") && entry.verifications.some((v) => v.replaces === VID),
  JSON.stringify(entry?.verifications?.map((v) => ({ vid: v.vid, replaces: v.replaces, verdict: v.verdict })))
);

// The listing is one line per problem and carries no sid: that is what keeps the
// front door a constant size. The dispute has to be visible there anyway, and the sid
// on the problem page.
const view = await hit("/", { headers: { accept: "text/plain" } });
check("the listing marks the problem as disputed without carrying the record", view.status === 200 && /DISPUTED/.test(view.text) && !view.text.includes(SID), `HTTP ${view.status}`);

const page = await hit(`/${PID}`, { headers: { accept: "text/plain" } });
check("the problem page carries the sid, the command and the band", page.status === 200 && page.text.includes(SID) && page.text.includes("how to check:") && /tolerance/.test(page.text), `HTTP ${page.status}: ${page.text.slice(0, 200)}`);

const listed = await hit(`/api/problems?domain=${encodeURIComponent(problem.domain)}`);
check("the filtered listing finds this problem and states whether it was cut", listed.status === 200 && (listed.json?.problems ?? []).some((x) => x.id === PID) && typeof listed.json?.more === "boolean", `HTTP ${listed.status}: ${listed.text.slice(0, 200)}`);

const html = await hit("/", { headers: { accept: "text/html" } });
check("HTML is served only on request, with no scripts and nothing pulled from the network", html.text.startsWith("<!doctype html") && !/<script/i.test(html.text) && !/\b(?:src|href)\s*=\s*["']https?:/i.test(html.text), html.text.slice(0, 120));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) console.log(fails.map((f) => `  - ${f}`).join("\n"));
console.log(`\nThis run left records in the registry. To undo them there:`);
console.log(`  git -C <registry> log --oneline -4`);
console.log(`  git -C <registry> revert --no-edit <the commits of ${SID}>`);
console.log(`  git -C <registry> status --porcelain    # must come out empty`);
process.exit(fails.length ? 1 : 0);
