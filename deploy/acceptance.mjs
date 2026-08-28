#!/usr/bin/env node
// Acceptance against a DEPLOYED instance, over HTTP, using only what that instance
// publishes: /llms.txt and /sign.mjs. That is the difference from scripts/test.mjs,
// which tests the code in this directory. This tests the promise: a stranger who has
// nothing but the address can get a verified result in.
//
//   node deploy/acceptance.mjs                      # http://127.0.0.1:8080
//   node deploy/acceptance.mjs https://exit0.run    # writes to a PUBLIC registry
//
// It WRITES: one attempt, one solution and three verifications, under fresh keys. Against
// a public registry that is real content, so at the end it prints the exact revert commands.
// Nothing here is skipped silently: every check prints PASS or FAIL with the evidence.

import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
  return { status: res.status, text, json, headers: res.headers };
};
const post = (action, body) =>
  hit(`/api/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

console.log(`exit0 acceptance against ${BASE}`);
console.log(`${new Date().toISOString()}\n`);

// --- 1. the published door ---
const llms = await hit("/llms.txt");
const signer = await hit("/sign.mjs");
check("/sign.mjs is served", signer.status === 200 && signer.text.includes("export const payload"), `HTTP ${signer.status}, ${signer.text.length} bytes`);

// The prefix is READ OFF the served sign.mjs rather than written here. It used to be
// pinned to the literal exit0/v1, and when PREFIX moved to v2 this check could no longer
// pass at all: a smoke test with a check that can never go green is not a canary, it is a
// dead bird in the cage that nobody looks at. Deriving it also makes the check stronger
// than it was - it now asserts the documentation and the code agree on the wire version.
const PREFIX = (signer.text.match(/export const PREFIX = "([^"]+)"/) ?? [])[1];
check("/sign.mjs declares the wire version", !!PREFIX, signer.text.slice(0, 200));
check(
  "/llms.txt is served and names the SAME signature grammar the served code implements",
  llms.status === 200 && !!PREFIX && llms.text.includes(`${PREFIX}|verification|`),
  `HTTP ${llms.status}, ${llms.text.length} bytes, prefix ${PREFIX}`
);
for (const action of ["solution", "verification", "problem", "finding", "remark", "docket"])
  check(`/llms.txt carries the grammar for ${action}`, !!PREFIX && llms.text.includes(`${PREFIX}|${action}|`), `no ${PREFIX}|${action}| line`);
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
// A second pin on exit0/v1 lived here, and it is DELETED rather than bumped. s/v1/v2/
// would be green and vacuous: sg is imported from the sign.mjs this script downloaded four
// lines earlier, so the check compares that file with itself and says nothing about the
// instance. Comparing digests is a tautology too - server.mjs reads SIGN_SRC once, serves
// those bytes at /sign.mjs and publishes sha16 of them as `contract`, and the Caddyfile is
// a pure reverse_proxy, so both sides are the same bytes by construction. That swaps a dead
// bird for a decorative one, which is the same failure wearing a green tick.
// The property it reached for - the grammar I downloaded is the grammar you enforce - is
// already covered below by WRITES: a body signed with the served payload() is accepted 201,
// a swapped score is refused 403, and a verdict signed under a different band is refused 403
// with the server's expected payload matching one computed locally from the served signer.
// If the instance ran a different signer, all three fail. A staleness canary comparing a
// LIVE instance against a clone is a different job and belongs in the deploy path; this
// script has no copy of the repository, by design.

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

// --- 4. the code, before the claim about it ---
// A solution names code this registry hosts, so the push comes FIRST and the ref it
// returns is what the solution signs. Nothing here is hard-coded: the ref is read off
// the 201, so this stays a test of the flow rather than of a string. That distinction
// is the reason this file exists at all - the suite in scripts/ builds bodies by hand
// and would go on passing while the documented path was broken for a stranger.
const gitIn = (d, ...a) =>
  String(execFileSync("git", ["-C", d, ...a], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "acceptance", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "acceptance", GIT_COMMITTER_EMAIL: "a@example.com" },
  })).trim();

const src = mkdtempSync(join(tmpdir(), "exit0-acc-src-"));
gitIn(src, "init", "-q");
// A LICENSE at the tree root is a gate on the far side: a verifier has to be allowed
// to run this. Acceptance publishes real code into a real registry, so it carries a
// real licence rather than a file named like one.
writeFileSync(join(src, "LICENSE"), "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.\n");
writeFileSync(join(src, "run.sh"), "#!/bin/sh\necho 0.31\n");
gitIn(src, "add", "-A");
gitIn(src, "commit", "-q", "-m", "acceptance attempt");
const bundlePath = join(src, "attempt.bundle");
gitIn(src, "bundle", "create", bundlePath, "HEAD");
const bundle = readFileSync(bundlePath);

const attFields = { problem: PID, slug: `acceptance-${Date.now()}`.slice(0, 40), bundle_sha256: sha256(bundle) };
const att = await post("attempt", { ...attFields, bundle: bundle.toString("base64"), key: A.pub, sig: sigOf(A, sg.payload("attempt", attFields)) });
if (!check("code with nowhere of its own to live is pushed here and comes back as a ref", att.status === 201 && typeof att.json?.ref === "string" && /^[0-9a-f]{40}$/.test(att.json?.sha ?? ""), `HTTP ${att.status}: ${att.text.slice(0, 300)}`)) process.exit(1);
const REF = att.json.ref;

const solFields = { problem: PID, repo: att.json.repo ?? `${BASE}/`, score: 0.31, model: "acceptance", note: "", replaces: "-", ref: REF };
const solBody = { ...solFields, key: A.pub, sig: sigOf(A, sg.payload("solution", solFields)) };

// --- 5. the write path ---
const tampered = await post("solution", { ...solBody, score: 0.99 });
check("a score swapped after signing is refused with the payload the server verified", tampered.status === 403 && typeof tampered.json?.expected_payload === "string", `HTTP ${tampered.status}: ${tampered.text.slice(0, 200)}`);

// A solution that points nowhere this registry can fetch is not a solution: the whole
// reason the push above exists is that a link is only as durable as somebody's account.
const linkOnly = { ...solFields, ref: "-" };
const noRef = await post("solution", { ...linkOnly, key: B.pub, sig: sigOf(B, sg.payload("solution", linkOnly)) });
check("a solution that points at no hosted code is refused, and the answer says how to push it", noRef.status === 422 && /attempt/.test(noRef.json?.how ?? noRef.text), `HTTP ${noRef.status}: ${noRef.text.slice(0, 200)}`);

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

// --- 6. derived state, read back over HTTP ---
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

// The three surfaces that exist to answer "why does this site need to exist at all":
// the queue is the only reason to come back, the badge the only reason to submit.
const work = await hit("/api/work");
check(
  "the queue offers this unchecked solution as work, with what it needs to run",
  work.status === 200 && (work.json?.work ?? []).some((x) => x.solution === SID && x.need === "tiebreak" && Array.isArray(x.needs) && typeof x.tolerance === "number"),
  `HTTP ${work.status}: ${work.text.slice(0, 300)}`
);

// Declaring a cut is not the same as offering a way past it, and the queue is the
// surface a returning agent reads first.
const paged = await hit("/api/work?limit=1");
check(
  "the queue pages: limit is honoured and the cut is declared",
  paged.status === 200 && (paged.json?.work ?? []).length <= 1 && typeof paged.json?.more === "boolean" && Number.isInteger(paged.json?.offset),
  `HTTP ${paged.status}: ${paged.text.slice(0, 300)}`
);
check(
  "the queue refuses a paging parameter it cannot read, instead of guessing",
  (await hit("/api/work?limit=x")).status === 400 && (await hit("/api/work?offset=-1")).status === 400,
  "a bad limit or offset was accepted"
);

const bdg = await hit(`/${SID}/badge.svg`);
check(
  "the solution badge tells the truth about the verdict",
  bdg.status === 200 && bdg.text.startsWith("<svg") && /disputed/.test(bdg.text),
  `HTTP ${bdg.status}: ${bdg.text.slice(0, 200)}`
);
check(
  "the badge fetches nothing and carries no script",
  !/<script|<image|<foreignObject/i.test(bdg.text) && !/\b(?:src|href|xlink:href)\s*=/i.test(bdg.text),
  bdg.text.slice(0, 200)
);

const pbdg = await hit(`/${PID}/badge.svg`);
check("the problem badge answers too", pbdg.status === 200 && pbdg.text.includes("<svg"), `HTTP ${pbdg.status}`);

const listed = await hit(`/api/problems?domain=${encodeURIComponent(problem.domain)}`);
check("the filtered listing finds this problem and states whether it was cut", listed.status === 200 && (listed.json?.problems ?? []).some((x) => x.id === PID) && typeof listed.json?.more === "boolean", `HTTP ${listed.status}: ${listed.text.slice(0, 200)}`);

// The board is a fold over records already in git: nothing to store, so the only thing
// that can break it in a deployment is the route not being wired up.
const board = await hit("/api/keys");
check(
  "the board answers and carries a row per key, with no score to game",
  board.status === 200 && Array.isArray(board.json?.board) && board.json.board.every((r) => typeof r.standing === "boolean" && !("score" in r)),
  `HTTP ${board.status}: ${board.text.slice(0, 300)}`
);
const boardText = await hit("/keys", { headers: { accept: "text/plain" } });
check("the text board explains its columns", boardText.status === 200 && /^solved\s/m.test(boardText.text) && /^standing\s/m.test(boardText.text), `HTTP ${boardText.status}`);

// The same shape one route over: a fold over records already in git, so the only thing a
// deployment can break is the route not being wired up. The entry above was claimed at
// 0.31 and the head of the verifier's chain says 0.9, so this instance has a claim that
// did not survive contact and has to be able to say so.
const gap = await hit("/api/gap");
const gapRow = (gap.json?.gaps ?? []).find((x) => x.solution === SID);
check(
  "the gap fold reports this claim against what the stranger got, and derives nothing from it",
  gap.status === 200 && !!gapRow && gapRow.claimed === 0.31 && gapRow.worst === 0.9 && gapRow.moved === true && gapRow.mismatch === true && gap.json.changes_nothing === true && !("verdict" in gapRow),
  `HTTP ${gap.status}: ${JSON.stringify(gapRow ?? gap.text.slice(0, 300))}`
);
const gapText = await hit("/gap", { headers: { accept: "text/plain" } });
check(
  "the text gap view explains its columns and flags the refusal",
  gapText.status === 200 && /^claimed\s/m.test(gapText.text) && /^gap\s/m.test(gapText.text) && /MISMATCH/.test(gapText.text),
  `HTTP ${gapText.status}: ${gapText.text.slice(0, 300)}`
);

// Standing is the whole reason findings are not a comment box. A deployment where an
// unknown key can file one has lost the property, not just a test.
const stranger = await hit("/api/finding", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ key: "not a key", sig: "no", problem: PID, kind: "deadend", body: "x", replaces: "-" }),
});
check("a finding from a key with nothing behind it is refused", [400, 401, 403].includes(stranger.status), `HTTP ${stranger.status}: ${stranger.text.slice(0, 200)}`);

// A remark is the ONE write here that a key with no work behind it may make, and a
// deployment where it is refused has lost the door rather than a test: the reader worth
// hearing on a statement may have run nothing. Signed for real, because the interesting
// failure is a 403 from the standing gate leaking onto this path, and an unsigned body
// cannot tell that apart from a 401.
{
  // A key made right here, with nothing behind it: that is the whole point of the check.
  const k = mkKey();
  const f = { problem: PID, body: `acceptance: a reader who ran nothing disputes this statement (${new Date().toISOString()})`, replaces: "-" };
  const r = await post("remark", { ...f, key: k.pub, sig: sigOf(k, sg.payload("remark", f)) });
  check("a remark from a key with NOTHING behind it is accepted: the door is open on purpose", r.status === 201, `HTTP ${r.status}: ${r.text.slice(0, 300)}`);
  const idx = await hit("/api/remarks", { headers: { accept: "application/json" } });
  check("the remark reaches /api/remarks and it declares that it changes nothing",
    idx.status === 200 && idx.json?.changes_nothing === true && idx.json?.needs_standing === false,
    `HTTP ${idx.status}: ${idx.text.slice(0, 300)}`);
}

// The doors a client looks for before it looks at prose. Checked on the DEPLOYMENT because
// the manifest and the OpenAPI servers[] are built from the Host the caller used, and a
// reverse proxy is exactly what gets that wrong: behind Caddy without x-forwarded-proto
// they come back http:// on an https site and every client following them fails.
{
  const surface = await hit("/api/surface", { headers: { accept: "application/json" } });
  check("/api/surface lists the routes, with no blank summaries",
    surface.status === 200 && (surface.json?.routes ?? []).length > 20 && (surface.json?.routes ?? []).every((r) => r.summary),
    `HTTP ${surface.status}: ${surface.text.slice(0, 200)}`);

  const oa = await hit("/openapi.json", { headers: { accept: "application/json" } });
  check("/openapi.json is 3.1 and names THIS deployment as its server",
    oa.status === 200 && oa.json?.openapi === "3.1.0" && String(oa.json?.servers?.[0]?.url ?? "") === BASE.replace(/\/$/, ""),
    `HTTP ${oa.status}, servers[0]=${JSON.stringify(oa.json?.servers?.[0]?.url)} against BASE=${BASE}`);

  const wk = await hit("/.well-known/mcp.json", { headers: { accept: "application/json" } });
  check("/.well-known/mcp.json points at this deployment's /mcp over the scheme it was reached on",
    wk.status === 200 && String(wk.json?.transport?.url ?? "") === `${BASE.replace(/\/$/, "")}/mcp` && wk.json?.authentication?.type === "none",
    `HTTP ${wk.status}: ${wk.text.slice(0, 200)}`);

  const rpc = (body) => hit("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  check("MCP: initialize answers and declares tools", init.status === 200 && !!init.json?.result?.capabilities?.tools, `HTTP ${init.status}: ${init.text.slice(0, 200)}`);
  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  check("MCP: tools/list returns tools, all described", (list.json?.result?.tools ?? []).length >= 10 && (list.json?.result?.tools ?? []).every((t) => t.description), `${(list.json?.result?.tools ?? []).length} tools`);
  const call = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "exit0_work" } });
  const direct = await hit("/work", { headers: { accept: "text/plain" } });
  check("MCP: a tool returns exactly what its route returns", call.json?.result?.content?.[0]?.text === direct.text, "the MCP door and the HTTP route disagree, so there are two renderings to keep in step");
}

const front = await hit("/", { headers: { accept: "text/plain" } });
check("the front door advertises the board, the finding route and the remark route", /GET \/keys/.test(front.text) && /\/api\/finding/.test(front.text) && /\/api\/remark/.test(front.text), front.text.slice(0, 400));

// The door for somebody arriving with a QUESTION rather than a result. It stores nothing
// and its inventory is a predicate over records already in git, so the only thing a
// deployment can break is the route not being wired up - or the predicate drifting from
// the one the documentation states, which is what the second check is for. That one is
// not vacuous on an empty registry: it compares two counts, and 0 against 1 still fails.
const ask = await hit("/api/ask");
check(
  "the question door answers, pages, and declares that it compares nothing",
  ask.status === 200 && Array.isArray(ask.json?.ask) && ask.json?.compares_nothing === true && typeof ask.json?.more === "boolean",
  `HTTP ${ask.status}: ${ask.text.slice(0, 300)}`
);
const wouldAsk = (idx.json?.problems ?? []).filter(
  (p) => p.status !== "dead" && typeof p.subject === "string" && p.subject && typeof p.acceptance?.baseline === "number"
).length;
check(
  "the door's inventory IS the membership predicate: a repository and a figure, computed and never curated",
  ask.json?.questions === wouldAsk,
  `the door says ${ask.json?.questions}, the index holds ${wouldAsk} live problems naming both a repository and a figure`
);
check(
  "every question at the door names code and a figure, and judges nobody",
  (ask.json?.ask ?? []).every((r) => /^https?:\/\//.test(String(r.subject)) && typeof r.published === "number" && !("verdict" in r) && !("author" in r)),
  JSON.stringify(ask.json?.ask?.[0] ?? null)
);
const askText = await hit("/ask", { headers: { accept: "text/plain" } });
check(
  "the text door explains what a question is made of and refuses to compare the two figures",
  askText.status === 200 && askText.text.startsWith("EXIT0 / ASK") && /compares NEITHER/.test(askText.text) && /never people/.test(askText.text),
  `HTTP ${askText.status}: ${askText.text.slice(0, 200)}`
);
check("the front door advertises the question door", /GET \/ask/.test(front.text), front.text.slice(0, 600));

// --- the docket and the inbox, on the deployed instance ---
// Both are READ-ONLY here on purpose. Filing a docket row against a public registry is
// real content that a revert cannot fully undo (the rid is in a signature), and the two
// properties worth checking from outside do not need a write: that the status is a fold
// nobody can assert, and that the inbox answers for a key without one.
const dock = await hit("/api/docket");
check(
  "the docket is served and states the ONE thing that closes a row",
  dock.status === 200 && /Docket: <rid>/.test(String(dock.json?.closed_by)) && dock.json?.changes_nothing === true,
  `HTTP ${dock.status}: ${dock.text.slice(0, 200)}`
);
check(
  "no docket row carries a status field: the status is folded, never stored",
  Array.isArray(dock.json?.rows) && dock.json.rows.every((r) => ["open", "shipped", "superseded"].includes(r.status) && typeof r.check_it_yourself === "string"),
  JSON.stringify(dock.json?.rows?.[0] ?? null)
);
check(
  "every SHIPPED row names the commit that closed it",
  (dock.json?.rows ?? []).filter((r) => r.status === "shipped").every((r) => /^[0-9a-f]{40}$/.test(String(r.commit))),
  JSON.stringify((dock.json?.rows ?? []).filter((r) => r.status === "shipped").map((r) => [r.rid, r.commit]))
);
const dockText = await hit("/docket", { headers: { accept: "text/plain" } });
check(
  "the docket page refuses a declined status in public, and says why",
  dockText.status === 200 && dockText.text.startsWith("EXIT0 / DOCKET") && /no `?declined`?/i.test(dockText.text) && /marking our own homework|nobody verifies themselves/i.test(dockText.text),
  `HTTP ${dockText.status}: ${dockText.text.slice(0, 200)}`
);
// /api/docket is the only path here that answers both GET and POST. Routing on the path
// alone answered the documented write with a 405, so this is checked from outside too.
const dockAllow = await hit("/api/docket", { method: "DELETE" });
check(
  "/api/docket takes both GET and POST, and says so in Allow",
  dockAllow.status === 405 && /GET/.test(dockAllow.headers.get("allow") ?? "") && /POST/.test(dockAllow.headers.get("allow") ?? ""),
  `HTTP ${dockAllow.status}, allow: ${dockAllow.headers.get("allow")}`
);
check("the front door advertises the docket", /GET \/docket/.test(front.text), front.text.slice(0, 800));

const inbox = await hit(`/api/inbox/${sg.fingerprint(B.pub)}`);
check(
  "the inbox answers for a key with no signature and nothing to acknowledge",
  inbox.status === 200 && inbox.json?.no_ack_needed === true && Array.isArray(inbox.json?.inbox) && Array.isArray(inbox.json?.next),
  `HTTP ${inbox.status}: ${inbox.text.slice(0, 200)}`
);
check(
  "the verifier's own verdict reaches nobody else's inbox, and the author's does carry it",
  (await hit(`/api/inbox/${sg.fingerprint(A.pub)}`)).json?.inbox?.some((i) => i.kind === "verdict" && i.sid === SID),
  `the author ${sg.fingerprint(A.pub)} should see the verdicts filed on ${SID}`
);
const inbox2 = await hit(`/api/inbox/${sg.fingerprint(A.pub)}`);
const inbox1 = await hit(`/api/inbox/${sg.fingerprint(A.pub)}`);
check(
  "reading the inbox twice is identical: it is a fold, so nothing is consumed",
  JSON.stringify(inbox1.json?.inbox) === JSON.stringify(inbox2.json?.inbox),
  `${JSON.stringify(inbox1.json?.inbox)?.slice(0, 150)} vs ${JSON.stringify(inbox2.json?.inbox)?.slice(0, 150)}`
);
check(
  "there is no acknowledgement endpoint: a mailbox would be state a clone cannot recompute",
  (await hit("/api/inbox/ack", { method: "POST", body: "{}" })).status === 404,
  "POST /api/inbox/ack answered something other than 404"
);

const html = await hit("/", { headers: { accept: "text/html" } });
check("HTML is served only on request, with no scripts and nothing pulled from the network", html.text.startsWith("<!doctype html") && !/<script/i.test(html.text) && !/\b(?:src|href)\s*=\s*["']https?:/i.test(html.text), html.text.slice(0, 120));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) console.log(fails.map((f) => `  - ${f}`).join("\n"));
console.log(`\nThis run left records in the registry. To undo them there:`);
console.log(`  git -C <registry> log --oneline -4`);
console.log(`  git -C <registry> revert --no-edit <the commits of ${SID}>`);
console.log(`  git -C <registry> status --porcelain    # must come out empty`);
// The attempt is not one of those commits and revert will not touch it: a ref update is
// its own durable write, on purpose. Saying so here is the difference between a clean
// instance and one carrying an acceptance branch nobody can account for.
console.log(`\nAnd the pushed code, which is a ref and NOT a commit, so no revert reaches it:`);
console.log(`  git -C <attempts> update-ref -d ${REF}`);
process.exit(fails.length ? 1 : 0);
