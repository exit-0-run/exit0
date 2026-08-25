#!/usr/bin/env node
// The acceptance suite. Zero dependencies: node:test + node:assert/strict.
//
//   node scripts/test.mjs
//   KEEP=1 node scripts/test.mjs     # keeps the temporary directories to look at
//
// Every run works on a DISPOSABLE COPY of the repo in a temporary directory: its own
// git init, its own server on an ephemeral port (PORT=0). The real repository is only
// ever read here - no test commits into it.
//
// TREE (the path to the copy) and SRV (the server handle) are two different things;
// git/build get TREE, HTTP gets SRV.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, statSync, unlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { request } from "node:http";
import { generateKeyPairSync, sign, createHash } from "node:crypto";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NODE = process.execPath;
// .gitattributes travels with the copy, because without it git rewrites evidence
// bytes and the server drops into read-only mode (D3).
const COPY = ["scripts", "problems", "README.md", "llms.txt", ".gitignore", ".gitattributes", "work.mjs"];
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const EMPTY_SHA16 = "e3b0c44298fc1c14";
// assembled from pieces so this file is not a hit in its own grep
const LEGACY = "open-" + "problems";  // the old name: it has no business surviving anywhere
const CJS = new RegExp("\\brequire\\s*\\(");

const trees = [];
const servers = [];
const say = (s) => console.log("# " + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (x) => createHash("sha256").update(Buffer.isBuffer(x) ? x : Buffer.from(x, "utf8")).digest("hex");

// --- the working copy ---

const git = (dir, ...a) => String(execFileSync("git", a, { cwd: dir, stdio: "pipe" })).trim();
const fromHead = (dir, path) => execFileSync("git", ["show", `HEAD:${path}`], { cwd: dir, stdio: "pipe", maxBuffer: 1 << 28 });

const run = (dir, script, args = [], input) => {
  const r = spawnSync(NODE, [script, ...args], { cwd: dir, input, encoding: "utf8" });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
};
const build = (dir, ...args) => run(dir, "scripts/build.mjs", args);

const mkTree = (label) => {
  const dir = mkdtempSync(join(tmpdir(), `exit0-${label}-`));
  // A missing file has to be reported by a NAMED test, not blow the harness up with a
  // stack out of cpSync - the diagnosis "no .gitattributes" is unreadable that way.
  for (const f of COPY) if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(dir, f), { recursive: true });
  trees.push(dir);
  return dir;
};

// build BEFORE git init: index.json and the README table have to exist before the
// server handles its first request (finding 40).
const seal = (dir) => {
  const b = build(dir);
  if (b.code !== 0) throw new Error(`build.mjs failed in the copy: ${b.err || b.out}`);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@exit0.invalid");
  git(dir, "config", "user.name", "exit0-test");
  git(dir, "config", "commit.gpgsign", "false"); // a global gpgsign would hang the server's commit
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
};

const newTree = (label) => seal(mkTree(label));

// A stand-in `git` on the PATH: it appends a line to a log and hands control to the
// real one. That makes "how many times the read path forks git" a count rather than a
// timing - the same result on every machine and under load.
const gitCounter = (dir) => {
  const bin = join(dir, "gitbin");
  const log = join(dir, "git-calls.log");
  mkdirSync(bin, { recursive: true });
  const real = String(execFileSync("sh", ["-c", "command -v git"])).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
  return {
    bin,
    count: () => (existsSync(log) ? String(readFileSync(log, "utf8")).split("\n").filter(Boolean).length : 0),
  };
};
// The storage-failure tests fake it with chmod 555. Root writes anyway, so instead of
// a red test there would be a test about nothing - we check outright whether chmod
// really blocked the write, and only then assert anything.
const chmodBlocks = (dir) => {
  const p = join(dir, `.probe-perms.${process.pid}`);
  try {
    writeFileSync(p, "");
    unlinkSync(p);
    return false;
  } catch {
    return true;
  }
};

const commits = (dir) => Number(git(dir, "rev-list", "--count", "HEAD"));
const dirty = (dir) => git(dir, "status", "--porcelain", "--", "problems", "README.md", "index.json");
const problemName = (dir, id) => readdirSync(join(dir, "problems")).find((f) => f.startsWith(`${id}-`) && f.endsWith(".json"));
const problemAt = (dir, id) => JSON.parse(String(fromHead(dir, `problems/${problemName(dir, id)}`)));

// --- the server ---

const startServer = async (dir, env = {}) => {
  const child = spawn(NODE, ["scripts/server.mjs"], {
    cwd: dir,
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", IP_CAP: "100000", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const srv = { dir, child, port: 0, out: "", err: "", line: "", why: "" };
  servers.push(srv);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => (srv.out += d));
  child.stderr.on("data", (d) => (srv.err += d));
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const m = /:(\d+)\b/.exec(srv.out);
    if (m && Number(m[1]) > 0) {
      srv.port = Number(m[1]);
      srv.line = srv.out.split("\n")[0];
      return srv;
    }
    if (child.exitCode !== null) break;
    await sleep(20);
  }
  srv.why =
    "the server did not announce a real port: the startup line has to take srv.address().port, not PORT from the env (E1, finding 5). " +
    `stdout=${JSON.stringify(srv.out.slice(0, 300))} stderr=${JSON.stringify(srv.err.slice(0, 400))}`;
  return srv;
};

const stop = async (srv, signal = "SIGTERM") => {
  if (srv.child.exitCode !== null || srv.child.signalCode !== null)
    return { code: srv.child.exitCode, signal: srv.child.signalCode };
  const exited = new Promise((r) => srv.child.once("exit", (code, sig) => r({ code, signal: sig })));
  srv.child.kill(signal);
  const res = await Promise.race([exited, sleep(5000).then(() => null)]);
  if (res) return res;
  srv.child.kill("SIGKILL");
  return await exited;
};

// --- HTTP ---
// Raw node:http rather than fetch: we need the exact request target ("GET //"),
// methods outside fetch's whitelist (TRACE), and a response after which the server
// severs the socket (413).

const HIT_TIMEOUT = 10000;

const hit = (srv, opts = {}) =>
  new Promise((resolve) => {
    const { method = "GET", path = "/", headers = {}, body } = opts;
    const buf = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
    const h = { ...headers };
    if (buf) {
      if (!h["content-type"]) h["content-type"] = "application/json";
      h["content-length"] = String(buf.length);
    }
    let settled = false;
    let timer = null;
    const nothing = (err) => ({ status: 0, headers: {}, raw: Buffer.alloc(0), text: "", json: null, bytes: 0, err });
    const finish = (o) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(o);
    };
    // after the first hang we do not wait on that server a second time
    if (srv.hung) return finish(nothing(srv.hung));
    const req = request({ host: "127.0.0.1", port: srv.port, method, path, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      const end = () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        finish({ status: res.statusCode, headers: res.headers, raw, text, json, bytes: raw.length, err: "" });
      };
      res.on("end", end);
      res.on("aborted", end);
      res.on("error", end);
    });
    req.on("error", (e) => finish(nothing(e.code ?? e.message)));
    // A server that accepts the connection and never answers (an exception in the
    // handler caught by uncaughtException) would hang the whole suite.
    timer = setTimeout(() => {
      req.destroy();
      srv.hung = `${method} ${path}: no answer within ${HIT_TIMEOUT} ms`;
      finish(nothing(srv.hung));
    }, HIT_TIMEOUT);
    if (buf) req.write(buf);
    req.end();
  });

const post = (srv, action, obj, headers) =>
  hit(srv, { method: "POST", path: `/api/${action}`, body: typeof obj === "string" ? obj : JSON.stringify(obj), headers });

const is = (res, code, why) =>
  assert.equal(res.status, code, `${why}: expected ${code}, got ${res.status}${res.err ? ` [${res.err}]` : ""} — ${res.text.slice(0, 400)}`);

// --- identity and signatures ---

const TREE = mkTree("main");
let sg = null;
let sgErr = null;
try {
  sg = await import(pathToFileURL(join(TREE, "scripts/sign.mjs")).href);
} catch (e) {
  sgErr = e;
}

const mkKey = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pub: sg.pubToB64(publicKey), priv: privateKey };
};
const sigOf = (k, msg) => sign(null, Buffer.from(msg, "utf8"), k.priv).toString("base64");
const signBody = (k, action, fields) => ({ ...fields, key: k.pub, sig: sigOf(k, sg.payload(action, fields)) });

// 32 bytes in base64 leave 4 spare bits in the last character — hence several
// different spellings of the same key (finding 18).
const b64alts = (pub) => {
  const raw = Buffer.from(pub, "base64");
  const out = [];
  for (const c of B64) {
    const x = pub.slice(0, 42) + c + "=";
    if (x !== pub && Buffer.from(x, "base64").equals(raw)) out.push(x);
  }
  return out;
};

// replaces defaults to "-": a new submission under (problem, repo, key).
// A correction of your own entry names the sid it is replacing (D1).
const solBody = (k, o) =>
  signBody(k, "solution", {
    problem: o.problem, repo: o.repo, score: o.score,
    model: o.model ?? "?", note: o.note ?? "", replaces: o.replaces ?? "-",
    builds_on: o.builds_on ?? "-", ref: o.ref ?? "-",
  });

// tolerance is SIGNED but not sent: the server takes it from the problem. A body that
// carried it would hide the case "the client signed a different band".
// replaces defaults to "-": this key's first verdict on this solution.
const verBody = (k, o) => {
  const output_sha256 = sha256(o.output);
  const replaces = o.replaces ?? "-";
  // note is signed and sent, and is threaded through BOTH objects deliberately. A helper
  // that drops a signed field does not produce an error - it produces a valid submission
  // with the field silently gone, which is exactly how sign.mjs lost builds_on, ref and
  // subject in turn. Whenever a field is added to a payload, look here.
  const note = o.note ?? "";
  const signed = {
    problem: o.problem, solution: o.solution, score: o.score, verdict: o.verdict,
    output_sha256, tolerance: o.tolerance ?? 0.02, note, replaces,
  };
  return {
    problem: o.problem, solution: o.solution, score: o.score, verdict: o.verdict,
    output_sha256, ...(note ? { note } : {}), replaces, output: o.output,
    key: k.pub, sig: sigOf(k, sg.payload("verification", signed)),
  };
};

// A copy of the CURRENT state of the working tree. The records in it are real, produced
// by the server in this run - we mutate the copy and watch what build.mjs catches.
const snapshotDir = (label) => {
  const dir = mkdtempSync(join(tmpdir(), `exit0-${label}-`));
  for (const f of [...COPY, "index.json"]) cpSync(join(TREE, f), join(dir, f), { recursive: true });
  trees.push(dir);
  return dir;
};

// A verification record built from scratch and TRULY signed, together with its evidence
// file. Needed wherever the structure of the chain is under test: mutating a finished
// record breaks the vid and the signature along the way, so it proves nothing about structure.
const signedVerification = (dir, id, sid, k, o) => {
  const output_sha256 = sha256(o.output);
  const signed = {
    problem: id, solution: sid, score: o.score, verdict: o.verdict,
    output_sha256, tolerance: o.tolerance ?? 0.02, note: o.note ?? "", replaces: o.replaces,
  };
  const evidence = sg.evidencePath(id, output_sha256);
  mkdirSync(join(dir, "problems", "evidence"), { recursive: true });
  writeFileSync(join(dir, evidence), o.output);
  return {
    vid: sg.verificationId(sid, k.pub, output_sha256, o.verdict, o.score, o.replaces),
    verifier: sg.fingerprint(k.pub),
    key: k.pub,
    sig: sigOf(k, sg.payload("verification", signed)),
    score: o.score,
    verdict: o.verdict,
    output_sha256,
    replaces: o.replaces,
    evidence,
    at: "2026-08-23",
  };
};

const probFields = (o = {}) => ({
  title: o.title ?? "Router that picks a model",
  domain: o.domain ?? "routing",
  needs: o.needs ?? [],
  problem: o.problem ?? "A problem statement long enough to pass the minimum-length validation.",
  how: o.how ?? "make eval | tee out.txt (n=500), accuracy >= 0.98",
  metric: o.metric ?? "cost_usd (USD)",
  higher_is_better: o.higher_is_better ?? false,
  baseline: o.baseline ?? null,
  tolerance: o.tolerance ?? 0.02,
  ...(o.subject ? { subject: o.subject } : {}),
});
const probBody = (k, o) => {
  const f = probFields(o);
  return { ...f, key: k.pub, sig: sigOf(k, sg.payload("problem", sg.problemFields(f))) };
};

const idxOf = async (srv) => (await hit(srv, { path: "/api/index.json" })).json;
const idByTitle = async (srv, title) => {
  const idx = await idxOf(srv);
  const p = (idx?.problems ?? []).find((x) => x.title === title);
  assert.ok(p, `no problem ${JSON.stringify(title)} in /api/index.json`);
  return p.id;
};

// a fresh key per problem: the limit is 1 problem per key per day
const newProblem = async (srv, o = {}) => {
  const k = mkKey();
  const f = probFields(o);
  is(await post(srv, "problem", probBody(k, o)), 201, `a new problem ${JSON.stringify(f.title)}`);
  return { id: await idByTitle(srv, f.title), key: k, fields: f };
};

// --- startup ---

say(`repo: ${ROOT}`);
say(`working copy: ${TREE}`);
if (!process.env.KEEP) say("KEEP=1 keeps the temporary directories");

const gate = { sign: sg !== null, server: false };
if (!gate.sign) test("sign.mjs imports", () => assert.fail(`importing ${join(TREE, "scripts/sign.mjs")} failed: ${sgErr}`));

// A startup failure must not kill the whole run: the sign.mjs unit tests usually name
// the cause more precisely than a message out of the build.
let SRV = { port: 0, line: "", why: "sign.mjs did not import" };
if (gate.sign) {
  try {
    seal(TREE);
    SRV = await startServer(TREE);
    gate.server = SRV.port > 0;
  } catch (e) {
    SRV = { port: 0, line: "", why: `preparing the copy failed: ${e.message ?? e}` };
  }
  say(gate.server ? `main server: port ${SRV.port}` : `the main server did NOT start — ${SRV.why.split("\n")[0]}`);
}
if (!gate.server) test("the main server started", () => assert.fail(SRV.why));

after(async () => {
  for (const s of servers) await stop(s, "SIGKILL");
  if (process.env.KEEP) say(`directories left behind: ${trees.join(" ")}`);
  else for (const d of trees) rmSync(d, { recursive: true, force: true });
});

const state = {};

// =====================================================================
// 1. The signature contract — sign.mjs is the only place the payload lives
// =====================================================================

if (gate.sign)
  describe("the signature contract (sign.mjs)", () => {
    test("it exports the whole contract and does not export verifyEntry", () => {
      const wanted = [
        "PREFIX", "MAXLEN", "bad", "keyId", "fp32", "fingerprint", "numToken", "canonUrl", "canonText",
        "canonLine", "assertCanon", "evidenceBytes", "payload", "problemFields", "solutionId",
        "verificationId", "evidencePath", "checkVerification", "fieldBlock", "cell", "solCmp", "check", "pubToB64",
        // replaces is part of the sid, so the token has to be reachable like the
        // rest of the grammar — otherwise a reimplementation computes a different sid
        "replacesT",
      ];
      for (const n of wanted) assert.notEqual(sg[n], undefined, `sign.mjs does not export ${n}`);
      assert.equal(sg.verifyEntry, undefined, "verifyEntry was supposed to be gone (A1/finding 14): no wrapper reconstructs the payload");
    });

    test("PREFIX is exit0/v2, not a trace of the old name", () => {
      assert.equal(sg.PREFIX, "exit0/v2");
      // The bump is the whole point of doing it while nothing is signed: a body signed
      // under the old prefix has to be refused, not quietly accepted because the rest of
      // the string still lines up. PREFIX also feeds solutionId and verificationId, so a
      // v1 signer disagrees about sids too, not only about the signature.
      const F = { problem: "0001", repo: "https://e.example/r", score: 1, model: "m", note: "", replaces: "-" };
      const now = sg.payload("solution", F);
      assert.ok(now.startsWith("exit0/v2|"), "payload still emits the old prefix");
      // The bump only means something if a body signed under the old prefix stops
      // verifying. Everything after the prefix is identical, so nothing but the version
      // is doing the work here - which is exactly what has to be true.
      const k = mkKey();
      const then = now.replace(/^exit0\/v2/, "exit0/v1");
      assert.ok(sg.check(k.pub, sigOf(k, now), now), "a v2 signature has to verify under v2");
      assert.ok(!sg.check(k.pub, sigOf(k, then), now), "a body signed under exit0/v1 still verifies under v2: the bump bought nothing");
      for (const f of readdirSync(join(TREE, "scripts")).filter((x) => x.endsWith(".mjs")))
        assert.ok(!readFileSync(join(TREE, "scripts", f), "utf8").includes(LEGACY), `${f} still knows the old name`);
    });

    test("payload takes an object; the positional form is dead", () => {
      assert.throws(() => sg.payload("solution", "0001", "https://example.com/r", 0.42));
      assert.throws(() => sg.payload("unknown", {}), (e) => e.code === 404);
    });

    test("payload: exact literals for the three actions", () => {
      assert.equal(
        sg.payload("solution", { problem: "0001", repo: "https://example.com/r", score: 0.42, model: "opus-5", note: "", replaces: "-" }),
        "exit0/v2|solution|0001|21:https://example.com/r|0.42|6:opus-5|0:|-|-|-"
      );
      assert.equal(
        sg.payload("solution", { problem: "0001", repo: "https://example.com/r", score: 0.42, model: "opus-5", note: "", replaces: "e2c43b145970c1ef" }),
        "exit0/v2|solution|0001|21:https://example.com/r|0.42|6:opus-5|0:|e2c43b145970c1ef|-|-"
      );
      // replaces and builds_on share a grammar and share nothing else. Pinned together in
      // one literal precisely because the failure mode of this pair is reading one as the
      // other: the left token says what this entry supersedes, the right one says only
      // where its code came from and decides nothing.
      assert.equal(
        sg.payload("solution", { problem: "0001", repo: "https://example.com/r", score: 0.42, model: "opus-5", note: "", replaces: "e2c43b145970c1ef", builds_on: "aaaaaaaaaaaaaaaa" }),
        "exit0/v2|solution|0001|21:https://example.com/r|0.42|6:opus-5|0:|e2c43b145970c1ef|aaaaaaaaaaaaaaaa|-"
      );
      // An attempt that lives as a ref inside a repository rather than as one of its own.
      assert.equal(
        sg.payload("solution", { problem: "0014", repo: "https://github.com/o/r", score: 1, model: "m", note: "", replaces: "-", builds_on: "-", ref: "refs/attempts/0014/abc123def456/semver-scan" }),
        "exit0/v2|solution|0014|22:https://github.com/o/r|1|1:m|0:|-|-|43:refs/attempts/0014/abc123def456/semver-scan"
      );
      // The namespace is only worth something if its shape is enforced. refs/heads is the
      // one that matters: a ref grammar that accepts it turns "publish an attempt" into
      // "write to the branch the registry serves".
      for (const bad of ["refs/heads/main", "refs/attempts/0014/ABCDEF123456/x", "refs/attempts/14/abc123def456/x", "refs/attempts/0014/abc123def456/", "refs/attempts/0014/abc123def456/../x"])
        assert.throws(
          () => sg.payload("solution", { problem: "0014", repo: "https://github.com/o/r", score: 1, model: "m", note: "", replaces: "-", builds_on: "-", ref: bad }),
          (e) => e.code === 400 && /ref/.test(e.message),
          `a ref shaped ${JSON.stringify(bad)} was accepted`
        );
      // In the sid, not only in the payload: two refs under one repo URL are two chains.
      const K = mkKey().pub;
      assert.notEqual(
        sg.solutionId("0014", "https://github.com/o/r", 1, K, "-", "refs/attempts/0014/abc123def456/a"),
        sg.solutionId("0014", "https://github.com/o/r", 1, K, "-", "refs/attempts/0014/abc123def456/b"),
        "two attempts differing only by ref share a sid, so the second would replace the first"
      );
      // Not part of the sid: identity stays a function of state. Two bodies differing only
      // in their claimed origin are ONE entry, so ancestry cannot be relabelled after the
      // fact by re-sending the same result.
      const idArgs = ["0001", "https://example.com/r", 0.42, mkKey().pub, "-", "-"];
      assert.equal(sg.solutionId(...idArgs), sg.solutionId(...idArgs), "solutionId is not deterministic");
      assert.throws(
        () => sg.payload("solution", { problem: "0001", repo: "https://example.com/r", score: 0.42, model: "m", note: "", replaces: "-", builds_on: "nothex" }),
        (e) => e.code === 400 && /builds_on/.test(e.message),
        "a malformed builds_on must be refused, naming builds_on and not replaces"
      );
      assert.equal(
        sg.payload("verification", {
          problem: "0001",
          solution: "e2c43b145970c1ef",
          score: 0.4207,
          verdict: "ok",
          output_sha256: "f5dd2fa8a4792ea0e28e97c380c7ab9f642ff9235e9a183f45d1b754f7160dda",
          tolerance: 0.02,
          replaces: "-",
        }),
        "exit0/v2|verification|0001|e2c43b145970c1ef|0.4207|ok|f5dd2fa8a4792ea0e28e97c380c7ab9f642ff9235e9a183f45d1b754f7160dda|0.02|0:|-"
      );
      assert.equal(
        sg.payload("verification", {
          problem: "0001",
          solution: "e2c43b145970c1ef",
          score: 0.4207,
          verdict: "ok",
          output_sha256: "f5dd2fa8a4792ea0e28e97c380c7ab9f642ff9235e9a183f45d1b754f7160dda",
          tolerance: 0.05,
          replaces: "aaaaaaaaaaaaaaaa",
        }),
        "exit0/v2|verification|0001|e2c43b145970c1ef|0.4207|ok|f5dd2fa8a4792ea0e28e97c380c7ab9f642ff9235e9a183f45d1b754f7160dda|0.05|0:|aaaaaaaaaaaaaaaa"
      );
      assert.equal(
        sg.payload("problem", {
          title: "Router that picks a model",
          problem: "x".repeat(30),
          how: "make eval | tee out.txt (n=500)",
          metric: "cost_usd (USD)",
          higher_is_better: false,
          baseline: null,
          tolerance: 0.02,
          domain: "routing",
          needs: ["api-key"],
        }),
        "exit0/v2|problem|25:Router that picks a model|30:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx|31:make eval | tee out.txt (n=500)|14:cost_usd (USD)|0|-|0.02|routing|api-key|-"
      );
      // The same problem WITH a subject. Two literals, because "absent" and "present" are
      // the two shapes a verifier's signature check has to reproduce byte for byte, and the
      // absent one is a bare "-" while the present one is length-prefixed like every string.
      assert.equal(
        sg.payload("problem", {
          title: "Router that picks a model",
          problem: "x".repeat(30),
          how: "make eval | tee out.txt (n=500)",
          metric: "cost_usd (USD)",
          higher_is_better: false,
          baseline: null,
          tolerance: 0.02,
          domain: "routing",
          needs: ["api-key"],
          subject: "https://github.com/owner/repo",
        }),
        "exit0/v2|problem|25:Router that picks a model|30:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx|31:make eval | tee out.txt (n=500)|14:cost_usd (USD)|0|-|0.02|routing|api-key|29:https://github.com/owner/repo"
      );
      // Canonical or rejected, and the refusal has to name THIS field: canonUrl serves both
      // repo and subject now, and a message about "repo" would send the caller to the wrong
      // line of their body.
      assert.throws(
        () => sg.payload("problem", { title: "T", problem: "x".repeat(30), how: "h", metric: "m", higher_is_better: false, baseline: null, tolerance: 0.02, domain: "infra", needs: [], subject: "https://github.com/owner/repo/" }),
        (e) => e.code === 400 && /subject/.test(e.message) && e.canonical === "https://github.com/owner/repo",
        "a trailing slash must come back as 400 naming subject, with the canonical form"
      );
      assert.throws(
        () => sg.payload("problem", { title: "T", problem: "x".repeat(30), how: "h", metric: "m", higher_is_better: false, baseline: null, tolerance: 0.02, domain: "infra", needs: [], subject: "ftp://example.com/r" }),
        (e) => e.code === 400 && /subject/.test(e.message),
        "a subject that is not http(s)"
      );
      // The drawers are CLOSED sets, and `needs` has to arrive in canonical form:
      // sorting it for the sender would mean two different bodies give one signature.
      const P = { title: "T", problem: "x".repeat(30), how: "h", metric: "m", higher_is_better: false, baseline: null, tolerance: 0.02 };
      // By slot, not by "ends with": needs stopped being the last field the moment subject
      // was appended, and an anchored regex would then be testing the wrong token while
      // still passing for the wrong reason.
      const slots = sg.payload("problem", { ...P, domain: "infra", needs: [] }).split("|");
      assert.equal(slots[slots.length - 2], "-", "empty needs is the token -");
      assert.equal(slots[slots.length - 1], "-", "an absent subject is the token -");
      assert.throws(() => sg.payload("problem", { ...P, domain: "invented", needs: [] }), (e) => e.code === 400, "a domain outside the set");
      assert.throws(() => sg.payload("problem", { ...P, domain: "infra", needs: ["quantum"] }), (e) => e.code === 400, "a need outside the set");
      assert.throws(
        () => sg.payload("problem", { ...P, domain: "infra", needs: ["dataset", "gpu"] }),
        (e) => e.code === 400 && Array.isArray(e.canonical),
        "needs in the wrong order has to give a 400 with the canonical form, not a silent sort"
      );
    });

    // D1: without this token every signed body is valid forever, and key and sig are
    // public in git.
    test("replaces is part of the signature AND part of the sid — the sid is a link in a chain", () => {
      const B = { problem: "0001", repo: "https://example.com/r", score: 0.42, model: "?", note: "" };
      const fresh = sg.payload("solution", { ...B, replaces: "-" });
      assert.notEqual(sg.payload("solution", { ...B, replaces: "a".repeat(16) }), fresh, "a replacement and a new submission have the same payload");
      assert.equal(sg.payload("solution", B), fresh, "a missing field has to mean the same as '-'");
      assert.equal(sg.payload("solution", { ...B, replaces: null }), fresh);
      for (const bad of ["BAD", "a".repeat(15), "A".repeat(16), 7, "0x" + "a".repeat(14)])
        assert.throws(() => sg.payload("solution", { ...B, replaces: bad }), (e) => e.code === 400, `replaces=${String(bad)} should be a 400`);

      // Round 3, D8: a sid computed without replaces RETURNED to the same value when
      // the author went back to an earlier result - and with it every historical body
      // pointing at that state came back to life. The link closes that: identical
      // content after a different state has a different sid, so no state can repeat.
      const k = mkKey();
      const sid = (replaces) => sg.solutionId("0001", B.repo, B.score, k.pub, replaces);
      assert.equal(sid("-"), sid("-"), "the sid has to be deterministic");
      assert.notEqual(sid("a".repeat(16)), sid("-"), "the same content after a different state MUST give a different sid (D8)");
      assert.notEqual(sid("b".repeat(16)), sid("a".repeat(16)));
      assert.equal(sid(undefined), sid("-"), "a missing replaces is the same as '-'");
      assert.throws(() => sid("BAD"), (e) => e.code === 400, "the sid does not accept a replaces outside the grammar");
    });

    test("the framing is injective — delimiter confusion is impossible", () => {
      const p = (o) => sg.payload("problem", sg.problemFields(probFields(o)));
      assert.notEqual(p({ title: "a|b", how: "c" }), p({ title: "a", how: "b|c" }));
      assert.notEqual(p({ title: "3:x" }), p({ title: "x" }));
      assert.notEqual(p({ title: "ab", how: "c" }), p({ title: "a", how: "bc" }));
    });

    test("numToken: the canonical form of a number", () => {
      const t = (n) => sg.payload("solution", { problem: "0001", repo: "https://example.com/r", score: n }).split("|")[4];
      assert.equal(t(0.42), "0.42");
      assert.equal(t(0.4207), "0.4207");
      assert.equal(t(0.4), "0.4");
      assert.equal(t(0.5), "0.5");
      assert.equal(t(1e3), "1000");
      assert.equal(t(1e-7), "0.0000001");
      assert.equal(t(0), "0");
      assert.equal(t(-0), "0");
      assert.equal(t(-1.5), "-1.5");
    });

    test("numToken: it refuses what it cannot reproduce", () => {
      for (const n of [0.1 + 0.2, 1e-10, 2 / 3, 1e15, NaN, Infinity, "0.42", null, undefined]) {
        let code = null;
        try {
          sg.payload("solution", { problem: "0001", repo: "https://example.com/r", score: n });
        } catch (e) {
          code = e.code;
        }
        assert.equal(code, 400, `score=${String(n)} should be refused with code 400`);
      }
    });

    test("canonText destroys neither a command nor paragraphs", () => {
      const H = "make eval | tee out.txt (n=500), accuracy >= 0.98";
      assert.equal(sg.canonText(H, "how", 2000), H, "the canonicaliser eats spaces/commas/parens out of a command (findings 1/19/34)");
      assert.equal(sg.canonText("a b\n\nc", "x", 100), "a b\n\nc");
      assert.equal(sg.canonText("a\n\nb\tc", "x", 100), "a\n\nb c");
      assert.equal(sg.canonText("a\r\nb", "x", 100), "a\nb");
      assert.equal(sg.canonText("  a   b  ", "x", 100), "a b");
      assert.equal(sg.canonText("a\n\n\n\n\nb", "x", 100), "a\n\nb");
      assert.equal(sg.canonText("e\u0301", "x", 100), "\u00e9", "no NFC normalisation");
    });

    // no control character may be a literal here: a literal makes the file binary and
    // gets lost in copying (findings 1/19/34)
    test("canonText strips control and BiDi characters", () => {
      assert.equal(sg.canonText("a\u0000b\u0007c", "x", 100), "abc");
      assert.equal(sg.canonText("a\u202Eb\u2066c", "x", 100), "abc", "a trojan title would reach the renderer");
      assert.equal(sg.canonText("a\u007Fb", "x", 100), "ab");
      assert.equal(sg.canonText("a\u2028b", "x", 100), "ab");
    });

    test("canonLine folds to one line, the limit counted in BYTES", () => {
      assert.equal(sg.canonLine("a\nb", "title", 100), "a b");
      assert.equal(sg.canonLine("  a \n\n b  ", "title", 100), "a b");
      assert.equal(sg.canonLine("\u00f3".repeat(40), "model", sg.MAXLEN.model).length, 40);
      assert.throws(() => sg.canonLine("\u00f3".repeat(41), "model", sg.MAXLEN.model), (e) => e.code === 400, "the limit is counted in characters, not bytes (finding 15)");
    });

    test("canonUrl: one form per resource", () => {
      const c = sg.canonUrl;
      assert.equal(c("https://EXAMPLE.com:443/r"), "https://example.com/r");
      assert.equal(c("https://example.com/r/"), "https://example.com/r");
      assert.equal(c("https://example.com/r?"), "https://example.com/r");
      assert.equal(c("https://example.com/r#frag"), "https://example.com/r");
      assert.equal(c("https://user:password@example.com/r"), "https://example.com/r");
      assert.equal(c("http://example.com:80/r"), "http://example.com/r");
      for (const u of ["https://example.com/r", "https://example.com/", "http://example.com/a/b?q=1"])
        assert.equal(c(c(u)), c(u), `canonUrl is not idempotent for ${u}`);
      for (const bad of ["ftp://example.com/r", "example.com/r", "//example.com/r", "https://", "", "x".repeat(400)])
        assert.throws(() => c(bad), (e) => e.code === 400, `${JSON.stringify(bad.slice(0, 30))} should be refused with code 400`);
    });

    test("assertCanon refuses instead of quietly fixing", () => {
      assert.equal(sg.assertCanon(sg.canonLine, "opus 5", "model", 80), "opus 5");
      assert.throws(() => sg.assertCanon(sg.canonLine, "opus  5", "model", 80), (e) => e.code === 400 && e.canonical === "opus 5");
      assert.throws(() => sg.assertCanon(sg.canonUrl, "https://EXAMPLE.com:443/r", "repo", 300), (e) => e.code === 400 && e.canonical === "https://example.com/r");
    });

    test("keyId collapses every base64 spelling of the same key", () => {
      const k = mkKey();
      const alts = b64alts(k.pub);
      assert.ok(alts.length >= 1, "a 32B key has to have alternative base64 spellings — otherwise this test proves nothing");
      assert.equal(sg.keyId(k.pub), k.pub);
      for (const a of alts) {
        assert.notEqual(a, k.pub);
        assert.equal(sg.keyId(a), k.pub);
        assert.equal(sg.fingerprint(a), sg.fingerprint(k.pub));
      }
      assert.throws(() => sg.keyId(Buffer.alloc(31).toString("base64")), (e) => e.code === 400);
      assert.throws(() => sg.keyId(123), (e) => e.code === 400);
    });

    test("fingerprint is 12 hex and a prefix of fp32", () => {
      const k = mkKey();
      assert.match(sg.fingerprint(k.pub), /^[0-9a-f]{12}$/);
      assert.match(sg.fp32(k.pub), /^[0-9a-f]{64}$/);
      assert.equal(sg.fingerprint(k.pub), sg.fp32(k.pub).slice(0, 12));
    });

    test("evidenceBytes passes the evidence through byte for byte", () => {
      const raw = "a b\n";
      assert.ok(sg.evidenceBytes(raw).equals(Buffer.from(raw, "utf8")), "the evidence is being processed, and it was supposed to be stored byte for byte");
      assert.equal(sg.evidenceBytes("x".repeat(sg.MAXLEN.output)).length, sg.MAXLEN.output);
      for (const bad of ["", "   ", "a\u0000b", "x".repeat(sg.MAXLEN.output + 1), 42])
        assert.throws(() => sg.evidenceBytes(bad), (e) => e.code === 400, `evidenceBytes should refuse ${JSON.stringify(String(bad).slice(0, 20))}`);
    });

    test("checkVerification: the tolerance is RELATIVE and works in both directions", () => {
      const a = mkKey();
      const b = mkKey();
      const p = { acceptance: { tolerance: 0.02 } };
      const q = (sol, v) => sg.checkVerification(p, { key: a.pub, score: sol }, { key: b.pub, ...v });
      assert.equal(q(0.42, { score: 0.4207, verdict: "ok" }), null);
      assert.equal(q(0.42, { score: 0.5, verdict: "ok" }).code, 422);
      assert.equal(q(0.42, { score: 0.4207, verdict: "mismatch" }).code, 422, "a mismatch inside the band is not a dispute but an agreement (anti-grief)");
      assert.equal(q(0.42, { score: 0.9, verdict: "mismatch" }), null);
      assert.equal(q(1000, { score: 1020, verdict: "ok" }), null, "the tolerance has to be scale-free");
      assert.equal(q(0, { score: 0, verdict: "ok" }), null);
      assert.equal(q(0, { score: 0.001, verdict: "ok" }).code, 422);
      for (const v of ["OK", "ok ", "Ok", "", undefined, null, true])
        assert.equal(q(0.42, { score: 0.42, verdict: v }).code, 400, `verdict ${JSON.stringify(v)} has to be a 400`);
    });

    test("checkVerification blocks self-verification through a base64 variant too", () => {
      const a = mkKey();
      const p = { acceptance: { tolerance: 0.02 } };
      assert.equal(sg.checkVerification(p, { key: a.pub, score: 0.42 }, { key: a.pub, score: 0.4207, verdict: "ok" }).code, 403);
      for (const alt of b64alts(a.pub))
        assert.equal(
          sg.checkVerification(p, { key: a.pub, score: 0.42 }, { key: alt, score: 0.4207, verdict: "ok" }).code,
          403,
          "a base64 variant of your own key got past the self-verification guard (finding 18)"
        );
    });

    // D3: the self-verification predicate used to FALL BACK to comparing strings when
    // keyId threw. That was harmless only because the server refused a non-canonical
    // key earlier - which means invariant 3 was standing on somebody else's gate. Now
    // an unreadable key is a named 400, not a silent swap of canonical comparison for
    // string comparison.
    test("an unreadable key is a 400 out of checkVerification, never an exception (D3)", () => {
      const good = mkKey();
      const p = { acceptance: { tolerance: 0.02 } };
      for (const bad of ["AAAA", "", "!!!!", null, 7, Buffer.alloc(31).toString("base64")]) {
        const fromVerifier = sg.checkVerification(p, { key: good.pub, score: 0.42 }, { key: bad, score: 0.42, verdict: "ok" });
        assert.equal(fromVerifier?.code, 400, `a verifier key of ${JSON.stringify(bad)} has to give a 400, it gives ${JSON.stringify(fromVerifier)}`);
        const fromSolution = sg.checkVerification(p, { key: bad, score: 0.42 }, { key: good.pub, score: 0.42, verdict: "ok" });
        assert.equal(fromSolution?.code, 400, `a solution key of ${JSON.stringify(bad)} has to give a 400, it gives ${JSON.stringify(fromSolution)}`);
      }
      // two different unreadable keys must not "agree" through string equality
      assert.equal(sg.checkVerification(p, { key: "AAAA", score: 0.42 }, { key: "AAAA", score: 0.42, verdict: "ok" })?.code, 400);
    });

    // check() has to be false for such a key independently of the above: if somebody
    // loosened b64ToPub, no other test would see it.
    test("a key that makes keyId throw never carries a signature", () => {
      const k = mkKey();
      const msg = "anything";
      const sig = sigOf(k, msg);
      assert.ok(sg.check(k.pub, sig, msg), "positive control: a real key has to verify against itself");
      for (const bad of ["AAAA", "BBBB", "", "x", "!!!!", k.pub.slice(0, 20), Buffer.alloc(31).toString("base64")]) {
        assert.throws(() => sg.keyId(bad), (e) => e.code === 400, `keyId was supposed to refuse ${JSON.stringify(bad)}`);
        assert.equal(
          sg.check(bad, sig, msg),
          false,
          `check() has to be false for a key keyId refused (${JSON.stringify(bad)}) — otherwise a fallback string comparison becomes a way around invariant 3`
        );
      }
    });

    test("sid/vid/evidencePath are derived from the content", () => {
      const a = mkKey();
      const b = mkKey();
      const s1 = sg.solutionId("0001", "https://example.com/r", 0.42, a.pub, "-");
      assert.match(s1, /^[0-9a-f]{16}$/);
      assert.equal(sg.solutionId("0001", "https://EXAMPLE.com:443/r/", 0.42, b64alts(a.pub)[0] ?? a.pub, "-"), s1);
      assert.notEqual(sg.solutionId("0001", "https://example.com/r", 0.43, a.pub, "-"), s1);
      assert.notEqual(sg.solutionId("0001", "https://example.com/r", 0.42, b.pub, "-"), s1);
      assert.notEqual(sg.solutionId("0001", "https://example.com/r", 0.42, a.pub, s1), s1, "the sid has to depend on the state it replaces (D8)");

      const sha = sha256("x");
      const v1 = sg.verificationId(s1, b.pub, sha, "ok", 0.42);
      assert.match(v1, /^[0-9a-f]{16}$/);
      assert.notEqual(sg.verificationId(s1, b.pub, sha, "mismatch", 0.42), v1, "a corrected verdict has to give a different vid, otherwise it lands in a 409");
      assert.notEqual(sg.verificationId(s1, b.pub, sha, "ok", 0.43), v1);

      assert.equal(sg.evidencePath("0001", sha), `problems/evidence/0001-${sha}.txt`);
      assert.throws(() => sg.evidencePath("0001", sha.slice(0, 14)), (e) => e.code === 400, "the evidence path has to take the full 64 hex (finding 23)");
    });

    test("problemFields reads a flat body and a stored file the same way", () => {
      const f = probFields();
      // domain and needs stay at the TOP of the record, not inside acceptance: they are
      // the problem's drawer, not an acceptance condition. A flat body and a stored file
      // have to give the same payload.
      const nested = {
        title: f.title,
        problem: f.problem,
        domain: f.domain,
        needs: f.needs,
        acceptance: { how: f.how, metric: f.metric, higher_is_better: f.higher_is_better, baseline: f.baseline, tolerance: f.tolerance },
      };
      assert.equal(sg.payload("problem", sg.problemFields(nested)), sg.payload("problem", sg.problemFields(f)));
      assert.equal(sg.problemFields({ ...f, tolerance: undefined }).tolerance, 0.02);
    });

    test("a signature round-trips for every action", () => {
      const k = mkKey();
      const cases = [
        ["solution", { problem: "0001", repo: "https://example.com/r", score: 0.42, model: "opus-5", note: "" }],
        ["verification", { problem: "0001", solution: "e2c43b145970c1ef", score: 0.42, verdict: "ok", output_sha256: sha256("x") }],
        ["problem", sg.problemFields(probFields())],
      ];
      for (const [action, f] of cases) {
        const msg = sg.payload(action, f);
        assert.ok(sg.check(k.pub, sigOf(k, msg), msg), `${action}: its own signature does not match`);
        assert.ok(!sg.check(k.pub, sigOf(k, msg), msg + "x"), `${action}: swapped content got through`);
        assert.ok(!sg.check(mkKey().pub, sigOf(k, msg), msg), `${action}: somebody else's key got through`);
      }
    });

    test("fieldBlock/cell/solCmp — the shared render for the server and build.mjs", () => {
      assert.equal(sg.fieldBlock("how", "a\nb"), "      how: a\n      | b");
      for (const line of sg.fieldBlock("how", "a\n[0002] IMPERSONATION").split("\n")) assert.match(line, /^ {6}/);

      // D2: indentation alone is not enough — the record lines "metric:" and
      // "solutions:" sit in THE SAME column as a continuation, so a multi-line `how`
      // impersonated them byte for byte. The marker has to be unreachable for content:
      // after canonText no line begins with a space.
      const impersonation = ["make eval", "solutions: 99 submitted, 99 verified", "metric: whatever (tolerance +/-50%)"].join("\n");
      const lines = sg.fieldBlock("how to check", sg.canonText(impersonation, "how", 2000)).split("\n");
      for (const l of lines.slice(1)) {
        assert.match(l, /^ {6}\| /, `a continuation without a marker: ${JSON.stringify(l)}`);
        assert.doesNotMatch(l, /^ {6}(metric|solutions|how to check):/, `a line of foreign content is passing for a server record: ${JSON.stringify(l)}`);
      }
      assert.equal(sg.canonText("      | pretending to be a marker", "how", 2000), "| pretending to be a marker", "canonicalisation has to strip leading spaces, otherwise the marker is reachable");
      assert.equal(sg.cell("a|b"), "a\\|b");
      const S = (o) => ({ verified: false, disputed: false, score: 1, sid: "0".repeat(16), ...o });
      const down = [S({ score: 5, sid: "a".repeat(16) }), S({ score: 1, verified: true }), S({ score: 2 })].sort(sg.solCmp({ acceptance: { higher_is_better: false } }));
      assert.equal(down[0].verified, true, "verified and undisputed comes first");
      assert.equal(down[1].score, 2, "with higher_is_better=false, ascending");
      const up = [S({ score: 1 }), S({ score: 9 })].sort(sg.solCmp({ acceptance: { higher_is_better: true } }));
      assert.equal(up[0].score, 9);
    });

    // How MANY keys stand behind a verdict is a number the whole registry now prints, so it
    // gets the same scrutiny as the verdict itself. The two ways to get it wrong are to
    // count array entries (a verifier who corrected themselves would pay three times) and to
    // group by the key STRING (invariant 3: 32 bytes have four base64 spellings, so one key
    // would become several confirmations). Both are tested here, on records built by hand:
    // verdictHeads is structural, it reads key/vid/replaces only, so no signature is needed
    // to exercise the shape - and a signature would hide the shape behind its own failure.
    test("verdictStrength counts KEYS at the head of their chain, never records", () => {
      const kA = mkKey();
      const kB = mkKey();
      const rec = (pub, vid, replaces, verdict, score) => ({ key: pub, vid, replaces, verdict, score, at: "2026-08-25" });

      assert.deepEqual(sg.verdictStrength([]), { confirms: 0, disputes: 0, low: null, high: null }, "nothing to count is zero, not a crash");
      assert.deepEqual(sg.verdictStrength(undefined).confirms, 0, "it runs inside build.mjs, where a throw is a crash instead of an error list");

      // ok -> mismatch -> ok: three records, one piece of work, one CURRENT verdict.
      const abc = [
        rec(kA.pub, "a1", "-", "ok", 0.4),
        rec(kA.pub, "a2", "a1", "mismatch", 0.9),
        rec(kA.pub, "a3", "a2", "ok", 0.41),
      ];
      assert.deepEqual(sg.verdictStrength(abc), { confirms: 1, disputes: 0, low: 0.41, high: 0.41 }, "a corrected chain counted more than once: correcting yourself would pay better than checking somebody new");
      // Order in the file is not state (invariant 8): the same records shuffled say the same.
      assert.deepEqual(sg.verdictStrength([abc[2], abc[0], abc[1]]), sg.verdictStrength(abc));

      // The same key in another of its four base64 spellings continues ONE chain. If it were
      // grouped by the string it would open a second chain and read as a second confirmation.
      const [alt] = b64alts(kA.pub);
      assert.ok(alt, "no alternative spelling of this key to test with");
      assert.equal(sg.verdictStrength([...abc, rec(alt, "a4", "a3", "ok", 0.42)]).confirms, 1, "a second spelling of one key became a second confirmation (invariant 3)");

      // Two keys, and they did not measure the same number. The spread is the evidence.
      const two = [...abc, rec(kB.pub, "b1", "-", "mismatch", 0.9)];
      assert.deepEqual(sg.verdictStrength(two), { confirms: 1, disputes: 1, low: 0.41, high: 0.9 });
      assert.equal(sg.verdictStrength([...abc, rec(kB.pub, "b1", "-", "ok", 0.39)]).confirms, 2, "two independent keys are two confirmations");

      // A key outside the grammar has no verifier, so it is skipped rather than counted for
      // somebody - and it must not take the rest of the fold down with it.
      assert.equal(sg.verdictStrength([...abc, rec("not a key", "z1", "-", "ok", 1)]).confirms, 1);
    });
  });

// =====================================================================
// 2. The CLI — the only route an agent will actually run
// =====================================================================

if (gate.sign)
  describe("the sign.mjs CLI", () => {
    const cli = mkTree("cli");
    const pem = join(cli, "identity.pem");
    const sgn = (args, input) => run(cli, "scripts/sign.mjs", args, input);

    test("keygen creates an identity and does NOT overwrite it silently", () => {
      const a = sgn(["keygen"]);
      assert.equal(a.code, 0, a.err);
      assert.ok(existsSync(pem), "keygen did not write identity.pem");
      assert.equal(statSync(pem).mode & 0o777, 0o600);
      const before = readFileSync(pem);
      const b = sgn(["keygen"]);
      assert.notEqual(b.code, 0, "a second keygen has to refuse — that is destroying an account (finding 21)");
      assert.ok(readFileSync(pem).equals(before), "keygen overwrote an existing identity");
      const c = sgn(["keygen", "--force"]);
      assert.equal(c.code, 0, c.err);
      assert.ok(!readFileSync(pem).equals(before), "--force did not replace the key");
      const d = sgn(["keygen", "other.pem"]);
      assert.equal(d.code, 0, d.err);
      assert.ok(existsSync(join(cli, "other.pem")));
    });

    test("whoami prints the fingerprint and the public key", () => {
      const r = sgn(["whoami", "identity.pem"]);
      assert.equal(r.code, 0, r.err);
      const [fp, pub] = r.out.trim().split(/\s+/);
      assert.match(fp, /^[0-9a-f]{12}$/);
      assert.equal(sg.fingerprint(pub), fp);
      assert.equal(sg.keyId(pub), pub, "whoami prints the key in non-canonical base64");
    });

    // sign.mjs IS the reference implementation of the contract, so a field it drops is a
    // field that does not exist in practice. And dropping is silent by construction: the
    // signature is computed from the object the CLI assembled, so a missing field still
    // verifies. The submission lands, and the author's lineage and published ref are
    // simply gone. This was real, caught while filing the first attempt by hand.
    // The band is signed and NOT sent, so it is the one field where the two halves can
    // drift apart in silence: the printed body verifies locally and only the server
    // disagrees, with a 403 that costs an attempt against the address budget.
    // This survived 182 green tests because NOTHING in the suite, and nothing in
    // acceptance.mjs, ever signed a verification through cli(). Both build the payload by
    // hand. The suite was testing the library while the documentation described the CLI.
    test("sign verification signs the band it was GIVEN, not the default", () => {
      for (const tol of [0, 0.15, 0.5]) {
        const req = { problem: "0014", solution: "e2c43b145970c1ef", score: 65.41, verdict: "ok", output: "x", tolerance: tol };
        const r = sgn(["sign", "identity.pem", "verification", JSON.stringify(req)]);
        assert.equal(r.code, 0, r.err);
        // Both sides. Asserting only "the payload contains the band" passes on the broken
        // code whenever the caller happens to pass 0.02, which is how this got through.
        assert.match(r.err, new RegExp(`\\\\|${String(tol).replace(".", "\\\\.")}\\\\|`), `the CLI did not sign the band it was given (${tol})`);
        if (tol !== 0.02) assert.ok(!/\|0\.02\|/.test(r.err), `the CLI signed the default instead of ${tol}`);
        // ...and the body must still not carry it: signed and not sent, both true at once.
        assert.ok(!("tolerance" in JSON.parse(r.out)), "tolerance reached the wire body");
      }
      // A caller who names no band still signs the default, so nothing existing changes.
      const bare = sgn(["sign", "identity.pem", "verification", JSON.stringify({ problem: "0014", solution: "e2c43b145970c1ef", score: 1, verdict: "ok", output: "x" })]);
      assert.equal(bare.code, 0, bare.err);
      assert.match(bare.err, /\|0\.02\|/, "an absent band no longer signs the documented default");
      // Out of range is a refusal, never a silent clamp back to the default.
      const wide = sgn(["sign", "identity.pem", "verification", JSON.stringify({ problem: "0014", solution: "e2c43b145970c1ef", score: 1, verdict: "ok", output: "x", tolerance: 0.9 })]);
      assert.notEqual(wide.code, 0, "a band outside [0, 0.5] was accepted");
    });

    test("sign carries every signed field, including the ones added last", () => {
      const REF = "refs/attempts/0014/d8f819414c0b/semver-scan";
      const req = { problem: "0014", repo: "https://example.com/r", score: 1, builds_on: "e2c43b145970c1ef", ref: REF };
      const r = sgn(["sign", "identity.pem", "solution", JSON.stringify(req)]);
      assert.equal(r.code, 0, r.err);
      const body = JSON.parse(r.out);
      assert.equal(body.builds_on, "e2c43b145970c1ef", "the CLI dropped builds_on");
      assert.equal(body.ref, REF, "the CLI dropped ref");
      assert.ok(sg.check(body.key, body.sig, sg.payload("solution", body)), "the signature does not cover the printed body");
      // The payload has to actually carry them, or the body and the signature agree on
      // nothing while still verifying.
      const msg = sg.payload("solution", body);
      assert.ok(msg.endsWith(`|e2c43b145970c1ef|${REF.length}:${REF}`), `the payload tail is wrong: ${msg.slice(-90)}`);
      // Defaults stay "-" and stay present: an absent key and the token "-" are two
      // different bodies, and only one of them is what everybody else signs.
      const bare = JSON.parse(sgn(["sign", "identity.pem", "solution", JSON.stringify({ problem: "0014", repo: "https://example.com/r", score: 1 })]).out);
      assert.equal(bare.builds_on, "-");
      assert.equal(bare.ref, "-");
      // The CLI is a subprocess: it exits non-zero, it does not throw into this process.
      const heads = sgn(["sign", "identity.pem", "solution", JSON.stringify({ ...req, ref: "refs/heads/main" })]);
      assert.notEqual(heads.code, 0, "the CLI signed a ref outside the attempts namespace");
      assert.match(heads.err, /ref/, `the refusal has to name ref: ${heads.err.slice(0, 200)}`);
    });

    test("sign prints the COMPLETE POST body and canonicalises on the client side", () => {
      const req = { problem: "0001", repo: "https://EXAMPLE.com:443/r/", score: 0.42, model: "opus  5" };
      const r = sgn(["sign", "identity.pem", "solution", JSON.stringify(req)]);
      assert.equal(r.code, 0, r.err);
      const body = JSON.parse(r.out);
      assert.equal(body.repo, "https://example.com/r", "the CLI does not canonicalise repo, so a CLI user will get a 400 from the server");
      assert.equal(body.model, "opus 5");
      assert.ok(body.key && body.sig, "a body without key/sig cannot be sent with curl");
      assert.ok(sg.check(body.key, body.sig, sg.payload("solution", body)), "the signature does not cover the printed body");
      assert.match(r.err, /^fixed |\nfixed /m, "stderr has to say what the CLI changed");
      assert.doesNotMatch(r.out, /^fixed |\nfixed /m, "stdout has to stay clean JSON for a pipe");
    });

    test("sign verification computes output_sha256 by itself", () => {
      const out = '{"accuracy":0.981,"cost_usd":0.4207,"n":500}\n';
      const r = sgn(["sign", "identity.pem", "verification", JSON.stringify({ problem: "0001", solution: "e2c43b145970c1ef", score: 0.4207, verdict: "ok", output: out })]);
      assert.equal(r.code, 0, r.err);
      const body = JSON.parse(r.out);
      assert.equal(body.output, out, "the raw output has to stay in the body");
      assert.equal(body.output_sha256, sha256(out));
      assert.ok(sg.check(body.key, body.sig, sg.payload("verification", body)));
    });

    test("sign reads the body from @file and from stdin", () => {
      const req = JSON.stringify({ problem: "0001", repo: "https://example.com/r", score: 0.42, model: "?" });
      writeFileSync(join(cli, "body.json"), req);
      const a = sgn(["sign", "identity.pem", "solution", "@body.json"]);
      assert.equal(a.code, 0, a.err);
      const b = sgn(["sign", "identity.pem", "solution", "-"], req);
      assert.equal(b.code, 0, b.err);
      assert.equal(JSON.parse(a.out).sig, JSON.parse(b.out).sig);
    });

    // Round 4. claim is two writes, and the problem limit is ONE per key per day. When
    // the second write failed, the first had already gone in: the caller was left
    // holding a problem they were never told about, with their whole daily problem
    // budget spent, and a message that named neither. Retrying the same command the
    // next minute fails at the first step with a 429 and no explanation.
    test("a half-finished claim says the problem is open and how to continue", async () => {
      const srv = await startServer(newTree("claim-half"));
      assert.ok(srv.port, srv.why);
      const dir = mkTree("claim-half-cli");
      assert.equal(run(dir, "scripts/sign.mjs", ["keygen"]).code, 0);
      // score 0.1 + 0.2 is outside the numToken grammar, so the problem write goes in
      // and the solution write is refused: exactly the half-finished case.
      const body = JSON.stringify({
        title: "A claim that dies halfway",
        problem: "A problem statement long enough to pass the minimum-length validation.",
        how: "make eval | tee out.txt (n=500)",
        metric: "cost_usd (USD)",
        domain: "infra",
        needs: [],
        repo: "https://example.com/half",
        score: 0.1 + 0.2,
      });
      const r = run(dir, "scripts/sign.mjs", ["claim", "identity.pem", `http://127.0.0.1:${srv.port}`, body]);
      assert.notEqual(r.code, 0, "a claim whose solution was refused must not report success");
      const id = (r.err.match(/problem (\d{4})/) ?? [])[1];
      assert.ok(id, `the failure has to name the problem that is now open: ${JSON.stringify(r.err.slice(0, 400))}`);
      assert.match(r.err, /sign\.mjs sign/, "the failure has to hand over the exact command that files the solution against it");
      assert.match(r.err, /1 problem|per day|budget/i, "the failure has to say the daily problem budget is spent");
      is(await hit(srv, { path: `/${id}` }), 200, "the problem really is open in the registry");
      await stop(srv, "SIGKILL");
    });

    test("the old positional form does not work", () => {
      const r = sgn(["sign", "identity.pem", "solution", "0001", "https://example.com/r", "0.42"]);
      assert.notEqual(r.code, 0, "the positional form from llms.txt/QUICKSTART was supposed to be gone (A6)");
    });
  });

// =====================================================================
// 3. The four paths from CLAUDE.md
// =====================================================================

if (gate.server)
  describe("the four paths from CLAUDE.md", () => {
    const kA = mkKey();
    const kB = mkKey();
    const repo = "https://example.com/four";
    const output = '{"accuracy":0.981,"cost_usd":0.4207,"n":500}\n';

    test("1/4 a signed submission -> 201, the sid in the body, the entry in git", async () => {
      const c0 = commits(TREE);
      const r = await post(SRV, "solution", solBody(kA, { problem: "0001", repo, score: 0.42, model: "opus-5" }));
      is(r, 201, "submitting a solution");
      assert.match(r.json?.sid ?? "", /^[0-9a-f]{16}$/, "a 201 has to return the sid — otherwise a verification cannot be addressed");
      assert.equal(r.json.sid, sg.solutionId("0001", repo, 0.42, kA.pub, "-"));
      state.sid = r.json.sid;
      assert.equal(commits(TREE), c0 + 1, "an accepted write is a commit");
      const s = problemAt(TREE, "0001").solutions.find((x) => x.sid === state.sid);
      assert.ok(s, "the solution is not in HEAD");
      assert.equal(s.author, sg.fingerprint(kA.pub), "author has to be derived from the key (invariant 4)");
      assert.equal(s.verified, false, "a fresh submission is not verified");
      assert.deepEqual(s.verifications, []);
      assert.equal(dirty(TREE), "", "after a commit the tree has to be clean");
      assert.equal(build(TREE, "--check").code, 0);
    });

    test("2/4 self-verification under the same key -> 403, zero commits", async () => {
      const c0 = commits(TREE);
      const r = await post(SRV, "verification", verBody(kA, { problem: "0001", solution: state.sid, score: 0.4207, verdict: "ok", output }));
      is(r, 403, "self-verification");
      assert.match(JSON.stringify(r.json), /your own|yourself/i, "the 403 has to name the reason, not just refuse");
      assert.equal(commits(TREE), c0);
      assert.equal(dirty(TREE), "");
    });

    test("3/4 a verification under a foreign key -> 201, the evidence in git", async () => {
      const c0 = commits(TREE);
      const r = await post(SRV, "verification", verBody(kB, { problem: "0001", solution: state.sid, score: 0.4207, verdict: "ok", output }));
      is(r, 201, "a verification under a foreign key");
      assert.equal(commits(TREE), c0 + 1);
      const s = problemAt(TREE, "0001").solutions.find((x) => x.sid === state.sid);
      assert.equal(s.verified, true);
      assert.equal(s.disputed, false);
      assert.equal(s.verified_by, sg.fingerprint(kB.pub));
      assert.equal(s.verifications.length, 1);
      const v = s.verifications[0];
      assert.equal(v.output_sha256, sha256(output));
      assert.equal(v.evidence, sg.evidencePath("0001", v.output_sha256));
      const blob = fromHead(TREE, v.evidence);
      assert.ok(blob.equals(Buffer.from(output, "utf8")), "the evidence in git is not byte for byte what arrived (B9/B10)");
      assert.equal(sha256(blob), v.output_sha256);
      assert.equal(build(TREE, "--check").code, 0);
    });

    test("4/4 a score swapped after signing -> 403, zero commits", async () => {
      const c0 = commits(TREE);
      const body = solBody(kA, { problem: "0001", repo: "https://example.com/swap", score: 0.42 });
      const r = await post(SRV, "solution", { ...body, score: 0.5 });
      is(r, 403, "a swapped score");
      assert.ok(r.json?.expected_payload, "a 403 has to show the string the server verified (C4) — otherwise the error is unguessable");
      assert.equal(commits(TREE), c0);
      assert.equal(dirty(TREE), "");
    });
  });

// =====================================================================
// 4. Input: canonicalisation, signatures, the taxonomy of errors
// =====================================================================

if (gate.server)
  describe("input and the taxonomy of errors", () => {
    test("an unsigned write -> 401", async () => {
      const c0 = commits(TREE);
      is(await post(SRV, "solution", { problem: "0001", repo: "https://example.com/x", score: 0.42 }), 401, "no key/sig");
      assert.equal(commits(TREE), c0);
    });

    test("a body that is not a JSON object -> 400/401, never 500", async () => {
      const c0 = commits(TREE);
      for (const [body, code] of [["this is not json", 400], ["[]", 400], ['"text"', 400], ["null", 400], ["123", 400], ["", 401]])
        is(await post(SRV, "solution", body), code, `body ${JSON.stringify(body.slice(0, 20))}`);
      is(await post(SRV, "solution", { key: 123, sig: 456 }), 400, "key and sig as numbers");
      assert.equal(commits(TREE), c0);
      assert.equal(dirty(TREE), "");
    });

    test("a key in non-canonical base64 -> 400 carrying the canonical form", async () => {
      const k = mkKey();
      const alt = b64alts(k.pub)[0];
      assert.ok(alt, "no base64 variant available for the test");
      const body = solBody(k, { problem: "0001", repo: "https://example.com/altkey", score: 0.42 });
      const r = await post(SRV, "solution", { ...body, key: alt });
      is(r, 400, "a non-canonical key");
      assert.equal(r.json?.canonical, k.pub, "the 400 has to carry the canonical form of the key");
    });

    test("a non-canonical repo -> 400 with a hint, NOT a silent fix and NOT a 403", async () => {
      const k = mkKey();
      const c0 = commits(TREE);
      const canon = "https://example.com/noncanon";
      const body = signBody(k, "solution", { problem: "0001", repo: canon, score: 0.42, model: "?", note: "" });
      const r = await post(SRV, "solution", { ...body, repo: "https://EXAMPLE.com:443/noncanon/" });
      is(r, 400, "a non-canonical repo");
      assert.equal(r.json?.canonical, canon, "validation has to come BEFORE the signature and state the reason (finding C10)");
      assert.equal(commits(TREE), c0);
      assert.ok(!problemAt(TREE, "0001").solutions.some((s) => s.repo.includes("EXAMPLE")), "the server stored a non-canonical value");
    });

    test("a score outside the numToken grammar -> 400", async () => {
      const k = mkKey();
      const body = solBody(k, { problem: "0001", repo: "https://example.com/gram", score: 0.42 });
      is(await post(SRV, "solution", { ...body, score: 0.1 + 0.2 }), 400, "a score that cannot be reproduced");
      is(await post(SRV, "solution", { ...body, score: "0.42" }), 400, "a score as a string");
      is(await post(SRV, "solution", { ...body, score: null }), 400, "a score as null");
    });

    test("an unknown problem -> 4xx, no litter on disk", async () => {
      const c0 = commits(TREE);
      const r = await post(SRV, "solution", solBody(mkKey(), { problem: "9999", repo: "https://example.com/missing", score: 0.42 }));
      assert.ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
      assert.equal(commits(TREE), c0);
      assert.equal(dirty(TREE), "", "a rejected write left litter behind (B4/C2)");
      assert.equal(build(TREE, "--check").code, 0);
    });

    test("actions off the prototype -> 404 and not one commit", async () => {
      const c0 = commits(TREE);
      for (const a of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"]) {
        const r = await post(SRV, a, { key: "AAAA", sig: "BBBB" });
        is(r, 404, `POST /api/${a}`);
        assert.ok(Array.isArray(r.json?.paths), "a 404 has to be a signpost, not a dead end");
      }
      assert.equal(commits(TREE), c0, "POST /api/constructor reached commit() (B6)");
      assert.equal(dirty(TREE), "");
    });

    test("a verdict outside {ok,mismatch} -> 400", async () => {
      const kS = mkKey();
      const kV = mkKey();
      const s = await post(SRV, "solution", solBody(kS, { problem: "0001", repo: "https://example.com/verdict", score: 0.42 }));
      is(s, 201, "a solution for the verdict test");
      state.verdictSid = s.json.sid;
      // sign a correct verdict and swap it in flight: payload() will not sign a value
      // outside the grammar, so there is no other way to build this case
      const good = verBody(kV, { problem: "0001", solution: state.verdictSid, score: 0.42, verdict: "ok", output: "out\n" });
      for (const v of ["OK", "ok ", "yes", "", 1, null])
        is(await post(SRV, "verification", { ...good, verdict: v }), 400, `verdict ${JSON.stringify(v)}`);
      const missing = { ...good };
      delete missing.verdict;
      is(await post(SRV, "verification", missing), 400, "a missing verdict — a silent dispute is worse than a refusal");
    });

    test("a verification with no sid -> 400 (addressed by sid, not by repo)", async () => {
      const b = verBody(mkKey(), { problem: "0001", solution: state.verdictSid, score: 0.42, verdict: "ok", output: "o\n" });
      delete b.solution;
      is(await post(SRV, "verification", { ...b, repo: "https://example.com/verdict" }), 400, "a verification addressed by repo");
    });

    test("an ok outside the band -> 422, a mismatch INSIDE the band -> 422 (anti-grief)", async () => {
      const a = await post(SRV, "verification", verBody(mkKey(), { problem: "0001", solution: state.verdictSid, score: 0.5, verdict: "ok", output: "a\n" }));
      is(a, 422, "an ok outside the band");
      const b = await post(SRV, "verification", verBody(mkKey(), { problem: "0001", solution: state.verdictSid, score: 0.4207, verdict: "mismatch", output: "b\n" }));
      is(b, 422, "a mismatch inside the band");
    });

    test("output that disagrees with output_sha256 -> rejected", async () => {
      const c0 = commits(TREE);
      const b = verBody(mkKey(), { problem: "0001", solution: state.verdictSid, score: 0.42, verdict: "ok", output: "real\n" });
      const r = await post(SRV, "verification", { ...b, output: "swapped\n" });
      assert.ok(r.status >= 400, `the signed digest does not match the evidence, and the server answered ${r.status}`);
      assert.equal(commits(TREE), c0);
      assert.equal(dirty(TREE), "");
    });

    test("a verification with no raw output -> 400", async () => {
      const b = verBody(mkKey(), { problem: "0001", solution: state.verdictSid, score: 0.42, verdict: "ok", output: "x\n" });
      delete b.output;
      is(await post(SRV, "verification", b), 400, "no output");
    });

    test("a body over 128KB -> 413 with readable content, not a severed socket", async () => {
      const r = await post(SRV, "solution", JSON.stringify({ key: "x".repeat(200 * 1024) }));
      is(r, 413, "a body over the limit");
      assert.ok(r.json?.error, "a 413 has to have a readable body (today: curl exit 52)");
    });

    test("evidence of exactly 32768B passes, 32769B does not", async () => {
      const s = await post(SRV, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/output-limit", score: 0.42 }));
      is(s, 201, "a solution for the output limit");
      is(await post(SRV, "verification", verBody(mkKey(), { problem: "0001", solution: s.json.sid, score: 0.42, verdict: "ok", output: "y".repeat(sg.MAXLEN.output) })), 201, "the largest legal piece of evidence");
      is(await post(SRV, "verification", verBody(mkKey(), { problem: "0001", solution: s.json.sid, score: 0.42, verdict: "ok", output: "y".repeat(sg.MAXLEN.output + 1) })), 400, "evidence one byte too large");
    });

    // D6: llms.txt is a NORMATIVE document. It promised a gate on "an executable how"
    // and printed its own counterexample, which the server accepts with a 201.
    test("how: empty is rejected, non-executable is accepted — and the documentation says the same", async () => {
      is(await post(SRV, "problem", probBody(mkKey(), { title: "A problem with no how", how: "" })), 400, "an empty how");

      const counterexample = "Build a good router";
      const ok = await post(SRV, "problem", probBody(mkKey(), { title: "A router better than the current one", how: counterexample, metric: "quality", higher_is_better: true }));
      is(ok, 201, "the server does NOT judge whether how is executable — if that changes, change llms.txt too");

      const llms = readFileSync(join(ROOT, "llms.txt"), "utf8");
      const section = llms.slice(llms.indexOf("## What the server enforces"));
      assert.ok(section, "llms.txt has no section about what the server enforces");
      assert.ok(!section.includes('A problem without an executable "how" is rejected'), "llms.txt promises a gate the server does not have (D6)");
      for (const l of section.split("\n").filter((x) => x.startsWith("- ") && x.includes("how")))
        assert.doesNotMatch(l, /executabl\w*\s+"?how"?\s+is\s+rejected/i, `llms.txt promises a gate that does not exist: ${l.trim()}`);
      assert.ok(section.includes(counterexample), "the counterexample has to stay, but as a norm for authors, not as a promise by the server");
    });

    test("GET on a write path -> 405 with allow", async () => {
      const r = await hit(SRV, { path: "/api/solution" });
      is(r, 405, "GET /api/solution");
      assert.match(String(r.headers.allow ?? ""), /POST/);
    });
  });

// =====================================================================
// 5. Derived state: disputes, resubmissions, a dead problem
// =====================================================================

if (gate.server)
  // The caveat rides WITH the verdict. Two independent verifiers walked problem 0014 and
  // both reported the same hole: the record that flips a problem to `solved` could not say
  // what it was asserting, and the only escape hatch (a finding) changes nothing AND needs
  // standing the verifier earns from that very write - so the qualification could only ever
  // arrive after the status it qualifies.
  describe("a verdict can say what it was asserting", () => {
    const kA = mkKey(), kB = mkKey();
    const state = {};
    const output = '{"speedup":72.485,"mismatches":0}\n';

    test("the note is signed, stored and shown next to the verdict", async () => {
      const P = await newProblem(SRV, { title: "A problem where a verdict needs a caveat" });
      state.P = P.id;
      const r = await post(SRV, "solution", solBody(kA, { problem: P.id, repo: "https://example.com/caveat", score: 72.4 }));
      is(r, 201, "the solution");
      state.sid = r.json.sid;

      const note = "whole-corpus reading; the accepts-only ratio is 3.1 and I did not use it";
      const v = await post(SRV, "verification", verBody(kB, { problem: P.id, solution: state.sid, score: 72.485, verdict: "ok", output, note }));
      is(v, 201, "a verdict carrying its own conditions");
      const sol = problemAt(TREE, P.id).solutions.find((x) => x.sid === state.sid);
      assert.equal(sol.verifications[0].note, note, "the note did not survive into git");
      assert.equal(sol.settled, true);

      const page = await hit(SRV, { path: `/${P.id}`, headers: { accept: "text/plain" } });
      assert.ok(page.text.includes(note), "the problem page shows a verdict without the conditions it was reached under");
      assert.equal(build(TREE, "--check").code, 0);
    });

    test("an empty note is the normal case and costs one byte", async () => {
      const P = await newProblem(SRV, { title: "A problem where the verdict needs no caveat" });
      const r = await post(SRV, "solution", solBody(kA, { problem: P.id, repo: "https://example.com/plain", score: 1 }));
      is(r, 201, "the solution");
      const v = await post(SRV, "verification", verBody(kB, { problem: P.id, solution: r.json.sid, score: 1, verdict: "ok", output }));
      is(v, 201, "a verdict with no note");
      const sol = problemAt(TREE, P.id).solutions.find((x) => x.sid === r.json.sid);
      assert.ok(!("note" in sol.verifications[0]), "an empty note was stored instead of omitted");
      assert.match(sg.payload("verification", { problem: P.id, solution: r.json.sid, score: 1, verdict: "ok", output_sha256: sha256(output), tolerance: 0.02, replaces: "-" }), /\|0:\|-$/);
      assert.equal(build(TREE, "--check").code, 0);
    });

    test("the note is covered by the signature: editing it in the file fails --check", () => {
      const dir = snapshotDir("verdict-note");
      const path = join(dir, "problems", readdirSync(join(dir, "problems")).find((f) => f.startsWith(`${state.P}-`)));
      const p = JSON.parse(readFileSync(path, "utf8"));
      p.solutions[0].verifications[0].note = "a different claim entirely";
      writeFileSync(path, JSON.stringify(p, null, 2) + "\n");
      const r = build(dir, "--check");
      assert.notEqual(r.code, 0, "a rewritten verdict note passed validation, so the caveat is not actually signed");
      // stderr, not stdout: build.mjs prints the error list there. Matching r.out alone
      // reported "expected a signature failure, got: " with nothing after the colon.
      assert.match(r.err + r.out, /signature does not match/, `the build failed, but not on the verdict's signature - that proves nothing: ${(r.err + r.out).slice(0, 300)}`);
    });
  });

  describe("disputes, resubmissions and derived state", () => {
    test("a dispute is not a veto: N griefers are answered by N+1 honest ones", async () => {
      const P = await newProblem(SRV, { title: "A problem for the dispute test" });
      const kA = mkKey();
      const sol = await post(SRV, "solution", solBody(kA, { problem: P.id, repo: "https://example.com/dispute", score: 0.42 }));
      is(sol, 201, "a solution to dispute");
      const sid = sol.json.sid;
      const at = () => problemAt(TREE, P.id).solutions.find((x) => x.sid === sid);

      is(await post(SRV, "verification", verBody(mkKey(), { problem: P.id, solution: sid, score: 0.4207, verdict: "ok", output: "ok-b\n" })), 201, "an ok from a foreign key");
      assert.equal(at().verified, true);
      assert.equal(at().disputed, false);
      assert.equal(at().settled, true);
      assert.equal(problemAt(TREE, P.id).status, "solved");

      is(await post(SRV, "verification", verBody(mkKey(), { problem: P.id, solution: sid, score: 0.9, verdict: "mismatch", output: "mismatch-c\n" })), 201, "a mismatch from a griefer");
      assert.equal(at().verified, true, "the one ok still stands");
      assert.equal(at().disputed, true, "the dispute has to be visible");
      assert.equal(at().settled, false, "1 ok against 1 mismatch is not settled");
      assert.notEqual(problemAt(TREE, P.id).status, "solved", "a problem with a disputed result is not SOLVED");

      is(await post(SRV, "verification", verBody(mkKey(), { problem: P.id, solution: sid, score: 0.42, verdict: "ok", output: "ok-d\n" })), 201, "a second ok answers the dispute");
      assert.equal(at().settled, true, "2 ok against 1 mismatch = settled");
      assert.equal(at().disputed, true, "the dispute stays in the history");
      assert.equal(problemAt(TREE, P.id).status, "solved");
      assert.equal(at().verifications.length, 3, "verifications is append-only");
      assert.equal(build(TREE, "--check").code, 0);
    });

    // D1: correcting your own verdict is a LINK, not an append at the end of an array.
    // Before this change the last record in the file was the one that counted, so
    // reordering two correctly signed records in a pull request changed the status of a
    // problem while --check stayed green, because each record on its own was fine.
    test("the same key may correct its verdict — the correction names the entry it replaces", async () => {
      const P = await newProblem(SRV, { title: "A problem for the verdict correction" });
      const kB = mkKey();
      const s = await post(SRV, "solution", solBody(mkKey(), { problem: P.id, repo: "https://example.com/correction", score: 0.42 }));
      is(s, 201, "a solution to correct against");
      const v1 = await post(SRV, "verification", verBody(kB, { problem: P.id, solution: s.json.sid, score: 0.4207, verdict: "ok", output: "one\n" }));
      is(v1, 201, "ok");

      const withoutReplaces = await post(SRV, "verification", verBody(kB, { problem: P.id, solution: s.json.sid, score: 0.9, verdict: "mismatch", output: "two\n" }));
      is(withoutReplaces, 409, "a correction without replaces has to name its own verdict, the one it supersedes");
      assert.equal(withoutReplaces.json?.replaces, v1.json.vid, "the 409 has to carry the vid to sign");

      is(
        await post(SRV, "verification", verBody(kB, { problem: P.id, solution: s.json.sid, score: 0.9, verdict: "mismatch", output: "two\n", replaces: v1.json.vid })),
        201,
        "a correction under the same key"
      );
      const sol = problemAt(TREE, P.id).solutions.find((x) => x.sid === s.json.sid);
      assert.equal(sol.verifications.length, 2, "both entries stay on disk");
      assert.equal(sol.verified, false, "what counts is the HEAD of that key's chain");
      assert.equal(sol.disputed, true);
      assert.equal(sol.settled, false);
      assert.equal(problemAt(TREE, P.id).status, "in-progress");

      // The actual claim of D1: the order of records in the file stopped meaning
      // anything. BEFORE the change this same move flipped verified from false to true
      // while --check stayed green, because every record on its own was correctly signed.
      const dir = snapshotDir("chain-order");
      const f = join(dir, "problems", problemName(dir, P.id));
      const p = JSON.parse(readFileSync(f, "utf8"));
      p.solutions.find((x) => x.sid === s.json.sid).verifications.reverse();
      writeFileSync(f, JSON.stringify(p, null, 2) + "\n");
      // A full run, not --check: reordering changes the order in index.json, so --check
      // would report a file mismatch. The question is whether it changes the STATE.
      const r = build(dir);
      assert.equal(r.code, 0, `reordering correct records has to be meaningless, not an error: ${r.err || r.out}`);
      const result = JSON.parse(readFileSync(f, "utf8")).solutions.find((x) => x.sid === s.json.sid);
      assert.equal(result.verified, false, "after reordering the records the verdict MUST stay the same (D1)");
      assert.equal(result.disputed, true);
      assert.equal(result.settled, false);
      assert.equal(JSON.parse(readFileSync(f, "utf8")).status, "in-progress", "reordering records has no business touching the problem's status");
    });

    // Mutating the `replaces` field of a finished record does NOT exercise the chain
    // check: replaces feeds both the vid and the signature, so such a file would fail
    // on both before anyone looked at the structure. That is why the records below are
    // built from scratch and TRULY signed - the only thing broken about them is their
    // position in the chain.
    //
    // A loop in the chain cannot be built here, and that is not an oversight: the vid is
    // computed from replaces, so closing a cycle would require a sha256 fixed point. The
    // structure rules that case out more firmly than any test could.
    test("the verdict chain: a foreign link, a second root and a fork do not pass (D1)", async () => {
      const P = await newProblem(SRV, { title: "A problem for the verdict chain" });
      const kB = mkKey();
      const s = await post(SRV, "solution", solBody(mkKey(), { problem: P.id, repo: "https://example.com/chain", score: 0.42 }));
      is(s, 201, "a solution for the chain");
      const sid = s.json.sid;
      const v1 = await post(SRV, "verification", verBody(kB, { problem: P.id, solution: sid, score: 0.42, verdict: "ok", output: "l1\n" }));
      is(v1, 201, "the first verdict");

      // The positive control lives in the correction test: ONE record after v1 is a
      // valid chain. Below are three shapes that are not.
      for (const [label, appended, pattern] of [
        ["foreign link", ["f".repeat(16)], /no such record/],
        ["second root", ["-"], /more than one record/],
        ["fork", [v1.json.vid, v1.json.vid], /two records replace the same/],
      ]) {
        const dir = snapshotDir(`chain-${label.split(" ")[0]}`);
        const f = join(dir, "problems", problemName(dir, P.id));
        const p = JSON.parse(readFileSync(f, "utf8"));
        const target = p.solutions.find((x) => x.sid === sid).verifications;
        appended.forEach((replaces, n) =>
          target.push(signedVerification(dir, P.id, sid, kB, { score: 0.9 + n, verdict: "mismatch", output: `${label}-${n}\n`, replaces }))
        );
        writeFileSync(f, JSON.stringify(p, null, 2) + "\n");
        const r = build(dir, "--check");
        assert.notEqual(r.code, 0, `${label}: a broken verdict chain passed validation (D1)`);
        assert.match(r.err + r.out, pattern, `${label}: the build failed, but not on the chain — that proves nothing`);
      }
    });

    test("a resubmission replaces the entry in place and drops the old verifications", async () => {
      const P = await newProblem(SRV, { title: "A problem for the resubmission" });
      const kA = mkKey();
      const repo = "https://example.com/again";
      const s1 = await post(SRV, "solution", solBody(kA, { problem: P.id, repo, score: 0.42 }));
      is(s1, 201, "the first submission");
      is(await post(SRV, "verification", verBody(mkKey(), { problem: P.id, solution: s1.json.sid, score: 0.42, verdict: "ok", output: "old\n" })), 201, "a verification of the first");

      const body2 = solBody(kA, { problem: P.id, repo, score: 0.43, replaces: s1.json.sid });
      is(await post(SRV, "solution", solBody(kA, { problem: P.id, repo, score: 0.43 })), 409, "a correction without replaces has to name the state it supersedes");
      const s2 = await post(SRV, "solution", body2);
      is(s2, 200, "a corrected result under the same repo and key");
      assert.equal(s2.json.replaced, s1.json.sid, "the 200 has to name the superseded sid");
      assert.notEqual(s2.json.sid, s1.json.sid);
      const mine = problemAt(TREE, P.id).solutions.filter((x) => x.author === sg.fingerprint(kA.pub) && x.repo === repo);
      assert.equal(mine.length, 1, "replaced in place, not a second copy");
      assert.equal(mine[0].sid, s2.json.sid);
      assert.equal(mine[0].score, 0.43);
      assert.deepEqual(mine[0].verifications, [], "the old verifications confirmed a different number");
      assert.equal(mine[0].verified, false);
      const replay = await post(SRV, "solution", body2);
      is(replay, 409, "the byte-for-byte same submission");
      // An agent whose connection dropped after a successful write has to read "it is
      // already in" out of this 409, not "sign with replaces X" - otherwise it signs a
      // second entry with the same content and pays for it out of its limit.
      assert.match(String(replay.json?.error), /already here/, "a byte-for-byte replay has to be recognised as the same content");
      assert.equal(replay.json?.sid, s2.json.sid, "the 409 has to name the sid that is sitting there");
      assert.equal(build(TREE, "--check").code, 0);
    });

    // Round 3, D8: the `replaces` token alone protected only ONE step. A sid computed
    // without it returned to an earlier value when the author went back to an earlier
    // result, and then a historical body described the current state again and got in a
    // second time. Measured before the fix: 0.42 -> 0.39 -> 0.42 gave sid_3 == sid_1,
    // and a replay of body #2 rolled the author back to 0.39 and deleted a verification
    // collected by a stranger.
    test("returning to an earlier result does not revive an old body (D8)", async () => {
      const P = await newProblem(SRV, { title: "A problem for the sid chain" });
      const kA = mkKey();
      const repo = "https://example.com/chain";
      const b1 = solBody(kA, { problem: P.id, repo, score: 0.42 });
      const s1 = await post(SRV, "solution", b1);
      is(s1, 201, "a submission of 0.42");
      const b2 = solBody(kA, { problem: P.id, repo, score: 0.39, replaces: s1.json.sid });
      const s2 = await post(SRV, "solution", b2);
      is(s2, 200, "corrected to 0.39");
      const s3 = await post(SRV, "solution", solBody(kA, { problem: P.id, repo, score: 0.42, replaces: s2.json.sid }));
      is(s3, 200, "back to 0.42");
      assert.notEqual(s3.json.sid, s1.json.sid, "the state returned to an earlier sid — every historical body is valid again (D8)");

      is(
        await post(SRV, "verification", verBody(mkKey(), { problem: P.id, solution: s3.json.sid, score: 0.42, verdict: "ok", output: "chain-ok\n" })),
        201,
        "a stranger verifies the current state"
      );
      const c0 = commits(TREE);
      for (const [label, body] of [["#1", b1], ["#2", b2]]) is(await post(SRV, "solution", body), 409, `a replay of historical body ${label}`);

      const mine = problemAt(TREE, P.id).solutions.filter((x) => x.repo === repo);
      assert.equal(mine.length, 1);
      assert.equal(mine[0].sid, s3.json.sid, "the replay rolled the author back");
      assert.equal(mine[0].score, 0.42);
      assert.equal(mine[0].verifications.length, 1, "the replay deleted somebody else's verification");
      assert.equal(commits(TREE), c0, "a rejected replay left a commit behind");
      assert.equal(build(TREE, "--check").code, 0);
    });

    // A side effect of the chain, but worth a test: correcting the note alone at the
    // same result used to be IMPOSSIBLE - the sid came out identical and it ended in a
    // 409, so a typo in a signed field could not be fixed.
    test("the note alone can be corrected without changing the result", async () => {
      const P = await newProblem(SRV, { title: "A problem for the note correction" });
      const kA = mkKey();
      const repo = "https://example.com/note-correction";
      const s1 = await post(SRV, "solution", solBody(kA, { problem: P.id, repo, score: 0.42, note: "tpyo" }));
      is(s1, 201, "a submission with a typo in the note");
      const s2 = await post(SRV, "solution", solBody(kA, { problem: P.id, repo, score: 0.42, note: "typo fixed", replaces: s1.json.sid }));
      is(s2, 200, "the note corrected at the same result");
      assert.notEqual(s2.json.sid, s1.json.sid);
      const mine = problemAt(TREE, P.id).solutions.filter((x) => x.repo === repo);
      assert.equal(mine.length, 1);
      assert.equal(mine[0].note, "typo fixed");
      assert.equal(build(TREE, "--check").code, 0);
    });

    // D1: the key and sig of every entry are public in git, so any body that ever got
    // through can be reconstructed from the history and sent again.
    test("a stranger's replay of a signed submission neither rolls the author back nor eats their limit", async () => {
      const P = await newProblem(SRV, { title: "A problem for the signature replay" });
      const kA = mkKey();
      const repo = "https://example.com/replay";
      const v1 = solBody(kA, { problem: P.id, repo, score: 0.3 });
      const s1 = await post(SRV, "solution", v1);
      is(s1, 201, "the author submits v1");
      const q1 = s1.json.quota;

      is(await post(SRV, "verification", verBody(mkKey(), { problem: P.id, solution: s1.json.sid, score: 0.3, verdict: "ok", output: "replay-ok\n" })), 201, "a stranger verifies v1");

      const v2 = solBody(kA, { problem: P.id, repo, score: 0.28, replaces: s1.json.sid });
      const s2 = await post(SRV, "solution", v2);
      is(s2, 200, "the author corrects the result");
      const c0 = commits(TREE);

      // the same body the server accepted a minute ago, sent by somebody else.
      // Both end in 409, but for different reasons and each has to say so:
      // v1 describes a state that has passed; v2 IS the current state.
      const p1 = await post(SRV, "solution", v1);
      is(p1, 409, "a replay of body v1");
      assert.equal(p1.json.replaces, s2.json.sid, "the 409 has to carry the state the server expects");
      const p2 = await post(SRV, "solution", v2);
      is(p2, 409, "a replay of body v2");
      assert.equal(p2.json.sid, s2.json.sid, "the 409 has to name the sid that is sitting there");
      assert.match(String(p2.json.error), /already here/, "a replay of the current entry is the same content, not the wrong state");

      const mine = problemAt(TREE, P.id).solutions.filter((x) => x.repo === repo);
      assert.equal(mine.length, 1);
      assert.equal(mine[0].sid, s2.json.sid, "the replay rolled the author back to an older entry");
      assert.equal(mine[0].score, 0.28);
      assert.equal(mine[0].replaces, s1.json.sid, "the record has to carry the signed state, otherwise build.mjs cannot reconstruct the payload");
      assert.equal(commits(TREE), c0, "a rejected replay left a commit behind");

      // the KEY's limit must not disappear through somebody else's attempts: 3 of the author's own 5 writes
      const s3 = await post(SRV, "solution", solBody(kA, { problem: P.id, repo, score: 0.27, replaces: s2.json.sid }));
      is(s3, 200, "the author still has their own limit");
      assert.equal(q1, "1/5");
      assert.equal(s3.json.quota, "3/5", "a stranger's replays drew down the author's limit");
      assert.equal(build(TREE, "--check").code, 0);
    });

    test("the note belongs to the author — a dispute does not overwrite it", async () => {
      const P = await newProblem(SRV, { title: "A problem for the author's note" });
      const note = "my note: numbers from a run on 4 GPUs";
      const s = await post(SRV, "solution", solBody(mkKey(), { problem: P.id, repo: "https://example.com/note", score: 0.42, note }));
      is(s, 201, "a submission with a note");
      is(await post(SRV, "verification", verBody(mkKey(), { problem: P.id, solution: s.json.sid, score: 0.9, verdict: "mismatch", output: "dispute\n" })), 201, "a dispute");
      const sol = problemAt(TREE, P.id).solutions.find((x) => x.sid === s.json.sid);
      assert.equal(sol.note, note, "the dispute overwrote the author's note — that is how a discussion thread enters this project (B17)");
      assert.equal(sol.disputed, true);
    });

    test("two solutions under the same repo from different keys live side by side", async () => {
      const P = await newProblem(SRV, { title: "A problem for the repo collision" });
      const repo = "https://example.com/collision";
      const a = await post(SRV, "solution", solBody(mkKey(), { problem: P.id, repo, score: 0.42 }));
      const b = await post(SRV, "solution", solBody(mkKey(), { problem: P.id, repo, score: 0.84 }));
      is(a, 201, "the first submitter");
      is(b, 201, "the second submitter under the same repo");
      assert.notEqual(a.json.sid, b.json.sid);
      is(await post(SRV, "verification", verBody(mkKey(), { problem: P.id, solution: b.json.sid, score: 0.84, verdict: "ok", output: "second\n" })), 201, "a verification addressed by sid");
      const p = problemAt(TREE, P.id);
      assert.equal(p.solutions.find((x) => x.sid === a.json.sid).verified, false, "the verification landed on somebody else's solution (C20)");
      assert.equal(p.solutions.find((x) => x.sid === b.json.sid).verified, true);
    });

    test("a dead problem takes no writes and does not come back to life", async () => {
      const dir = mkTree("dead");
      const f = join(dir, "problems", problemName(dir, "0001"));
      const p = JSON.parse(readFileSync(f, "utf8"));
      p.status = "dead";
      writeFileSync(f, JSON.stringify(p, null, 2) + "\n");
      seal(dir);
      const srv = await startServer(dir);
      assert.ok(srv.port, srv.why);
      const c0 = commits(dir);
      is(await post(srv, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/dead", score: 0.42 })), 409, "a write to a dead problem");
      assert.equal(commits(dir), c0);
      assert.equal(problemAt(dir, "0001").status, "dead", "the dead problem came back to life");
      await stop(srv, "SIGKILL");
    });
  });

// =====================================================================
// 6. Limits — the only reason this server exists at all
// =====================================================================

if (gate.server)
  describe("daily limits", () => {
    test("a failed write does NOT eat the limit, and an exhausted limit explains itself to the agent", async () => {
      const k = mkKey();
      const bad = solBody(k, { problem: "0001", repo: "https://example.com/limit-bad", score: 0.42 });
      for (let i = 0; i < 5; i++) is(await post(SRV, "solution", { ...bad, sig: sigOf(k, "somebody else's content") }), 403, `failed attempt ${i + 1}`);
      for (let i = 0; i < 5; i++)
        is(await post(SRV, "solution", solBody(k, { problem: "0001", repo: `https://example.com/limit-${i}`, score: 0.42 })), 201, `successful write ${i + 1} of 5`);
      const over = await post(SRV, "solution", solBody(k, { problem: "0001", repo: "https://example.com/limit-6", score: 0.42 }));
      is(over, 429, "the sixth write in a day");
      assert.match(String(over.headers["retry-after"] ?? ""), /^\d+$/, "a 429 without retry-after does not tell the agent when to come back");
      assert.match(String(over.json?.reset ?? ""), /^\d{4}-\d{2}-\d{2}T/, "reset has to be an ISO stamp, not the string '00:00 UTC'");
      assert.match(String(over.json?.quota ?? ""), /^\d+\/\d+$/, "a 429 has to state the key's budget (finding 47)");
    });

    test("a junk write under somebody else's key does not eat the victim's limit", async () => {
      const victim = mkKey();
      is(await post(SRV, "solution", solBody(victim, { problem: "0001", repo: "https://example.com/victim-0", score: 0.42 })), 201, "the victim publishes their key");
      for (let i = 0; i < 8; i++) {
        const r = await post(SRV, "solution", { key: victim.pub, sig: "AAAA", problem: "0001", repo: `https://example.com/attack-${i}`, score: 0.42 });
        assert.ok(r.status === 400 || r.status === 403, `attack ${i}: expected 400/403, got ${r.status}`);
      }
      for (let i = 1; i < 5; i++)
        is(await post(SRV, "solution", solBody(victim, { problem: "0001", repo: `https://example.com/victim-${i}`, score: 0.42 })), 201, `the victim still has a limit (${i + 1}/5)`);
    });

    test("the IP counter: every request counts once, after the body is read", async () => {
      const dir = newTree("ip");
      const srv = await startServer(dir, { IP_CAP: "3", HOST: "::" });
      assert.ok(srv.port, srv.why);
      for (let i = 0; i < 3; i++) is(await post(srv, "solution", { problem: "0001" }), 401, `unsigned ${i + 1}`);
      is(await post(srv, "solution", { problem: "0001" }), 429, "the fourth request from this address");
      // read the counters BY NAME, not through readdir: .state also holds transient
      // files (the write-permission probe, writeAtomic temp files), so listing the
      // directory can catch a name that is already gone
      const state = ["ip.json", "limits.json"]
        .map((f) => join(dir, ".state", f))
        .filter((f) => existsSync(f))
        .map((f) => readFileSync(f, "utf8"))
        .join("\n");
      assert.ok(state.includes("127.0.0.1"), ".state does not know the client address — the IP counter is not working");
      assert.ok(!state.includes("::ffff:"), "a v4-mapped address creates its own bucket, so the cap is free (finding 26)");
      await stop(srv, "SIGKILL");
    });

    // D10: an attempt rejected through the CLIENT's fault still has to cost the address
    // - otherwise flooding with junk is free. But a failure on the server side is not
    // the client's fault: before this change one outage burned the daily budget of
    // everyone who polled, and once the service came back they had nothing left to write with.
    test("the address budget does not pay for a server outage, it pays for its own mistakes (D10)", async () => {
      const dir = newTree("limit-refund");
      writeFileSync(join(dir, "problems", "0002-foreign.json"), "{}\n"); // a dirty tree -> read-only mode
      const srv = await startServer(dir, { IP_CAP: "5" });
      assert.ok(srv.port, srv.why);
      const left = async () => (await hit(srv, { path: "/api/pulse" })).json?.limits?.attempts_left;

      assert.equal(await left(), 5, "the pulse does not carry the address budget — burning it shows only once it runs out");
      const outage = await post(srv, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/refund", score: 0.42 }));
      is(outage, 503, "a write in read-only mode");
      assert.equal(await left(), 5, "the address paid for an outage it has no influence over (D10)");

      is(await post(srv, "solution", { problem: "0001" }), 503, "an unsigned write in read-only mode also ends in 503");
      assert.equal(await left(), 5, "another attempt during the outage has to be free too");
      await stop(srv, "SIGKILL");
    });

    test("the address budget pays for its own mistakes (negative control for D10)", async () => {
      const srv = await startServer(newTree("refund-control"), { IP_CAP: "5" });
      assert.ok(srv.port, srv.why);
      const left = async () => (await hit(srv, { path: "/api/pulse" })).json?.limits?.attempts_left;
      assert.equal(await left(), 5);
      is(await post(srv, "solution", { problem: "0001" }), 401, "an unsigned write");
      assert.equal(await left(), 4, "an attempt rejected through the client's fault MUST cost the address, otherwise the flood is free");
      await stop(srv, "SIGKILL");
    });

    // D5: the two limits count differently and the agent has to know which one it just
    // hit. The message "daily limit" on its own is indistinguishable.
    test("the address limit is explicit: in the pulse, in the 429 and in the text view", async () => {
      const dir = newTree("address-limit");
      const srv = await startServer(dir, { IP_CAP: "2" });
      assert.ok(srv.port, srv.why);
      const pulse = await hit(srv, { path: "/api/pulse" });
      assert.equal(pulse.json?.limits?.per_address, 2, "the pulse does not publish the address limit — the agent cannot plan around it");
      assert.equal(pulse.json?.limits?.solution, 5, "the key limits have to stay in the same field");
      const view = await hit(srv, { path: "/" });
      assert.match(view.text, /per address/, "the text view is silent about the address limit");

      // typos only: nothing gets stored, and the address budget goes anyway
      is(await post(srv, "solution", { problem: "0001" }), 401, "typo 1");
      is(await post(srv, "solution", { problem: "0001" }), 401, "typo 2");
      const stop429 = await post(srv, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/after-typos", score: 0.42 }));
      is(stop429, 429, "a correct write after the address limit is exhausted");
      assert.equal(stop429.json?.limit, "per_address", "the 429 does not say WHICH limit was hit (the key's or the address's)");
      assert.equal(commits(dir), 1, "the rejected attempts left a commit behind");
      await stop(srv, "SIGKILL");
    });

    // Round 3, D9: the address limit has to hold a WHOLE /64, because that is what one
    // IPv6 client gets. Cutting the string on ":" took the first four fields of the
    // STRING, not the first four groups of the address, so in shortened form
    // "2001:db8::1" and "2001:db8::2" landed in two buckets (and so did two writes from
    // the SAME address). The limit became free for every IPv6 client.
    test("the address limit covers a whole /64, shortened form included (D9)", async () => {
      const srv = await startServer(newTree("ip64"), { IP_CAP: "3", TRUST_PROXY: "1" });
      assert.ok(srv.port, srv.why);
      const withXff = (address) => post(srv, "solution", { problem: "0001" }, { "x-forwarded-for": address });
      // three DIFFERENT addresses from one /64, in mixed notation
      for (const a of ["2001:db8::1", "2001:db8::2", "2001:db8:0:0:0:0:0:3"]) is(await withXff(a), 401, `an attempt from ${a}`);
      is(await withXff("2001:db8::dead"), 429, "a fourth address from the same /64 — the limit has to be exhausted already (D9)");
      is(await withXff("2001:db9::1"), 401, "a different /64 has its own counter");
      await stop(srv, "SIGKILL");
    });

    test("a 413 does not charge the IP counter", async () => {
      const dir = newTree("ip413");
      const srv = await startServer(dir, { IP_CAP: "2" });
      assert.ok(srv.port, srv.why);
      is(await post(srv, "solution", JSON.stringify({ key: "x".repeat(200 * 1024) })), 413, "a body over the limit");
      is(await post(srv, "solution", { problem: "0001" }), 401, "the first normal request");
      is(await post(srv, "solution", { problem: "0001" }), 401, "the second normal request");
      is(await post(srv, "solution", { problem: "0001" }), 429, "the third — only here does the limit of 2 run out");
      await stop(srv, "SIGKILL");
    });
  });

// =====================================================================
// 7. Representations — the reader is an agent
// =====================================================================

if (gate.server)
  describe("representations", () => {
    // Every view opens with the same path header, and in HTML that path is walkable. Before
    // this the mark was decorative and the <pre> held no anchors at all: a browser landing
    // on /findings could not get back to / without editing the URL by hand.
    test("every view opens with the EXIT0 path header", async () => {
      for (const path of ["/", "/start", "/work", "/keys", "/findings", "/gap", "/0001"]) {
        const r = await hit(SRV, { path, headers: { accept: "text/plain" } });
        is(r, 200, `GET ${path}`);
        assert.match(r.text.split("\n")[0], /^EXIT0(?: \/ \S+)?$/, `${path}: the first line is not the path header, so there is no breadcrumb to link`);
      }
    });

    test("the HTML representation is navigable: the mark goes home and so does the header", async () => {
      for (const path of ["/", "/start", "/work", "/keys", "/findings", "/gap", "/0001"]) {
        const h = await hit(SRV, { path, headers: { accept: "text/html" } });
        is(h, 200, `GET ${path} (html)`);
        assert.match(h.text, /<a class="home" href="\/"/, `${path}: the mark is not a link, so clicking the logo does nothing`);
        assert.match(h.text, /<a href="\/">EXIT0<\/a>/, `${path}: the path header is not a link home`);
      }
    });

    // The agent surface must not move. Links are a HUMAN affordance and text/plain is what
    // an agent parses by column: one stray anchor there and every column shifts.
    test("no link ever reaches text/plain", async () => {
      for (const path of ["/", "/start", "/work", "/keys", "/findings", "/gap", "/0001", "/llms.txt"]) {
        const r = await hit(SRV, { path, headers: { accept: "text/plain" } });
        assert.ok(!/<a\s|<\/a>/.test(r.text), `${path}: an anchor leaked into the text representation`);
      }
    });

    // Structured URLs are links; a URL somebody TYPED is not. That line is invariant 12's:
    // a title carrying [text](url) once put a clickable link under the submitter's control
    // into README, and that was a bug. repo and subject go through canonUrl on the write
    // path; a note, a finding body, `how` and a title are canonText and never validated as
    // URLs, so they are strings, not destinations this registry vouches for.
    // A cut list that announces it was cut is honest; a cut list with no way past it is
    // still a dead end. On a phone the front page was a long scroll ending in a
    // parenthesised parameter and nothing to press, while the drawer table sat right above
    // it naming slices a reader could not reach.
    test("the front page is an index: every slice and every page is reachable by a link", async () => {
      const h = await hit(SRV, { path: "/?limit=2", headers: { accept: "text/html" } });
      is(h, 200, "GET /?limit=2 (html)");
      const links = new Set([...h.text.matchAll(/<a href="(\/[^"]*)"/g)].map((m) => m[1]));
      // Every drawer that has problems is a link, not a bare name.
      const idx = JSON.parse((await hit(SRV, { path: "/api/index.json" })).text);
      const domains = new Set((idx.problems ?? []).map((p) => p.domain));
      for (const d of domains)
        assert.ok(links.has(`/?domain=${d}`), `the ${d} drawer names a slice with no way to open it`);
      // The cut declares a way past itself.
      assert.ok([...links].some((l) => l.includes("offset=")), "the list is cut and offers no next page to click");

      // Pressing a drawer has to LOOK like it did something. The filtered view used to
      // repeat the whole orientation block, so the one line that changed sat several
      // screens down and on a phone the click read as a no-op.
      const full = await hit(SRV, { path: "/", headers: { accept: "text/plain" } });
      const one = await hit(SRV, { path: "/?domain=infra", headers: { accept: "text/plain" } });
      is(one, 200, "GET /?domain=infra");
      assert.match(one.text.split("\n")[0], /^EXIT0 \/ domain=infra$/, "a filtered view does not say on line one which slice it is");
      assert.ok(one.text.split("\n").length < full.text.split("\n").length / 2, "a filtered view is nearly as long as the front door, so the filter reads as a no-op");
      for (const block of ["DRAWERS", "LIMITS"])
        assert.ok(!one.text.includes(block), `the filtered view repeats the ${block} block the reader just walked past`);
      assert.match(one.text, /all of it \//, "a filtered view offers no way back to everything");

      // A filter must survive paging, or page two silently widens back to everything.
      const f = await hit(SRV, { path: "/?domain=infra&limit=1", headers: { accept: "text/html" } });
      const nav = [...f.text.matchAll(/<a href="(\/\?[^"]*offset=[^"]*)"/g)].map((m) => m[1]);
      assert.ok(nav.length, "a filtered page offers no next page");
      for (const n of nav) {
        assert.match(n, /domain=infra/, "paging a filtered list drops the filter");
        // "&" is "&amp;" by the time linkify sees it. Without the entity the href used to
        // stop at "&amp" and produce a link to a different listing than the one shown.
        const real = n.replace(/&amp;/g, "&");
        const r = await hit(SRV, { path: real, headers: { accept: "text/plain" } });
        is(r, 200, `the offered link ${real} does not resolve`);
        assert.match(r.text, /domain=infra/, `${real} came back without the filter it carried`);
      }
    });

    test("a URL is a link only when the registry put it there as a field", async () => {
      const typed = "https://typed-into-free-text.example/phish";
      const P = await newProblem(SRV, {
        title: "A problem whose text types out a URL",
        problem: `Somebody wrote ${typed} in the body, and it is prose, not a field.`,
        subject: "https://example.com/subject-of-this-problem",
      });
      const r = await post(SRV, "solution", solBody(mkKey(), { problem: P.id, repo: "https://example.com/a-real-repo", score: 1, note: `see also ${typed}` }));
      is(r, 201, "the solution");

      const h = await hit(SRV, { path: `/${P.id}`, headers: { accept: "text/html" } });
      is(h, 200, `GET /${P.id} (html)`);
      const linked = (h.text.match(/<a href="(https?:\/\/[^"]+)"/g) ?? []).join(" ");
      assert.match(linked, /a-real-repo/, "a solution repo is a structured field and was not linked");
      assert.match(linked, /subject-of-this-problem/, "a problem subject is a structured field and was not linked");
      assert.ok(!linked.includes(typed), "a URL typed into free text became a clickable link under the submitter's control (invariant 12)");
      // The prose still SHOWS it - we refuse to make it a destination, not to show it.
      assert.ok(h.text.includes(typed), "the URL vanished from the page entirely; the rule is do not link it, not hide it");

      // An external link must not donate ranking or leak a referrer.
      for (const m of h.text.matchAll(/<a href="https?:\/\/[^"]+"([^>]*)>/g))
        assert.match(m[1], /rel="nofollow noopener noreferrer"/, "an external link carries no rel");
      // And none of this reaches the surface an agent parses by column.
      const t = await hit(SRV, { path: `/${P.id}`, headers: { accept: "text/plain" } });
      assert.ok(!/<a\s/.test(t.text), "an anchor leaked into text/plain");
    });

    test("only paths the server actually serves become links, and content cannot make markup", async () => {
      const P = await newProblem(SRV, {
        title: "A problem whose text mentions paths",
        problem: 'See /nowhere and /api/nope and <script>alert(1)</script> and "quoted" — also /work and 0001.',
      });
      const h = await hit(SRV, { path: `/${P.id}`, headers: { accept: "text/html" } });
      is(h, 200, "the problem page as HTML");
      // Escaping happens BEFORE linkification, so nothing a submitter wrote can be markup.
      assert.ok(!/<script/i.test(h.text), "a script tag from problem text reached the page");
      assert.match(h.text, /&lt;script&gt;/, "the script tag was not escaped into text");
      // A path we do not serve is not a link, however much it looks like one.
      assert.ok(!/href="\/nowhere"/.test(h.text), "/nowhere was linked, but this server does not serve it");
      assert.ok(!/href="\/api\/nope"/.test(h.text), "/api/nope was linked, but this server does not serve it");
      // One we do serve is, and so is a real problem id.
      assert.match(h.text, /href="\/work"/, "/work in the body was not linked");
      assert.match(h.text, /href="\/0001"/, "a real problem id in the body was not linked");
      // Write-only routes are not GET targets and must not pretend to be.
      assert.ok(!/href="\/api\/solution"/.test(h.text), "a POST-only route was rendered as a link");
    });

    test("/ is text/plain by default, HTML only on request, no JS and no external resources", async () => {
      const t = await hit(SRV, { path: "/" });
      is(t, 200, "GET /");
      assert.match(String(t.headers["content-type"]), /^text\/plain/);
      assert.match(String(t.headers["vary"] ?? ""), /accept/i, "no vary: accept with three representations");
      assert.equal(Number(t.headers["content-length"]), t.bytes);
      assert.equal(t.headers["access-control-allow-origin"], "*");
      assert.ok(t.headers.etag);

      const h = await hit(SRV, { path: "/", headers: { accept: "text/html" } });
      is(h, 200, "GET / (text/html)");
      assert.match(String(h.headers["content-type"]), /^text\/html/);
      assert.ok(h.text.includes("<pre>"));
      assert.ok(!/<script/i.test(h.text), "the HTML has to carry no JS");
      assert.ok(!/\b(?:src|href)\s*=\s*["\']https?:/i.test(h.text), "the HTML has no business pulling anything from the network");
      assert.ok(!/@import|url\(/i.test(h.text), "the CSS has no business pulling a resource");
      assert.notEqual(h.headers.etag, t.headers.etag, "two representations under one ETag is a wrong 304");

      const j = await hit(SRV, { path: "/", headers: { accept: "application/json" } });
      is(j, 200, "GET / (json)");
      assert.match(String(j.headers["content-type"]), /^application\/json/);
    });

    test("if-none-match: exact, weak, star and a list -> 304", async () => {
      const t = await hit(SRV, { path: "/" });
      const etag = t.headers.etag;
      for (const h of [etag, `W/${etag}`, "*", `"something-else", ${etag}`]) {
        const r = await hit(SRV, { path: "/", headers: { "if-none-match": h } });
        is(r, 304, `if-none-match: ${h}`);
        assert.equal(r.bytes, 0, "a 304 has no body");
        assert.equal(r.headers.etag, etag, "the 304 loses the etag");
        assert.equal(r.headers["access-control-allow-origin"], "*", "the 304 loses CORS");
      }
      const idx = await hit(SRV, { path: "/api/index.json" });
      is(await hit(SRV, { path: "/api/index.json", headers: { "if-none-match": idx.headers.etag } }), 304, "/api/index.json honours its own ETag");
    });

    test("Accept negotiation respects q=0", async () => {
      const r = await hit(SRV, { path: "/", headers: { accept: "application/json;q=0" } });
      is(r, 200, "GET / with application/json;q=0");
      assert.doesNotMatch(String(r.headers["content-type"]), /application\/json/, "q=0 means: NOT this type");
      const r2 = await hit(SRV, { path: "/", headers: { accept: "text/html;q=0.3, text/plain;q=0.9" } });
      assert.match(String(r2.headers["content-type"]), /^text\/plain/);
    });

    test("read paths answer GET/HEAD only", async () => {
      for (const [method, path] of [["DELETE", "/api/index.json"], ["PUT", "/api/index.json"], ["TRACE", "/"], ["POST", "/llms.txt"]]) {
        const r = await hit(SRV, { method, path });
        is(r, 405, `${method} ${path}`);
        assert.match(String(r.headers.allow ?? ""), /GET/);
      }
      const head = await hit(SRV, { method: "HEAD", path: "/" });
      is(head, 200, "HEAD /");
      assert.equal(head.bytes, 0);
    });

    test("OPTIONS: 204 with no body, carrying allow-methods", async () => {
      const r = await hit(SRV, { method: "OPTIONS", path: "/" });
      is(r, 204, "OPTIONS /");
      assert.equal(r.bytes, 0);
      assert.equal(r.headers["content-length"], undefined, "a 204 has no content-length");
      assert.ok(r.headers["access-control-allow-methods"], "a preflight without allow-methods is useless");
      assert.equal(r.headers["access-control-allow-origin"], "*");
    });

    test("/llms.txt, /AGENTS.md and /sign.mjs: content-length, CORS, ETag", async () => {
      for (const p of ["/llms.txt", "/AGENTS.md", "/sign.mjs"]) {
        const r = await hit(SRV, { path: p });
        is(r, 200, `GET ${p}`);
        assert.match(String(r.headers["content-type"]), /^text\/plain/);
        assert.equal(Number(r.headers["content-length"]), r.bytes, `${p} with no content-length`);
        assert.equal(r.headers["access-control-allow-origin"], "*", `${p} with no CORS`);
        assert.ok(r.headers.etag, `${p} with no ETag, so max-age cannot be refreshed`);
      }
      const s = await hit(SRV, { path: "/sign.mjs" });
      assert.ok(s.text.includes("exit0/v2"), "/sign.mjs does not serve the contract");
      const pulse = await hit(SRV, { path: "/api/pulse" });
      assert.equal(String(s.headers.etag).replace(/"/g, ""), pulse.json?.contract, "the hash of /sign.mjs has to agree with pulse.contract");
    });

    test("/api/pulse: shape, no-store, no per-key leak", async () => {
      const r = await hit(SRV, { path: "/api/pulse" });
      is(r, 200, "GET /api/pulse");
      for (const f of ["head", "day", "limits", "contract", "writes"]) assert.notEqual(r.json?.[f], undefined, `pulse without the field ${f}`);
      assert.equal(r.json.writes, "ok");
      assert.match(String(r.headers["cache-control"] ?? ""), /no-store/);
      assert.match(r.json.day, /^\d{4}-\d{2}-\d{2}$/);
      const withKey = await hit(SRV, { path: `/api/pulse?key=${encodeURIComponent(mkKey().pub)}` });
      assert.deepEqual(withKey.json, r.json, "?key= was supposed to go — it is a public view of a key's activity (finding 47)");
    });

    test("head in /api/pulse is fresh after a commit", async () => {
      const before = (await hit(SRV, { path: "/api/pulse" })).json.head;
      const r = await post(SRV, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/pulse", score: 0.42 }));
      is(r, 201, "a write for the pulse test");
      const after = (await hit(SRV, { path: "/api/pulse" })).json.head;
      assert.notEqual(after, before, "the pulse did not notice the commit (finding 10)");
      assert.equal(after, r.json.head, "the head in the 201 does not agree with the pulse");
    });

    test("a 404 is a signpost", async () => {
      const r = await hit(SRV, { path: "/no-such-thing" });
      is(r, 404, "an unknown path");
      assert.ok(Array.isArray(r.json?.paths) && r.json.paths.includes("/llms.txt"));
      assert.ok(Array.isArray(r.json?.write));
      assert.match(String(r.headers.link ?? ""), /llms/);
    });

    test("/ is a listing of constant size, and the band and the command live under /<id>", async () => {
      const t = await hit(SRV, { path: "/" });
      const j = await hit(SRV, { path: "/api/index.json" });
      assert.ok(t.bytes < j.bytes, `/ (${t.bytes}B) is not meaningfully smaller than /api/index.json (${j.bytes}B)`);
      assert.ok(!t.text.includes(problemAt(TREE, "0001").problem.slice(0, 60)), "/ prints the full problem statement — that is what /<id> is for");
      assert.ok(!t.text.includes(problemAt(TREE, "0001").acceptance.how.slice(0, 40)), "/ prints the command — that is what /<id> is for");
      assert.match(t.text, /DISPUTED/, "a dispute has to be visible on the listing already");
      assert.match(t.text, /DRAWERS/, "without the split into drawers the listing is unreadable at a thousand problems");

      const one = await hit(SRV, { path: "/0001" });
      is(one, 200, "GET /0001");
      assert.match(one.text, /tolerance/, "the agent does not know which band to land in (findings 28/39)");
      assert.ok(one.text.includes(problemAt(TREE, "0001").acceptance.how.slice(0, 40)), "/<id> without the command is useless");
      assert.match(one.text, /domain: /, "/<id> has to carry the drawer and the requirements");
      is(await hit(SRV, { path: "/9999" }), 404, "a problem that does not exist");
      const single = await hit(SRV, { path: "/api/problems/0001" });
      is(single, 200, "GET /api/problems/0001");
      assert.equal(single.json?.id, "0001", "/api/problems/<id> has to return the record as JSON");
    });

    // Three surfaces added after the question "what is this site for": the badge (a
    // reason to submit anything at all), the queue (the only reason to come back) and
    // claim (dropping the entry barrier: it used to be write a well-posed problem, now
    // it is I have a number and a command).
    test("the /work queue shows solutions waiting for a stranger", async () => {
      const P = await newProblem(SRV, { title: "A problem for the queue", needs: [] });
      const s = await post(SRV, "solution", solBody(mkKey(), { problem: P.id, repo: "https://example.com/queue", score: 0.42 }));
      is(s, 201, "a solution for the queue");

      const w = await hit(SRV, { path: "/work" });
      is(w, 200, "GET /work");
      assert.match(w.text, new RegExp(`FIRST CHECK.*${s.json.sid}`), "a fresh solution did not reach the queue");
      assert.match(w.text, /POST \/api\/verification/, "a queue with no command to run is a noticeboard, not a queue");

      const j = await hit(SRV, { path: "/api/work" });
      is(j, 200, "GET /api/work");
      const entry = (j.json?.work ?? []).find((x) => x.solution === s.json.sid);
      assert.ok(entry, "no entry in /api/work");
      assert.equal(entry.need, "first");
      assert.equal(entry.tolerance, P.fields.tolerance, "without the tolerance a verifier has nothing to sign");
      assert.deepEqual(entry.needs, [], "the queue has to say what running it requires");

      // One verdict settles it and does NOT finish it. A result standing on a single key has
      // been run once, on one machine, so it comes back as SECOND RUN - work that is cheap
      // and useful, and the only thing this registry had to offer once every entry had a
      // verdict. It leaves the queue on the second INDEPENDENT confirmation, never before.
      is(await post(SRV, "verification", verBody(mkKey(), { problem: P.id, solution: s.json.sid, score: 0.42, verdict: "ok", output: "queue ok\n" })), 201, "a verification");
      // limit=500: a SECOND RUN row ranks last on purpose, and the default page is 100.
      const after = await hit(SRV, { path: "/api/work?limit=500" });
      const again = (after.json?.work ?? []).find((x) => x.solution === s.json.sid);
      assert.ok(again, "a settled solution left the queue after ONE run: /work empties and there is nothing cheap left to do");
      assert.equal(again.need, "second");
      assert.equal(again.confirmed_by, 1, "the queue has to say how much evidence is already there");
      assert.equal(again.disputed_by, 0);

      is(await post(SRV, "verification", verBody(mkKey(), { problem: P.id, solution: s.json.sid, score: 0.42, verdict: "ok", output: "queue ok twice\n" })), 201, "a second, independent verification");
      const settled = await hit(SRV, { path: "/api/work?limit=500" });
      assert.ok(!(settled.json?.work ?? []).some((x) => x.solution === s.json.sid), "two independent confirmations and it is still being handed out as work");

      // The count is visible where the claim is, and it is not the number of records.
      const one = await hit(SRV, { path: `/${P.id}` });
      assert.match(one.text, /confirmed by 2 keys, 0 mismatch/, "the problem page shows OK either way, so the count is the only thing that separates one run from two");
      const bdg = await hit(SRV, { path: `/${s.json.sid}/badge.svg` });
      assert.match(bdg.text, /verified by 2/, "the badge is the most-read thing here and it counts the same keys");
    });

    test("the /work queue: a dispute comes back as TIEBREAK, the have filter works", async () => {
      const P = await newProblem(SRV, { title: "A problem for the tiebreak", needs: ["gpu"] });
      const s = await post(SRV, "solution", solBody(mkKey(), { problem: P.id, repo: "https://example.com/tiebreak", score: 0.42 }));
      is(await post(SRV, "verification", verBody(mkKey(), { problem: P.id, solution: s.json.sid, score: 0.42, verdict: "ok", output: "t1\n" })), 201, "ok");
      is(await post(SRV, "verification", verBody(mkKey(), { problem: P.id, solution: s.json.sid, score: 0.9, verdict: "mismatch", output: "t2\n" })), 201, "mismatch");

      const j = await hit(SRV, { path: "/api/work" });
      const entry = (j.json?.work ?? []).find((x) => x.solution === s.json.sid);
      assert.ok(entry, "an unsettled dispute did not reach the queue — and that is exactly the work somebody has to do");
      assert.equal(entry.need, "tiebreak");

      const withNothing = await hit(SRV, { path: "/api/work?have=none" });
      assert.ok(!(withNothing.json?.work ?? []).some((x) => x.solution === s.json.sid), "have=none returned work that requires a gpu");
      is(await hit(SRV, { path: "/api/work?have=quantum" }), 400, "a have outside the set");

      // What the two keys DISAGREE about. Both verdicts were on the page already, one line
      // apart, and the thing a reader has to see - that two honest runs of one command came
      // back with different numbers - was left for them to work out by subtraction.
      const page = await hit(SRV, { path: `/${P.id}` });
      assert.match(page.text, /confirmed by 1 key, 1 mismatch/, "the page says OK and DISPUTED but never how many keys are behind either");
      assert.match(page.text, /independent scores 0\.42 - 0\.9/, "the spread between independent runs is the signal, and it was nowhere on the page");
    });

    // A count nobody can see is not a count. One key and two keys had rendered identically
    // as SOLVED, as OK and as a green badge, on every surface a reader meets first.
    test("SOLVED on one key reads differently from SOLVED on two", async () => {
      const P = await newProblem(SRV, { title: "A problem for counting confirmations", needs: [] });
      const s = await post(SRV, "solution", solBody(mkKey(), { problem: P.id, repo: "https://example.com/strength", score: 0.42 }));
      is(s, 201, "a solution to confirm");
      is(await post(SRV, "verification", verBody(mkKey(), { problem: P.id, solution: s.json.sid, score: 0.4207, verdict: "ok", output: "strength one\n" })), 201, "the first confirmation");

      // Filtered, not the front page itself: the listing is capped at 40 rows and this suite
      // files enough problems to push a solved one past the cut.
      const rowOf = async () => {
        const r = await hit(SRV, { path: "/?status=solved&limit=500", headers: { accept: "text/plain" } });
        is(r, 200, "GET /?status=solved");
        const line = r.text.split("\n").find((l) => l.startsWith(`[${P.id}]`));
        assert.ok(line, `no row for ${P.id} in the solved listing`);
        return line;
      };
      assert.match(await rowOf(), / 1 key /, "the listing calls it SOLVED and never says how thin the evidence is");
      const before = await hit(SRV, { path: `/api/problems?status=solved&limit=500` });
      assert.equal((before.json?.problems ?? []).find((x) => x.id === P.id)?.confirmed_by, 1);
      const start = await hit(SRV, { path: "/api/start?limit=500" });
      assert.equal((start.json?.start ?? []).find((x) => x.problem === P.id)?.best_keys, 1, "/start hands out a floor without saying what it rests on");

      is(await post(SRV, "verification", verBody(mkKey(), { problem: P.id, solution: s.json.sid, score: 0.4184, verdict: "ok", output: "strength two\n" })), 201, "a second, independent confirmation");
      assert.match(await rowOf(), / 2 keys /, "a second independent run changed nothing a reader can see");
      const after = await hit(SRV, { path: `/api/problems?status=solved&limit=500` });
      assert.equal((after.json?.problems ?? []).find((x) => x.id === P.id)?.confirmed_by, 2);

      const one = await hit(SRV, { path: `/${P.id}` });
      assert.match(one.text, /confirmed by 2 keys, 0 mismatch/);
      assert.match(one.text, /independent scores 0\.4184 - 0\.4207/, "two keys inside the band still measured two different numbers, and that is worth printing");
    });

    // Every state in this registry is monotone, so nothing decays and nothing expires -
    // and that is right, because an expiry is a game mechanic, not a measurement. The
    // other half of the truth was missing: an unverified claim is not neutral, and how
    // long it has stood unrun is a fact about it that only grows. So the age is printed
    // wherever a reader meets such a claim.
    //
    // It is READ from the `at` the server wrote into the record, never stored. That is
    // what the --check assertion below pins: an age written into problems/*.json would be
    // a derived field (invariant 7), build.mjs would recompute it on every pass, and a
    // clone run next week would compute a different number and fail --check everywhere.
    test("an unchecked claim carries its age, and the age is read rather than stored", async () => {
      const dir = newTree("clock");
      const srv = await startServer(dir);
      assert.ok(srv.port, srv.why);
      const P = await newProblem(srv, { title: "A problem with a clock on it", needs: [] });
      const s = await post(srv, "solution", solBody(mkKey(), { problem: P.id, repo: "https://example.com/clock", score: 0.42 }));
      is(s, 201, "a solution to leave unchecked");

      // `at` is written by the server, appears in no payload() and in no sid, so moving
      // it leaves every signature and both chains intact. Which is exactly why it can
      // carry the clock: the age is a function of a stored date and the UTC day.
      const back = 9;
      const day = new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
      const f = join(dir, "problems", problemName(dir, P.id));
      const rec = JSON.parse(readFileSync(f, "utf8"));
      rec.solutions.find((x) => x.sid === s.json.sid).at = day;
      writeFileSync(f, JSON.stringify(rec, null, 2) + "\n");
      assert.equal(build(dir).code, 0, "backdating `at` broke the build");
      const chk = build(dir, "--check");
      assert.equal(chk.code, 0, `an age that is READ has to leave --check green in every clone: ${chk.err || chk.out}`);
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "backdate");

      // The UTC day can turn over between the line above and the render below, so both
      // numbers are correct. What is under test is that the age is there and counts days.
      const d = `(${back}|${back + 1})`;
      const surfaces = [
        ["/work", new RegExp(`${s.json.sid}.*\\s${d}d\\s`)],
        ["/start", new RegExp(`^${P.id}\\s.*\\s${d}d\\s`, "m")],
        [`/${P.id}`, new RegExp(`unchecked for ${d} days`)],
        ["/", new RegExp(`\\[${P.id}\\].*unchecked ${d}d`)],
      ];
      for (const [path, want] of surfaces) {
        const r = await hit(srv, { path, headers: { accept: "text/plain" } });
        is(r, 200, `GET ${path}`);
        assert.match(r.text, want, `${path} hands out an unchecked claim without saying how long it has sat there`);
      }

      // A verdict is the thing that stops the clock, because "unchecked" stops being
      // true of that entry. Nothing else about it changes.
      is(await post(srv, "verification", verBody(mkKey(), { problem: P.id, solution: s.json.sid, score: 0.42, verdict: "ok", output: "clock ok\n" })), 201, "a verdict");
      const page = await hit(srv, { path: `/${P.id}`, headers: { accept: "text/plain" } });
      assert.ok(!/unchecked for/.test(page.text), "a solution a stranger ran is still called unchecked");
      const front = await hit(srv, { path: "/", headers: { accept: "text/plain" } });
      assert.ok(!new RegExp(`\\[${P.id}\\].*unchecked \\d+d`).test(front.text), "the front door still ages a claim that has been run");
      await stop(srv, "SIGKILL");
    });

    test("the badge: SVG with nothing from the network, its content computed from derived fields", async () => {
      const P = await newProblem(SRV, { title: "A problem for the badge" });
      const s = await post(SRV, "solution", solBody(mkKey(), { problem: P.id, repo: "https://example.com/badge", score: 0.42 }));

      const before = await hit(SRV, { path: `/${s.json.sid}/badge.svg` });
      is(before, 200, "the solution badge");
      assert.match(String(before.headers["content-type"]), /image\/svg\+xml/);
      assert.match(before.text, /unverified/, "an unverified solution gets a badge that tells the truth");
      // xmlns is a namespace IDENTIFIER, not an address to fetch — "http" alone inside
      // an SVG proves nothing. What counts: no script, no external resource.
      assert.ok(!/<script|<image|<foreignObject/i.test(before.text), "the badge carries a script or an embedded resource");
      assert.ok(!/\b(?:src|href|xlink:href)\s*=/i.test(before.text), "the badge refers to something outside itself");
      assert.ok(!/url\(/i.test(before.text), "the badge pulls a resource through url()");
      assert.match(String(before.headers["cache-control"] ?? ""), /max-age/, "without cache-control GitHub's image proxy will cache it anyway, on its own terms");

      is(await post(SRV, "verification", verBody(mkKey(), { problem: P.id, solution: s.json.sid, score: 0.42, verdict: "ok", output: "badge ok\n" })), 201, "a verification");
      const after = await hit(SRV, { path: `/${s.json.sid}/badge.svg` });
      assert.match(after.text, /verified by 1/, "the badge does not reflect the verdict");

      const pr = await hit(SRV, { path: `/${P.id}/badge.svg` });
      is(pr, 200, "the problem badge");
      assert.match(pr.text, /solved/, "a problem with a settled solution has to be SOLVED on the badge too");
      // The floor belongs on the badge too, or it still reads like a closed door. The
      // status word stays: a badge is twenty pixels tall and carries facts, while the
      // invitation to beat the number lives where there is room for a sentence.
      assert.match(pr.text, /best 0\.42/, "a solved problem does not show the number to beat");
      is(await hit(SRV, { path: "/9999/badge.svg" }), 404, "the badge of a problem that does not exist");
      is(await hit(SRV, { path: `/${"f".repeat(16)}/badge.svg` }), 404, "the badge of a solution that does not exist");
    });

    // Round 4. The badge is the only thing the registry hands back to a submitter, and
    // people paste it into a README, so it is the most-read artifact here. It counted
    // every record with verdict "ok", including verdicts their own author has since
    // withdrawn - so a verifier who said ok and then corrected themselves to mismatch
    // kept inflating the receipt. D1 says the head of a chain is what counts; the badge
    // has to obey the same rule as build.mjs.
    test("the badge counts heads of chains, not withdrawn verdicts", async () => {
      const P = await newProblem(SRV, { title: "A problem for the withdrawn verdict" });
      const s = await post(SRV, "solution", solBody(mkKey(), { problem: P.id, repo: "https://example.com/withdrawn", score: 0.42 }));
      is(s, 201, "a solution to verify");
      const sid = s.json.sid;

      const kB = mkKey();
      const v1 = await post(SRV, "verification", verBody(kB, { problem: P.id, solution: sid, score: 0.42, verdict: "ok", output: "b-ok\n" }));
      is(v1, 201, "B says ok");
      is(await post(SRV, "verification", verBody(kB, { problem: P.id, solution: sid, score: 0.9, verdict: "mismatch", output: "b-mismatch\n", replaces: v1.json.vid })), 201, "B withdraws it");
      is(await post(SRV, "verification", verBody(mkKey(), { problem: P.id, solution: sid, score: 0.42, verdict: "ok", output: "c-ok\n" })), 201, "C says ok");
      is(await post(SRV, "verification", verBody(mkKey(), { problem: P.id, solution: sid, score: 0.42, verdict: "ok", output: "d-ok\n" })), 201, "D says ok");

      const sol = problemAt(TREE, P.id).solutions.find((x) => x.sid === sid);
      assert.equal(sol.verified, true, "setup: two live ok verdicts");
      assert.equal(sol.settled, true, "setup: 2 ok keys against 1 mismatch key");
      assert.equal(sol.verifications.length, 4, "setup: four records on file, one of them withdrawn");

      const b = await hit(SRV, { path: `/${sid}/badge.svg` });
      is(b, 200, "the solution badge");
      assert.match(b.text, /verified by 2/, `the badge counts a withdrawn ok: ${b.text.match(/verified by \d+/)?.[0]}`);
    });

    // Round 4. /work is the demand surface and the registry is built for a thousand
    // problems. The listing declared its cut honestly but offered no way past it, so
    // everything after the first hundred rows was unreachable by any parameter - unlike
    // /api/problems, which solved this already.
    test("/api/work pages like /api/problems instead of being a wall at 100", async () => {
      const P = await newProblem(SRV, { title: "A problem for queue paging", needs: [] });
      for (const n of [0.11, 0.12]) is(await post(SRV, "solution", solBody(mkKey(), { problem: P.id, repo: `https://example.com/paging-${n}`, score: n })), 201, `a solution ${n}`);

      const all = await hit(SRV, { path: "/api/work" });
      is(all, 200, "GET /api/work");
      assert.ok(all.json.waiting >= 2, "setup: at least two rows waiting");

      const first = await hit(SRV, { path: "/api/work?limit=1" });
      is(first, 200, "GET /api/work?limit=1");
      assert.equal(first.json.work.length, 1, "/api/work ignores limit");
      assert.equal(first.json.more, first.json.waiting > 1, "the cut has to be declared, not silent");

      const second = await hit(SRV, { path: "/api/work?limit=1&offset=1" });
      is(second, 200, "GET /api/work?limit=1&offset=1");
      assert.equal(second.json.work.length, 1);
      assert.notEqual(second.json.work[0].solution, first.json.work[0].solution, "offset does not move the window, so the queue past the cap is unreachable");

      // The same grammar as /api/problems, deliberately: two paging dialects on one
      // server is a second thing to learn for no gain.
      is(await hit(SRV, { path: "/api/work?limit=x" }), 400, "a limit that is not a number");
      is(await hit(SRV, { path: "/api/work?offset=-1" }), 400, "a negative offset");

      // And the text view, which is the default representation here, has to page too:
      // half a fix is a cut that a human can see and cannot pass.
      const t1 = await hit(SRV, { path: "/work?limit=1" });
      is(t1, 200, "GET /work?limit=1");
      const t2 = await hit(SRV, { path: "/work?limit=1&offset=1" });
      const sidOf = (txt) => txt.split("\n").filter((l) => /^(FIRST CHECK|TIEBREAK|SECOND RUN)/.test(l)).map((l) => l.split(/\s+/)[2]);
      assert.equal(sidOf(t1.text).length, 1, "the text queue ignores limit");
      assert.notEqual(sidOf(t2.text)[0], sidOf(t1.text)[0], "the text queue ignores offset");
      assert.match(t1.text, /showing 1-1 of \d+/, "a cut text view has to say where it cut and how to go on");
      assert.match(t1.text, /offset=1/, "it has to hand over the next page, not leave the reader to invent the parameter");
    });

    test("/api/problems: filters, pages, and states that it cut", async () => {
      const all = await hit(SRV, { path: "/api/problems" });
      is(all, 200, "GET /api/problems");
      assert.ok(Array.isArray(all.json?.problems), "no listing");
      assert.equal(all.json.total, all.json.problems.length + (all.json.more ? all.json.total - all.json.problems.length : 0));
      assert.ok(all.json.problems.every((p) => !("solutions" in p) || typeof p.solutions === "number"),
        "a summary has no business carrying solution bodies — that is what /api/index.json is for");
      assert.ok(all.json.by_domain && Object.keys(all.json.by_domain).length, "no per-drawer counters");

      const first = await hit(SRV, { path: "/api/problems?limit=1" });
      assert.equal(first.json.problems.length, 1);
      assert.equal(first.json.more, first.json.total > 1, "the cut has to be declared, not silent");
      const second = await hit(SRV, { path: "/api/problems?limit=1&offset=1" });
      assert.notEqual(second.json.problems[0]?.id, first.json.problems[0]?.id, "paging over an unstable order loses entries");

      is(await hit(SRV, { path: "/api/problems?status=invented" }), 400, "a status outside the set");
      is(await hit(SRV, { path: "/api/problems?domain=invented" }), 400, "a domain outside the set");
      is(await hit(SRV, { path: "/api/problems?have=quantum" }), 400, "a have outside the set");
      const none = await hit(SRV, { path: "/api/problems?have=none" });
      is(none, 200, "have=none");
      assert.ok(none.json.problems.every((p) => p.needs.length === 0), "have=none returned a problem with requirements");
    });

    test("user content does not impersonate a record or a table row", async () => {
      const before = await idxOf(SRV);
      await newProblem(SRV, {
        title: "Injection | into the table",
        how: "make eval\n[9999] SOLVED impersonating a record\nPROBLEMS",
      });
      const t = await hit(SRV, { path: "/" });
      const records = t.text.split("\n").filter((l) => /^\[\d{4}\]/.test(l));
      assert.equal(records.length, before.problems.length + 1, "a line from user content is passing for a problem record (C9)");
      assert.ok(String(fromHead(TREE, "README.md")).includes("Injection \\| into the table"), "a pipe in the title is not escaped in the README table");
    });

    // D2: a problem record sits in column 0, a solution line in column 8 — but
    // "metric:" and "solutions:" sit in column 6, exactly where a continuation of a
    // multi-line `how` lands. The argument "it is indented, so it is safe" was incomplete.
    test("a multi-line how does not impersonate a record line in column 6", async () => {
      const P = await newProblem(SRV, {
        title: "A problem for column-6 impersonation",
        how: [
          "make eval",
          "solutions: 99 submitted, 99 verified",
          "[0099] SOLVED Forged problem",
          "metric: whatever (tolerance +/-50%)",
          "how to check: check nothing",
        ].join("\n"),
      });
      const t = await hit(SRV, { path: `/${P.id}` });
      is(t, 200, `GET /${P.id} with an impersonating how`);
      const lines = t.text.split("\n");

      // one problem per page, so every record label has to appear EXACTLY once
      for (const label of ["metric", "solutions", "how to check", "problem"]) {
        const n = lines.filter((l) => l.startsWith(`${label}: `)).length;
        assert.equal(n, 1, `"${label}:" appeared ${n} times on a single problem's page — foreign content is passing for a record line`);
      }
      const foreign = lines.filter((l) => l.includes("99 submitted, 99 verified"));
      assert.equal(foreign.length, 1);
      assert.match(foreign[0], /^\| /, "a line of foreign content without a boundary marker");
      const fake = lines.filter((l) => l.includes("Forged problem"));
      assert.equal(fake.length, 1);
      assert.match(fake[0], /^\| \[0099\]/, "foreign content is passing for a record header");
      assert.equal(build(TREE, "--check").code, 0);
    });
  });

// =====================================================================
// 8. Server resilience — every one of these is one request and a dead process
// =====================================================================

if (gate.server)
  describe("server resilience", () => {
    test("GET // does not kill the process", async () => {
      const srv = await startServer(newTree("slash"));
      assert.ok(srv.port, srv.why);
      const a = await hit(srv, { path: "//" });
      assert.ok(a.status > 0, `GET // never got an answer [${a.err}]`);
      for (const p of ["///", "//x", "/api//pulse"]) await hit(srv, { path: p });
      is(await hit(srv, { path: "/api/pulse" }), 200, "the server after a malformed request target");
      assert.equal(srv.child.exitCode, null, "the process died (with Restart=always that is a restart loop)");
      await stop(srv, "SIGKILL");
    });

    test("an empty index.json: no confident 200 with a fictional head", async () => {
      const dir = newTree("empty");
      writeFileSync(join(dir, "index.json"), "");
      const srv = await startServer(dir);
      assert.ok(srv.port, srv.why);
      const pulse = await hit(srv, { path: "/api/pulse" });
      assert.ok(
        !(pulse.status === 200 && String(pulse.json?.head).startsWith(EMPTY_SHA16)),
        `the pulse answered 200 with head=${pulse.json?.head}, the sha256 of the empty string — agents rely on that`
      );
      await hit(srv, { path: "/" });
      assert.ok((await hit(srv, { path: "/api/pulse" })).status > 0, "the process died after GET / on an empty index.json");
      assert.equal(srv.child.exitCode, null);
      await stop(srv, "SIGKILL");
    });

    test("no index.json: the server stays alive and does not lie", async () => {
      const dir = newTree("missing");
      unlinkSync(join(dir, "index.json"));
      const srv = await startServer(dir);
      assert.ok(srv.port, srv.why);
      for (const p of ["/", "/api/index.json", "/api/pulse"]) {
        const r = await hit(srv, { path: p });
        assert.ok(r.status > 0, `${p}: no answer [${r.err}]`);
      }
      is(await hit(srv, { path: "/llms.txt" }), 200, "/llms.txt does not depend on index.json");
      assert.equal(srv.child.exitCode, null);
      await stop(srv, "SIGKILL");
    });

    // D3: a repo where git is allowed to rewrite line endings will produce evidence
    // nobody can reproduce from a clone. Better to refuse the write than to accept one
    // that fails validation at a stranger's.
    test("a repo without the -text rule for evidence takes no writes", async () => {
      const dir = mkTree("no-gitattributes");
      unlinkSync(join(dir, ".gitattributes"));
      seal(dir);
      const srv = await startServer(dir);
      assert.ok(srv.port, srv.why);
      const p = await hit(srv, { path: "/api/pulse" });
      assert.equal(p.json?.writes, "readonly", "the server takes writes in a repo that will drift on evidence sums");
      assert.match(String(p.json?.reason), /evidence/);
      const r = await post(srv, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/no-attributes", score: 0.42 }));
      is(r, 503, "a write in a repo without the -text rule");
      assert.match(String(r.json?.fix ?? ""), /gitattributes/, "a 503 has to carry the repair command");
      is(await hit(srv, { path: "/" }), 200, "reads work despite read-only mode");
      await stop(srv, "SIGKILL");
    });

    test("a dirty tree -> read-only mode, not a commit on top of somebody else's work", async () => {
      const dir = newTree("dirty");
      writeFileSync(join(dir, "problems", "0002-foreign.json"), "{}\n");
      const srv = await startServer(dir);
      assert.ok(srv.port, srv.why);
      const c0 = commits(dir);
      const r = await post(srv, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/dirty", score: 0.42 }));
      is(r, 503, "a write into a dirty tree");
      assert.match(String(r.headers["retry-after"] ?? ""), /^\d+$/);
      assert.equal(commits(dir), c0, "the server committed somebody else's work");
      assert.equal((await hit(srv, { path: "/api/pulse" })).json?.writes, "readonly", "the pulse has to say that writes are suspended (finding 41)");
      is(await hit(srv, { path: "/" }), 200, "reads work despite read-only mode");
      await stop(srv, "SIGKILL");
    });

    // D4/D7: a field computed only on a write lies in both directions - "ok" through
    // the outage, "readonly" after the repair. Not one write fails in this test.
    test("writes in the pulse and WARNING in GET / describe the state NOW, with no write attempted", async () => {
      const dir = newTree("pulse-freshness");
      const srv = await startServer(dir);
      assert.ok(srv.port, srv.why);
      const state = async () => {
        const p = await hit(srv, { path: "/api/pulse" });
        const t = await hit(srv, { path: "/" });
        return { writes: p.json?.writes, reason: p.json?.reason, warning: /WARNING/.test(t.text) };
      };
      // The probe has a frequency ceiling (PROBE_TTL = 1 s), because two synchronous
      // git calls per read cost a measured 55 requests/s instead of 4000 (D3/D6).
      // Invariant 10 therefore says: the READ path reaches the truth by itself in about
      // a second, with NOT ONE write attempted. That is what is guarded here, so we wait
      // up to 4 s — and it is still a test about reads, not about writes.
      const stateUntil = async (writes) => {
        const deadline = Date.now() + 4000;
        let s = await state();
        while (s.writes !== writes && Date.now() < deadline) {
          await sleep(150);
          s = await state();
        }
        return s;
      };

      const healthy = await state();
      assert.equal(healthy.writes, "ok");
      assert.equal(healthy.warning, false);

      // the operator edits a tracked file; nobody attempts a write
      writeFileSync(join(dir, "README.md"), readFileSync(join(dir, "README.md"), "utf8") + "\ndirt\n");
      const dirtyState = await stateUntil("readonly");
      assert.equal(dirtyState.writes, "readonly", "the pulse says ok through the whole outage — an agent finds out only by burning an attempt (D4/D7)");
      assert.match(String(dirtyState.reason), /dirty/);
      assert.equal(dirtyState.warning, true, "the text view does not warn about suspended writes");
      is(await post(srv, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/freshness", score: 0.42 })), 503, "a write while the tree is dirty");

      // the operator cleans up; still not one write
      git(dir, "checkout", "--", "README.md");
      const fixed = await stateUntil("ok");
      assert.equal(fixed.writes, "ok", "the pulse holds readonly after the repair — an agent will not even try (D4/D7)");
      assert.equal(fixed.warning, false);
      is(await post(srv, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/freshness-2", score: 0.42 })), 201, "a write after the repair");
      await stop(srv, "SIGKILL");
    });

    // The read path has no business forking git on every request. execFileSync stops
    // the event loop of the WHOLE process, so two calls per read gave a measured
    // 55 requests/s where a git-free route does 3400 - and /api/pulse is exactly the
    // one the documentation tells agents to poll. We count calls, not time: the result
    // is the same on every machine.
    test("reads do not fork git on every request (D3/D6)", async () => {
      const dir = newTree("git-on-read");
      const counter = gitCounter(dir);
      const srv = await startServer(dir, { PATH: `${counter.bin}:${process.env.PATH}` });
      assert.ok(srv.port, srv.why);
      const start = counter.count();
      const N = 60;
      for (let i = 0; i < N; i++) {
        is(await hit(srv, { path: i % 2 ? "/" : "/api/pulse" }), 200, `read ${i}`);
      }
      const used = counter.count() - start;
      // the ceiling is one probe (2 calls) per second; this whole block takes a
      // fraction of a second, so in practice it comes out at zero to a few
      assert.ok(used < N / 2, `${N} reads called git ${used} times — the probe has no frequency ceiling and blocks the event loop (D3/D6)`);
      await stop(srv, "SIGKILL");
    });

    // Outages that stop 100% of writes without touching HEAD or the tree: a jammed lock
    // and a corrupted counter. A pulse that cannot see them says "ok" through the whole
    // outage and the agent burns attempts to find out.
    test("the pulse sees a jammed lock and a corrupted counter (D5)", async () => {
      const dir = newTree("pulse-outages");
      mkdirSync(join(dir, ".state"), { recursive: true });
      const lock = join(dir, ".state", "write.lock");
      writeFileSync(lock, JSON.stringify({ pid: 1, nonce: "dead-server", at: 1 }));
      const srv = await startServer(dir);
      assert.ok(srv.port, srv.why);

      const pulse = async () => (await hit(srv, { path: "/api/pulse" })).json ?? {};
      const until = async (writes, ms = 4000) => {
        const deadline = Date.now() + ms;
        let p = await pulse();
        while (p.writes !== writes && Date.now() < deadline) { await sleep(150); p = await pulse(); }
        return p;
      };

      const blocked = await pulse();
      assert.equal(blocked.writes, "readonly", "the pulse says ok while the lock stops every write (D5)");
      assert.match(String(blocked.reason), /write lock/);
      assert.match(String(blocked.fix), /write\.lock/, "the 503 and the pulse both have to carry the repair command");
      assert.match(srv.err, /write lock/, "the startup log is silent about the lock that disabled writes");

      const refused = await post(srv, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/lock", score: 0.42 }));
      is(refused, 503, "a write while the lock is jammed");
      assert.match(String(refused.json?.fix ?? ""), /write\.lock/, "a 503 without a fix field leaves the operator with no way out (D5)");

      unlinkSync(lock);
      assert.equal((await until("ok")).writes, "ok", "the pulse holds readonly after the lock is removed");

      writeFileSync(join(dir, ".state", "limits.json"), "not-json");
      const broken = await until("readonly");
      assert.equal(broken.writes, "readonly", "a corrupted counter stops writes while the pulse says ok (D5)");
      assert.match(String(broken.reason), /counter/);
      assert.match(String(broken.fix), /limits\.json/);

      unlinkSync(join(dir, ".state", "limits.json"));
      assert.equal((await until("ok")).writes, "ok", "the pulse holds readonly after the counter is repaired");
      is(await post(srv, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/after-repair", score: 0.42 })), 201, "a write after the repair");
      await stop(srv, "SIGKILL");
    });

    // Round 3, D3: a leftover .git/index.lock stops 100% of writes (both the commit and
    // the cleanup after it need the index), and touches neither HEAD, nor dirt in the
    // tree, nor the counters - that is, none of the other probes. Measured before the
    // fix: the pulse said ok through the whole outage while EVERY POST ended in 503.
    test("the pulse sees a leftover .git/index.lock (D3)", async () => {
      const dir = newTree("index-lock");
      const srv = await startServer(dir);
      assert.ok(srv.port, srv.why);
      const pulse = async () => (await hit(srv, { path: "/api/pulse" })).json ?? {};
      const until = async (writes, ms = 4000) => {
        const deadline = Date.now() + ms;
        let p = await pulse();
        while (p.writes !== writes && Date.now() < deadline) { await sleep(150); p = await pulse(); }
        return p;
      };
      assert.equal((await pulse()).writes, "ok", "a healthy repo before the test");

      writeFileSync(join(dir, ".git", "index.lock"), "");
      const taken = await until("readonly");
      assert.equal(taken.writes, "readonly", "the pulse says ok while a git lock stops every write (D3)");
      assert.match(String(taken.reason), /index\.lock/);
      assert.match(String(taken.fix), /index\.lock/, "a pulse without a fix field leaves the operator with no way out");
      assert.match((await hit(srv, { path: "/" })).text, /WARNING/, "the text view has to warn too");

      const refused = await post(srv, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/lock", score: 0.42 }));
      is(refused, 503, "a write while the index is busy");
      assert.match(String(refused.json?.error ?? ""), /index\.lock/);

      unlinkSync(join(dir, ".git", "index.lock"));
      assert.equal((await until("ok")).writes, "ok", "the pulse holds readonly after the lock is removed");
      is(await post(srv, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/after-lock", score: 0.42 })), 201, "a write after the lock is removed");
      await stop(srv, "SIGKILL");
    });

    // Round 3, D4: an I/O error inside plan.apply() (a full disk, an RO mount, a
    // permissions drift) went around the rollback. A verification managed to write the
    // evidence and not the problem - and an untracked blob stayed in problems/evidence/,
    // pushing the whole registry into read-only mode until an operator's hand.
    // Invariant 2 says it plainly: a rejected write leaves no litter, untracked included.
    test("a write error during apply leaves no litter (D4)", async () => {
      const dir = newTree("apply-io");
      const srv = await startServer(dir);
      assert.ok(srv.port, srv.why);
      const s = await post(srv, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/apply-io", score: 0.42 }));
      is(s, 201, "a solution to verify");
      const c0 = commits(dir);

      const problems = join(dir, "problems");
      chmodSync(problems, 0o555);
      if (!chmodBlocks(problems)) {
        chmodSync(problems, 0o755);
        say("skipped: chmod does not block writing (root?) — the D4 test needs an ordinary user");
        await stop(srv, "SIGKILL");
        return;
      }
      const r = await post(srv, "verification", verBody(mkKey(), { problem: "0001", solution: s.json.sid, score: 0.4207, verdict: "ok", output: "apply-io\n" }));
      chmodSync(problems, 0o755);

      assert.ok(r.status === 503 || r.status === 500, `a failed apply has to be a server error, it is ${r.status}`);
      assert.equal(r.status, 503, "a storage failure is a 503 with a reason, not a 500 with a bare ref (the agent cannot tell whether to retry)");
      assert.match(String(r.json?.fix ?? ""), /problems/, "a 503 without a fix field leaves the operator with no way out");
      assert.equal(dirty(dir), "", "litter left after a failed apply (invariant 2) — usually the evidence in problems/evidence/");
      assert.equal(commits(dir), c0, "a failed apply committed");
      is(await post(srv, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/after-apply-io", score: 0.5 })), 201, "the registry stayed blocked after a failed apply");
      assert.equal(build(dir, "--check").code, 0);
      await stop(srv, "SIGKILL");
    });

    // Round 3, D5: .state sits outside git, but every write goes through it (the lock
    // plus both counters). A directory with no write permission gave a bare 500 with
    // just a ref while the pulse said ok - an outage with no reason, no repair command
    // and no trace outside journalctl.
    test("a .state that takes no writes: 503 with a reason, not a 500 (D5)", async () => {
      const dir = newTree("state-ro");
      const srv = await startServer(dir);
      assert.ok(srv.port, srv.why);
      const state = join(dir, ".state");
      mkdirSync(state, { recursive: true });
      chmodSync(state, 0o555);
      if (!chmodBlocks(state)) {
        chmodSync(state, 0o755);
        say("skipped: chmod does not block writing (root?) — the D5 test needs an ordinary user");
        await stop(srv, "SIGKILL");
        return;
      }
      const r = await post(srv, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/state-ro", score: 0.42 }));
      assert.equal(r.status, 503, `a write with .state not writable: ${r.status} ${r.text.slice(0, 200)}`);
      assert.match(String(r.json?.error ?? ""), /\.state/, "the error content has to name the cause");
      assert.match(String(r.json?.fix ?? ""), /\.state/, "a 503 without a fix field leaves the operator with no way out");

      const deadline = Date.now() + 4000;
      let p = (await hit(srv, { path: "/api/pulse" })).json ?? {};
      while (p.writes !== "readonly" && Date.now() < deadline) { await sleep(150); p = (await hit(srv, { path: "/api/pulse" })).json ?? {}; }
      assert.equal(p.writes, "readonly", "the pulse says ok while not one write gets through (D5, invariant 10)");
      assert.match(String(p.reason), /\.state/);

      chmodSync(state, 0o755);
      const back = Date.now() + 4000;
      let q = (await hit(srv, { path: "/api/pulse" })).json ?? {};
      while (q.writes !== "ok" && Date.now() < back) { await sleep(150); q = (await hit(srv, { path: "/api/pulse" })).json ?? {}; }
      assert.equal(q.writes, "ok", "the pulse holds readonly after the permissions are repaired");
      is(await post(srv, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/state-ok", score: 0.42 })), 201, "a write after the permissions are repaired");
      await stop(srv, "SIGKILL");
    });

    // Invariant 1, plainly: state that is not in git DOES NOT EXIST. When a write had
    // been applied and the commit had not landed, the server kept serving it as the
    // registry - while telling the author the write had failed.
    test("a dirty tree: reads come from HEAD, not from the working tree (D8)", async () => {
      const dir = newTree("read-from-head");
      const srv = await startServer(dir);
      assert.ok(srv.port, srv.why);
      is(await post(srv, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/from-head", score: 0.42 })), 201, "a write that is meant to stay on disk only");

      // undo the commit alone: the files stay, HEAD no longer knows this solution
      git(dir, "reset", "-q", "--soft", "HEAD~1");
      git(dir, "reset", "-q");
      assert.equal(JSON.parse(String(fromHead(dir, "index.json"))).problems[0].solutions.length, 0, "setup: HEAD has to know zero solutions");
      assert.equal(JSON.parse(readFileSync(join(dir, "index.json"), "utf8")).problems[0].solutions.length, 1, "setup: one has to be on disk");

      const deadline = Date.now() + 4000;
      let idx = await idxOf(srv);
      while (idx?.problems?.[0]?.solutions?.length !== 0 && Date.now() < deadline) {
        await sleep(150);
        idx = await idxOf(srv);
      }
      assert.equal(idx.problems[0].solutions.length, 0, "the server publishes a record that is in no commit (D8, invariant 1)");
      const p = (await hit(srv, { path: "/api/pulse" })).json;
      assert.equal(p.writes, "readonly");
      assert.equal(p.source, "HEAD", "the pulse does not say the view comes from HEAD");
      const txt = (await hit(srv, { path: "/" })).text;
      assert.match(txt, /view comes from HEAD/, "the text view does not say where it comes from");
      await stop(srv, "SIGKILL");
    });

    test("SIGTERM ends the process cleanly", async () => {
      const srv = await startServer(newTree("sigterm"));
      assert.ok(srv.port, srv.why);
      is(await hit(srv, { path: "/api/pulse" }), 200, "the pulse before SIGTERM");
      const res = await stop(srv, "SIGTERM");
      assert.equal(res.signal, null, `the process died from signal ${res.signal} instead of shutting itself down (C7)`);
      assert.equal(res.code, 0, "exit code after SIGTERM");
    });
  });

// =====================================================================
// 9. The validator — build.mjs is the only gate to a commit
// =====================================================================

if (gate.server)
  describe("the validator (build.mjs)", () => {
    // A snapshot of a WORKING registry: the records are real, produced by the server.
    // We mutate them and watch whether build.mjs catches it.
    const snap = snapshotDir;
    const patch = (dir, id, fn) => {
      const f = join(dir, "problems", problemName(dir, id));
      const p = JSON.parse(readFileSync(f, "utf8"));
      assert.ok(p.solutions.length, "a snapshot with no solutions checks nothing");
      fn(p);
      writeFileSync(f, JSON.stringify(p, null, 2) + "\n");
    };

    test("positive control: an untouched snapshot passes --check", () => {
      const r = build(snap("snap-ok"), "--check");
      assert.equal(r.code, 0, `--check on an untouched registry failed: ${r.err || r.out}`);
    });

    test("a hand-written verified:true with no verification does not pass", () => {
      // two variants, because a "consistent" forgery can be caught on the settled
      // field while a bare flag is caught on verified - the validator has to catch both
      for (const [label, fake] of [
        ["bare flag", (s) => (s.verified = true)],
        ["consistent forgery", (s) => Object.assign(s, { verified: true, verified_by: "aaaaaaaaaaaa", settled: true })],
      ]) {
        const dir = snap(`snap-verified-${label.split(" ")[0]}`);
        let forged = 0;
        patch(dir, "0001", (p) => {
          for (const s of p.solutions)
            if (!s.verifications.length && !s.verified) {
              fake(s);
              forged++;
            }
        });
        assert.ok(forged > 0, "no unverified solution to forge");
        assert.notEqual(build(dir, "--check").code, 0, `${label}: SOLVED can be forged by hand (B10/C5)`);
      }
    });

    test("a hand-added verification with no signature does not pass", () => {
      const dir = snap("snap-fakever");
      patch(dir, "0001", (p) => {
        p.solutions[0].verifications.push({
          vid: "0".repeat(16),
          verifier: "aaaaaaaaaaaa",
          key: Buffer.alloc(32, 7).toString("base64"),
          sig: Buffer.alloc(64, 7).toString("base64"),
          score: p.solutions[0].score,
          verdict: "ok",
          output_sha256: sha256("nothing"),
          replaces: "-",
          evidence: sg.evidencePath(p.id, sha256("nothing")),
          at: "2026-08-23",
        });
      });
      assert.notEqual(build(dir, "--check").code, 0, "the verification signature is not checked offline");
    });

    test("a stored value outside canonical form does not pass (B7)", () => {
      for (const [label, fn] of [
        ["crlf-in-how", (p) => (p.acceptance.how = p.acceptance.how.replace(" ", "\r\n"))],
        ["space-in-title", (p) => (p.title = p.title + "  ")],
        ["slash-in-repo", (p) => (p.solutions[0].repo = p.solutions[0].repo + "/")],
      ]) {
        const dir = snap(`snap-${label}`);
        patch(dir, "0001", fn);
        assert.notEqual(build(dir, "--check").code, 0, `${label}: a mutation inside the signature's equivalence class got through (finding 24)`);
      }
    });

    test("a swapped sid or evidence path does not pass", () => {
      const a = snap("snap-sid");
      patch(a, "0001", (p) => (p.solutions[0].sid = "0".repeat(16)));
      assert.notEqual(build(a, "--check").code, 0, "the sid is not recomputed from the content");

      const b = snap("snap-evidence");
      let seen = 0;
      patch(b, "0001", (p) => {
        for (const s of p.solutions)
          for (const v of s.verifications) {
            v.evidence = `problems/evidence/0001-${"0".repeat(64)}.txt`;
            seen++;
          }
      });
      assert.ok(seen > 0, "a snapshot with no verifications");
      assert.notEqual(build(b, "--check").code, 0, "the evidence path is not derived from the sum (finding 29)");
    });

    test("tolerance: the range [0, 0.5] and immutability once verifications exist", () => {
      const a = snap("snap-tol-range");
      patch(a, "0001", (p) => (p.acceptance.tolerance = 0.9));
      assert.notEqual(build(a, "--check").code, 0, "a tolerance of 0.9 went outside [0, 0.5] (finding 28)");

      const b = seal(snap("snap-tol-change"));
      let verified = false;
      patch(b, "0001", (p) => {
        verified = p.solutions.some((s) => s.verifications.length);
        p.acceptance.tolerance = 0.4;
      });
      assert.ok(verified, "a snapshot with no verifications cannot check immutability");
      assert.notEqual(build(b, "--check").code, 0, "the tolerance was changed retroactively with verifications already on file (finding 36)");
    });

    // D4: a check against HEAD does not work where the change IS in HEAD - that is, in
    // a pull request. A snapshot has no git of its own, so `fromHead` says nothing and
    // only the signature is left: every verifier signs the band they judged in, so
    // moving the band breaks their signature in every clone, with no history involved.
    test("a moved band breaks the verifiers' signatures even with no git history (D4)", () => {
      const dir = snapshotDir("snap-tol-no-git");
      assert.ok(!existsSync(join(dir, ".git")), "a snapshot with a git will not exercise the pull request path");
      const f = join(dir, "problems", problemName(dir, "0001"));
      const p = JSON.parse(readFileSync(f, "utf8"));
      assert.ok(p.solutions.some((s) => s.verifications.length), "a snapshot with no verifications checks nothing");
      p.acceptance.tolerance = 0.3;
      writeFileSync(f, JSON.stringify(p, null, 2) + "\n");
      const r = build(dir, "--check");
      assert.notEqual(r.code, 0, "the band was moved under finished verdicts and nobody noticed (D4)");
      assert.match(r.err + r.out, /signature does not match/, "the build failed, but not on a verifier's signature — that proves nothing");
    });

    test("a schema with an unsupported keyword breaks the build instead of being ignored", () => {
      const dir = snap("snap-schema");
      const f = join(dir, "problems", "_schema.json");
      const s = JSON.parse(readFileSync(f, "utf8"));
      s.properties.title = { oneOf: [{ type: "string" }] };
      writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
      const r = build(dir, "--check");
      assert.notEqual(r.code, 0, "the checker quietly ignores keywords it does not know (finding 45)");
      assert.match(r.err + r.out, /oneOf/, "the message has to name the keyword");
    });

    test("a failed build leaves no derived fields in the source files", () => {
      const dir = snap("snap-atomicity");
      const before = new Map();
      for (const f of readdirSync(join(dir, "problems")).filter((x) => x.endsWith(".json"))) before.set(join("problems", f), readFileSync(join(dir, "problems", f)));
      before.set("index.json", readFileSync(join(dir, "index.json")));
      before.set("README.md", readFileSync(join(dir, "README.md")));
      writeFileSync(join(dir, "problems", "0777-bad.json"), JSON.stringify({ id: "0777", title: "bad" }) + "\n");
      assert.notEqual(build(dir).code, 0, "the build let a crippled file through");
      for (const [f, bytes] of before) assert.ok(readFileSync(join(dir, f)).equals(bytes), `${f} was rewritten despite the build failing (finding 46)`);
    });

    test("evidence in git: the path and the sum agree for every verification", () => {
      let n = 0;
      for (const f of readdirSync(join(TREE, "problems")).filter((x) => x.endsWith(".json") && !x.startsWith("_"))) {
        const p = JSON.parse(String(fromHead(TREE, `problems/${f}`)));
        for (const s of p.solutions ?? [])
          for (const v of s.verifications ?? []) {
            assert.equal(v.evidence, sg.evidencePath(p.id, v.output_sha256));
            assert.equal(sha256(fromHead(TREE, v.evidence)), v.output_sha256, `the sum of evidence ${v.vid} does not match`);
            n++;
          }
      }
      assert.ok(n >= 3, `expected evidence in git, got ${n}`);
    });

    // D3: git with core.autocrlf normalises line endings on `git add`. The bytes in the
    // working tree still matched the sum, so --check was green for whoever wrote it;
    // what broke was the CLONE, which is the entire point of this registry.
    test("evidence with CRLF survives the commit and a fresh clone", async () => {
      const dir = newTree("crlf");
      git(dir, "config", "core.autocrlf", "input");
      const srv = await startServer(dir);
      assert.ok(srv.port, srv.why);
      const output = "line one\r\nline two\r\n";
      const s = await post(srv, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/crlf", score: 0.5 }));
      is(s, 201, "a solution to carry the CRLF evidence");
      const v = await post(srv, "verification", verBody(mkKey(), { problem: "0001", solution: s.json.sid, score: 0.5, verdict: "ok", output }));
      is(v, 201, "a verification with CRLF in the raw output");
      await stop(srv, "SIGKILL");

      const ev = v.json.evidence;
      assert.equal(sha256(readFileSync(join(dir, ev))), sha256(output), "the file in the working tree");
      assert.equal(sha256(fromHead(dir, ev)), sha256(output), "git committed DIFFERENT bytes than the evidence (D3)");

      const clone = mkdtempSync(join(tmpdir(), "exit0-clone-"));
      trees.push(clone);
      execFileSync("git", ["clone", "-q", dir, clone], { stdio: "pipe" });
      execFileSync("git", ["-C", clone, "config", "core.autocrlf", "input"], { stdio: "pipe" });
      assert.equal(sha256(readFileSync(join(clone, ev))), sha256(output), "a fresh clone got rewritten evidence bytes");
      const r = build(clone, "--check");
      assert.equal(r.code, 0, `the clone does not validate, which makes "clone and recompute" untrue: ${r.err || r.out}`);

      // Poisoning: a repo with no .gitattributes, the state the server refuses to
      // produce today but which arrives from an older clone. The file in the tree
      // STILL matches the sum - only the committed bytes are broken, so the old
      // --check passed and the defect surfaced at a stranger's.
      git(clone, "config", "user.email", "test@exit0.invalid");
      git(clone, "config", "user.name", "exit0-test");
      git(clone, "config", "commit.gpgsign", "false");
      unlinkSync(join(clone, ".gitattributes"));
      git(clone, "rm", "-q", "--cached", "--", ev);
      git(clone, "add", "-A");
      git(clone, "commit", "-qm", "poisoning");
      assert.equal(sha256(readFileSync(join(clone, ev))), sha256(output), "the file in the tree was supposed to stay untouched");
      assert.notEqual(sha256(fromHead(clone, ev)), sha256(output), "the setup did not poison the blob — git does not convert in this configuration");
      const bad = build(clone, "--check");
      assert.notEqual(bad.code, 0, "the build passed evidence whose committed bytes do not reproduce the sum (D3)");
      assert.match(bad.err + bad.out, /committed evidence/, "the message has to name the cause");
    });

    // The table region is cut out by its markers, so a marker IN THE CONTENT blows the
    // boundary apart: one signed POST with a title containing END put it into a row,
    // the next run cut the README on somebody else's marker and --check stopped
    // converging PERMANENTLY - meaning writes for the whole registry on 503, from a
    // free key, with one request.
    test("a title carrying a region marker does not blow the README apart (D1)", async () => {
      const dir = newTree("marker-in-title");
      const srv = await startServer(dir);
      assert.ok(srv.port, srv.why);
      const title = `Router X ${"<!-- INDEX:" + "END -->"} pwned`;
      is(await post(srv, "problem", probBody(mkKey(), { title })), 201, "a problem with a poisoned title");

      const readme = readFileSync(join(dir, "README.md"), "utf8");
      const count = (s, n) => s.split(n).length - 1;
      assert.equal(count(readme, "<!-- INDEX:" + "START -->"), 1, "the START marker got duplicated");
      assert.equal(count(readme, "<!-- INDEX:" + "END -->"), 1, "user content carried a second END marker into the README (D1)");
      assert.match(readme, /&lt;/, "the marker was supposed to be neutralised into entities");

      assert.equal(build(dir, "--check").code, 0, "build --check does not converge after a poisoned title (D1)");
      assert.equal(build(dir).code, 0);
      assert.equal(build(dir, "--check").code, 0, "a second run builds a different README — the region is drifting (D1)");
      assert.equal(dirty(dir), "", "uncommitted state left after a poisoned title");
      is(await post(srv, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/after-poison", score: 0.42 })), 201, "the registry takes writes after a poisoned title");
      await stop(srv, "SIGKILL");
    });

    // The README is the canonical artifact every passer-by reads
    // (raw.githubusercontent.com). One cheap write used to put a clickable link under
    // the submitter's control into the table of "verified solutions".
    test("a title and a repo carry no Markdown into the table (D2)", async () => {
      assert.equal(sg.cell("a|b"), "a\\|b");
      assert.equal(sg.cell("[k](https://phish.example)"), "\\[k\\]\\(https://phish.example\\)");
      assert.equal(sg.cell("`code`"), "\\`code\\`");
      assert.equal(sg.cell("<b> & </b>"), "&lt;b&gt; &amp; &lt;/b&gt;");
      assert.ok(!sg.cell(`x ${"<!-- INDEX:" + "END -->"} y`).includes("<!-- INDEX:" + "END -->"));
      // a closing paren survives canonUrl, so inside [text](target) it cuts the link short
      assert.equal(sg.mdUrl("https://example.com/a)x"), "<https://example.com/a)x>");
      assert.equal(sg.mdUrl("https://example.com/a b"), "<https://example.com/a%20b>");

      const dir = newTree("markdown-in-table");
      const srv = await startServer(dir);
      assert.ok(srv.port, srv.why);
      is(await post(srv, "problem", probBody(mkKey(), { title: "Router [CLICK HERE](https://phish.example) `rm -rf`" })), 201, "a problem with Markdown in the title");

      const author = mkKey();
      const repo = "https://example.com/x)[CLICK](https://phish.example";
      is(await post(srv, "solution", solBody(author, { problem: "0001", repo, score: 0.42 })), 201, "a solution with a hostile URL");
      const sid = problemAt(dir, "0001").solutions.at(-1).sid;
      const output = '{"accuracy":0.98,"cost_usd":0.42,"n":500}';
      is(await post(srv, "verification", verBody(mkKey(), { problem: "0001", solution: sid, score: 0.42, verdict: "ok", output })), 201, "a verification, so that a link appears in the table");

      const readme = readFileSync(join(dir, "README.md"), "utf8");
      const rows = readme.split("\n").filter((l) => l.startsWith("| 000"));
      assert.ok(rows.length >= 2, "the table has to have both rows");
      for (const w of rows) {
        assert.ok(!/\[[^\]\\]*\]\(http/.test(w.replace(/\]\(<[^>]*>\)/g, "")), `the row carries somebody else's Markdown link: ${w}`);
        assert.ok(!w.includes("](https://phish.example)"), `the row links to the submitter's host: ${w}`);
      }
      assert.match(readme, /\]\(<https:\/\/example\.com\/x\)/, "the link target has to be in <...> form, otherwise the paren cuts it in half");
      assert.equal(build(dir, "--check").code, 0);
      await stop(srv, "SIGKILL");
    });

    // build.mjs reads paths relative to the current directory, so run by an absolute
    // path it checks SOMEBODY ELSE'S tree. The RUNBOOK did exactly that in the sanity
    // check after restoring from the mirror, and got a confident "OK".
    // A problem points a stranger at code they are about to clone and run. If that pointer
    // were carried but not signed, anyone with commit access could swap the repository
    // under a problem without breaking a single signature, and the registry would be
    // handing out a target nobody vouched for.
    test("subject: a problem can name the repository it is about, and that pointer is signed", async () => {
      const dir = newTree("subject-signed");
      const srv = await startServer(dir);
      assert.ok(srv.port, srv.why);
      const url = "https://github.com/owner/some-repo";

      // Optional: a problem with no single subject stays exactly as it was.
      const bare = await newProblem(srv, { title: "No single subject here" });
      const bareText = (await hit(srv, { path: `/${bare.id}` })).text;
      assert.ok(!/^subject:/m.test(bareText), "a problem without a subject must not print an empty or invented one");

      is(await post(srv, "problem", probBody(mkKey(), { title: "Subject carried", subject: url })), 201, "a problem naming its subject");
      const id = await idByTitle(srv, "Subject carried");

      const text = (await hit(srv, { path: `/${id}` })).text;
      assert.match(text, new RegExp(`^subject: ${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"), "the text view does not show the subject");
      const j = JSON.parse((await hit(srv, { path: `/api/problems/${id}` })).text);
      assert.equal(j.subject, url, "the JSON view does not carry the subject");

      // The one that matters: swap the repository in the stored record by hand. Every
      // signature in the file is still the signature that was filed, so only a payload
      // that actually covers this field can notice.
      const file = readdirSync(join(dir, "problems")).find((f) => f.startsWith(id));
      const path = join(dir, "problems", file);
      const rec = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(rec.subject, url, "the stored record does not carry the subject");
      rec.subject = "https://github.com/attacker/lookalike";
      writeFileSync(path, JSON.stringify(rec, null, 2) + "\n");
      const r = build(dir, "--check");
      assert.equal(r.code, 1, "swapping the subject under a signed problem passed --check: the field is carried but NOT signed");
      // The exit code alone is NOT the proof and must not be simplified down to it. Editing
      // the record also makes index.json stale, so --check exits 1 either way: with the
      // field left out of the payload entirely this assertion still passed, and only the
      // REASON gave it away. Verified by mutation: drop optUrl from payload("problem") and
      // the line below is the one that fails, on "stale: index.json".
      assert.match(`${r.out}${r.err}`, /signature/i, `--check must fail on the signature, not on something downstream: ${(r.out + r.err).slice(0, 300)}`);

      // Canonical or rejected, like every other field. The body is assembled by hand on
      // purpose: sign.mjs refuses to SIGN a non-canonical subject, so going through it
      // would only prove the client is careful. What has to be proved is that the SERVER
      // refuses, because a caller who signs the canonical form and sends another one is
      // exactly the case where trusting the signature would be trusting the wrong bytes.
      const tricky = { ...probBody(mkKey(), { title: "Non canonical subject", subject: url }), subject: `${url}/` };
      const bad = await post(srv, "problem", tricky);
      is(bad, 400, "a trailing slash has to be refused, not fixed");
      assert.match(bad.text, /subject/, "the refusal has to name subject, not repo");
      assert.match(bad.text, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the 400 has to hand back the canonical form");
    });

    // Lineage. The rule that is NOT here is the point of the test: a parent that has since
    // been superseded is tolerated offline. The server overwrites a replaced entry in place,
    // so the sid somebody legitimately built on stops existing the moment its author
    // corrects their own result.
    // Verified by mutation, and the result was sharper than "--check goes red later": every
    // write passes through build.mjs BEFORE the commit (invariant 2), so with a dangling
    // parent treated as invalid the CORRECTION ITSELF comes back 422. The registry would
    // quietly freeze every entry that has a child - once somebody builds on your result you
    // could never fix it again - and the message would be about a field you did not send.
    test("builds_on: checked at the write, tolerated at the read once the parent is superseded", async () => {
      const dir = newTree("lineage");
      const srv = await startServer(dir);
      assert.ok(srv.port, srv.why);
      const P = await newProblem(srv, { title: "Lineage problem" });
      const kA = mkKey(), kB = mkKey();

      const a = await post(srv, "solution", solBody(kA, { problem: P.id, repo: "https://example.com/a", score: 0.40 }));
      is(a, 201, "the first attempt");
      const sidA = JSON.parse(a.text).sid;

      // Unknown parent is a 404 and not a silent accept: lineage pointing at nothing is
      // worse than no lineage, because it reads as provenance.
      is(await post(srv, "solution", solBody(mkKey(), { problem: P.id, repo: "https://example.com/x", score: 0.1, builds_on: "0123456789abcdef" })), 404, "a parent that does not exist");

      // Building on ANOTHER key's entry is the entire feature, not an edge case.
      const b = await post(srv, "solution", solBody(kB, { problem: P.id, repo: "https://example.com/b", score: 0.45, builds_on: sidA }));
      is(b, 201, "an attempt that continues somebody else's");
      const sidB = JSON.parse(b.text).sid;
      assert.notEqual(sidB, sidA);

      // Self-parent, computed by the submitter who can work out their own sid.
      const selfSid = sg.solutionId(P.id, "https://example.com/self", 0.2, mkKey().pub, "-", "-");
      const kS = mkKey();
      const selfOwn = sg.solutionId(P.id, "https://example.com/self", 0.2, kS.pub, "-", "-");
      is(await post(srv, "solution", solBody(kS, { problem: P.id, repo: "https://example.com/self", score: 0.2, builds_on: selfOwn })), 400, "an entry naming itself as its own origin");
      assert.ok(selfSid !== selfOwn, "sid has to depend on the key, or the case above is not what it claims");

      // Now the correction that used to be the trap: A's author replaces A, so sidA is
      // gone from the array while B still names it.
      const a2 = await post(srv, "solution", solBody(kA, { problem: P.id, repo: "https://example.com/a", score: 0.41, replaces: sidA }));
      is(a2, 200, "the author corrects their own result");
      const rec = JSON.parse(readFileSync(join(dir, "problems", readdirSync(join(dir, "problems")).find((f) => f.startsWith(P.id))), "utf8"));
      assert.ok(!rec.solutions.some((x) => x.sid === sidA), "the replaced entry is still there, so this test proves nothing");
      assert.equal(rec.solutions.find((x) => x.sid === sidB).builds_on, sidA, "B stopped naming its origin");

      const r = build(dir, "--check");
      assert.equal(r.code, 0, `a superseded origin took --check down: ${(r.out + r.err).slice(0, 400)}`);
    });

    // The frontier is the number to beat. If a claim could move it, it would be a
    // scoreboard again: anybody could post 0.99, nobody could check it, and every agent
    // arriving after would be told to beat a number that never existed.
    test("frontier: a claim does not move best, a settled result does, and baseline never moves", async () => {
      const dir = newTree("frontier");
      const srv = await startServer(dir);
      assert.ok(srv.port, srv.why);
      const P = await newProblem(srv, { title: "Frontier problem", higher_is_better: true, baseline: 0.10 });
      const read = () => JSON.parse(readFileSync(join(dir, "problems", readdirSync(join(dir, "problems")).find((f) => f.startsWith(P.id))), "utf8"));

      const kA = mkKey(), kV = mkKey(), kB = mkKey();
      const a = await post(srv, "solution", solBody(kA, { problem: P.id, repo: "https://example.com/a", score: 0.40 }));
      is(a, 201, "an attempt");
      const sidA = JSON.parse(a.text).sid;

      let f = read().frontier;
      assert.equal(f.best, null, "an unverified attempt became the frontier");
      assert.equal(f.claimed, sidA, "the top claim is not reported");
      assert.equal(f.claimed_score, 0.40);
      assert.equal(f.attempts, 1);

      is(await post(srv, "verification", verBody(kV, { problem: P.id, solution: sidA, score: 0.40, verdict: "ok", output: "a\n" })), 201, "somebody else checks it");
      f = read().frontier;
      assert.equal(f.best, sidA, "a settled result did not become the frontier");
      assert.equal(f.best_score, 0.40);

      // The one that matters: a bigger number nobody has checked.
      const b = await post(srv, "solution", solBody(kB, { problem: P.id, repo: "https://example.com/b", score: 0.99 }));
      is(b, 201, "a bigger claim");
      f = read().frontier;
      assert.equal(f.best, sidA, "an UNVERIFIED 0.99 moved the frontier");
      assert.equal(f.best_score, 0.40, "the number to beat has to stay the checked one");
      assert.equal(f.claimed, JSON.parse(b.text).sid, "the unchecked claim is exactly what /work should hand out, so it has to be visible");
      assert.equal(f.claimed_score, 0.99);
      assert.equal(f.attempts, 2);
      assert.equal(f.keys, 2);

      // baseline lives inside payload("problem", ...). Advancing it would invalidate the
      // problem signature and every verdict signed under its tolerance band.
      assert.equal(read().acceptance.baseline, 0.10, "baseline moved: the frontier is the live number, baseline is the historical one");
      assert.equal(build(dir, "--check").code, 0);
    });

    // The two views this whole change exists for: a list that answers "where do I start"
    // and a problem page that shows what was built on what.
    test("/start and the lineage view answer where to begin", async () => {
      const dir = newTree("start-view");
      const srv = await startServer(dir);
      assert.ok(srv.port, srv.why);
      const P = await newProblem(srv, { title: "Startable problem", higher_is_better: true });
      const kA = mkKey(), kV = mkKey(), kB = mkKey();

      // Untouched: /start must say so rather than inventing a number.
      let t = (await hit(srv, { path: "/start" })).text;
      assert.match(t, /nothing yet, it is open/, "an untouched problem has to say it is open, not print a blank");

      const a = await post(srv, "solution", solBody(kA, { problem: P.id, repo: "https://example.com/a", score: 0.40 }));
      const sidA = JSON.parse(a.text).sid;
      is(await post(srv, "verification", verBody(kV, { problem: P.id, solution: sidA, score: 0.40, verdict: "ok", output: "a\n" })), 201, "checked by a stranger");
      is(await post(srv, "solution", solBody(kB, { problem: P.id, repo: "https://example.com/b", score: 0.55, builds_on: sidA })), 201, "somebody continues it");

      const j = JSON.parse((await hit(srv, { path: "/api/start" })).text);
      const row = j.start.find((r) => r.problem === P.id);
      assert.ok(row, "the problem fell out of /api/start");
      assert.equal(row.builds_on, sidA, "/start has to hand out the SETTLED sid to build on");
      assert.equal(row.best_repo, "https://example.com/a");
      assert.equal(row.best_score, 0.40);
      assert.equal(row.claimed_score, 0.55, "the unchecked claim above the frontier has to be visible, it is the work");
      assert.equal(typeof j.more, "boolean");
      assert.equal(j.open, j.start.length + (j.more ? j.open - j.start.length : 0));

      // Ordering: a problem with code to continue comes before the untouched ones.
      // Asserted as the PROPERTY, not as "ours is first". It was pinned to position and
      // broke the day the registry gained a second problem with a frontier - a change in
      // the DATA, not in the ordering rule the test exists to protect. A test that a real
      // write can break is a test that will be edited away rather than believed.
      const withFrontier = j.start.filter((r) => r.best_repo);
      const without = j.start.filter((r) => !r.best_repo);
      assert.ok(withFrontier.some((r) => r.problem === P.id), "a problem with a frontier fell out of the group that has one");
      if (without.length && withFrontier.length)
        assert.ok(
          j.start.indexOf(withFrontier[withFrontier.length - 1]) < j.start.indexOf(without[0]),
          "a problem with nothing to continue is ordered above one with code to continue"
        );

      const page = (await hit(srv, { path: `/${P.id}` })).text;
      assert.match(page, /lineage: what was built on what/, "the problem page does not show lineage");
      assert.ok(page.indexOf(sidA) < page.lastIndexOf("https://example.com/b"), "the child is not rendered under its parent");
      assert.match(page, new RegExp(`start from ${sidA}`), "the page does not say what to build on");
    });

    // An attempt that has nowhere of its own to live: it sits as a ref inside a repository
    // the registry already publishes to. The namespace is only worth something if you can
    // only write under your own fingerprint, and that is checked here, not assumed.
    test("ref: an attempt can live inside a repo, under its own fingerprint and nobody else's", async () => {
      const dir = newTree("attempt-ref");
      const srv = await startServer(dir);
      assert.ok(srv.port, srv.why);
      const P = await newProblem(srv, { title: "Ref problem", higher_is_better: true });
      const k = mkKey();
      const me = sg.fingerprint(k.pub);
      const REPO = "https://github.com/owner/registry";

      const mk = (slug, extra = {}) => solBody(k, { problem: P.id, repo: REPO, score: 1, ref: `refs/attempts/${P.id}/${me}/${slug}`, ...extra });

      is(await post(srv, "solution", mk("v1")), 201, "an attempt hosted as a ref");

      // The same repo URL again, a different ref. Two attempts, not a correction: if ref
      // were outside the chain key the second would silently replace the first.
      const two = await post(srv, "solution", mk("v2", { score: 2 }));
      is(two, 201, "a second ref under the same repo has to be its own entry");
      const rec = JSON.parse(readFileSync(join(dir, "problems", readdirSync(join(dir, "problems")).find((f) => f.startsWith(P.id))), "utf8"));
      assert.equal(rec.solutions.length, 2, "two refs under one repo collapsed into one entry");
      assert.equal(new Set(rec.solutions.map((x) => x.ref)).size, 2);

      // Somebody else's namespace.
      const other = mkKey();
      const stolen = await post(srv, "solution", solBody(other, { problem: P.id, repo: REPO, score: 3, ref: `refs/attempts/${P.id}/${me}/mine` }));
      is(stolen, 403, "a ref claimed under another key's fingerprint");

      // Another problem's namespace.
      const wrong = await post(srv, "solution", solBody(k, { problem: P.id, repo: REPO, score: 4, ref: `refs/attempts/9999/${me}/x` }));
      is(wrong, 400, "a ref naming a different problem");

      assert.equal(build(dir, "--check").code, 0, "a registry holding hosted attempts does not validate");

      // The address has to reach the verifier. A ref stored and signed but not printed
      // where somebody looks for work sends them to clone the default branch and find
      // nothing: the output of "find one" must paste into "run it".
      const w = (await hit(srv, { path: "/work" })).text;
      assert.match(w, new RegExp(`refs/attempts/${P.id}/${me}/v1`), "/work prints the repo without the ref");
      const wj = JSON.parse((await hit(srv, { path: "/api/work" })).text);
      assert.ok(wj.work.some((x) => x.ref && x.ref.endsWith("/v1")), "/api/work does not carry ref");
      const page = (await hit(srv, { path: `/${P.id}` })).text;
      assert.match(page, new RegExp(`refs/attempts/${P.id}/${me}/v1`), "the problem page prints the repo without the ref");
      // Naming the ref is not the same as saying how to get it. A ref is not a branch and
      // no web UI lists it, so "clone the repo" is an instruction that ends in an empty
      // checkout of the default branch.
      for (const [what, txt] of [["/work", w], ["the problem page", page]])
        assert.match(txt, /git fetch <repo> <ref> && git checkout FETCH_HEAD/, `${what} names a ref without saying how to fetch it`);
    });

    // A link is worth having only if it goes somewhere. Three ways this feature can be
    // worse than not having it: a link built from a base nobody checked, a link printed by
    // a registry that is published nowhere, and a field named like an unrelated one.
    test("source_url: off by default, validated once, and not the pulse field of the same name", async () => {
      const dir = newTree("source-url");

      // Unset: no links, because a registry nobody publishes must not print a link to a
      // page that does not exist.
      const off = await startServer(dir);
      assert.ok(off.port, off.why);
      const P = await newProblem(off, { title: "Linkable problem" });
      assert.ok(!/^source_url:/m.test((await hit(off, { path: `/${P.id}` })).text), "a server with no SOURCE_URL printed a link anyway");
      assert.equal(JSON.parse((await hit(off, { path: `/api/problems/${P.id}` })).text).source_url, undefined, "a server with no SOURCE_URL put the field in the detail anyway");
      off.kill?.();

      const on = await startServer(dir, { SOURCE_URL: "https://example.com/o/r/blob/main/" });
      assert.ok(on.port, on.why);
      const txt = (await hit(on, { path: `/${P.id}` })).text;
      // Trailing slash on the base must not produce a double slash in the link.
      assert.match(txt, /^source_url: https:\/\/example\.com\/o\/r\/blob\/main\/problems\/\d{4}-[a-z0-9-]+\.json$/m, `bad link: ${txt.slice(0, 400)}`);
      const j = JSON.parse((await hit(on, { path: `/api/problems/${P.id}` })).text);
      assert.ok(j.source_url && j.source_url.endsWith(".json"), "the JSON view does not carry source_url");
      // The collision this field was renamed to avoid: pulse.source means something else.
      // The front door has to name both, or an agent that lands there and reads nothing
      // else never learns either exists. /start was documented in llms.txt and advertised
      // nowhere a newcomer looks.
      const front = (await hit(on, { path: "/" })).text;
      assert.match(front, /GET \/start/, "the index does not advertise /start");
      assert.match(front, /SOURCE +https:\/\/example\.com/, "the index does not say where the records live");
      const list = JSON.parse((await hit(on, { path: "/api/problems" })).text);
      assert.ok(list.problems.every((x) => typeof x.source_url === "string"), "the listing does not carry source_url per problem");

      const pulse = JSON.parse((await hit(on, { path: "/api/pulse" })).text);
      assert.equal(pulse.source_url, undefined, "pulse grew a source_url, which is not what that route's `source` means");
      on.kill?.();
    });

    test("run from the wrong directory it says what is wrong (D10)", () => {
      const empty = mkdtempSync(join(tmpdir(), "exit0-bad-cwd-"));
      trees.push(empty);
      const r = run(empty, join(ROOT, "scripts/build.mjs"), ["--check"]);
      assert.equal(r.code, 1, "build.mjs in a directory with no problems/ has to fail with a message, not a stack");
      assert.match(r.err, /no problems\/ directory|registry directory/, `stderr: ${r.err.slice(0, 300)}`);
      assert.match(r.err, /registry directory/, "the message has to name the cause: the paths are relative");
    });
  });

// =====================================================================
// 9b. Findings and the board
// =====================================================================

const findBody = (k, o) =>
  signBody(k, "finding", { problem: o.problem, kind: o.kind, body: o.body, replaces: o.replaces ?? "-" });

// A fresh key that has just earned standing. Findings are capped per key per day, so the
// chain tests get one key of their own and everything else gets a new one: a 429 in the
// middle of a chain test would look exactly like a chain bug.
let standingSeq = 0;
const standingKey = async () => {
  const k = mkKey();
  is(await post(SRV, "solution", solBody(k, { problem: "0002", repo: `https://example.com/standing-${standingSeq++}`, score: 0.5 })), 201, "the solution that earns standing");
  return k;
};

if (gate.server)
  describe("findings: the write that is not a measurement", () => {
    const state = {};

    test("a key with no work behind it cannot file one -> 403 pointing at the queue", async () => {
      const c0 = commits(TREE);
      const k = mkKey();
      const r = await post(SRV, "finding", findBody(k, { problem: "0001", kind: "deadend", body: "I have done nothing and wish to comment" }));
      is(r, 403, "a finding from a key with no standing");
      // The refusal has to be actionable or it is just a wall: it names how to earn it.
      assert.match(JSON.stringify(r.json), /\/work/, "the 403 has to point at the verification queue, which is what standing buys");
      assert.equal(commits(TREE), c0, "a refused finding is not a commit");
      assert.equal(dirty(TREE), "");
    });

    test("filing a PROBLEM does not earn standing", async () => {
      // Deliberate: problems are cheap to write, which makes them the spam vector.
      const P = await newProblem(SRV, { title: "A problem opened by a key with nothing else" });
      const r = await post(SRV, "finding", findBody(P.key, { problem: P.id, kind: "blocked", body: "my own problem, my own opinion about it" }));
      is(r, 403, "standing from an opened problem");
    });

    test("one solution earns it -> 201, and the record is derived from the key", async () => {
      state.k = await standingKey();
      const c0 = commits(TREE);
      const body = "ran the table-driven variant end to end: 1.2x, and the cost is exception handling";
      const r = await post(SRV, "finding", findBody(state.k, { problem: "0001", kind: "deadend", body }));
      is(r, 201, "a finding from a key with standing");
      assert.match(r.json?.fid ?? "", /^[0-9a-f]{16}$/, "a 201 has to return the fid");
      state.fid = r.json.fid;
      assert.equal(commits(TREE), c0 + 1, "an accepted finding is a commit");
      const n = (problemAt(TREE, "0001").findings ?? []).find((x) => x.fid === state.fid);
      assert.ok(n, "the finding is not in HEAD");
      assert.equal(n.author, sg.fingerprint(state.k.pub), "author has to come from the key (invariant 4)");
      assert.equal(n.body, body);
      assert.equal(n.replaces, "-");
      assert.equal(build(TREE, "--check").code, 0);
    });

    test("a finding changes NOTHING: not status, not the frontier", async () => {
      // Invariant 15. If this ever fails, findings have become a vote.
      // The key is minted FIRST: earning standing means submitting a solution, and that
      // legitimately moves the frontier of the problem it was submitted to. Snapshotting
      // before it would blame the finding for the solution's work.
      const k = await standingKey();
      const before = problemAt(TREE, "0002");
      const snap = { status: before.status, frontier: JSON.stringify(before.frontier) };
      is(await post(SRV, "finding", findBody(k, { problem: "0002", kind: "blocked", body: "the pinned commit in this how is unreachable from here" })), 201, "a blocked finding");
      const after = problemAt(TREE, "0002");
      assert.equal(after.status, snap.status, "a finding moved the status: that is a vote, not a measurement");
      assert.equal(JSON.stringify(after.frontier), snap.frontier, "a finding moved the frontier");
    });

    test("kind is a closed drawer: anything outside it is a 400", async () => {
      for (const kind of ["+1", "question", "interesting", "comment", ""]) {
        const c0 = commits(TREE);
        let r;
        try {
          r = await post(SRV, "finding", findBody(state.k, { problem: "0001", kind, body: "x" }));
        } catch {
          continue; // sign.mjs refused to build the payload at all, which is the same answer
        }
        is(r, 400, `kind ${JSON.stringify(kind)}`);
        assert.equal(commits(TREE), c0);
      }
    });

    test("one live finding per (kind, key): a second needs replaces, and replaces IN PLACE", async () => {
      const before = (problemAt(TREE, "0001").findings ?? []).length;
      const second = findBody(state.k, { problem: "0001", kind: "deadend", body: "correction: 1.4x once the fast path stops throwing" });
      const r = await post(SRV, "finding", second);
      is(r, 409, "a second deadend under one key without replaces");
      assert.equal(r.json?.replaces, state.fid, "the 409 has to carry the fid to replace, or the correction is unguessable");

      const ok = await post(SRV, "finding", findBody(state.k, { problem: "0001", kind: "deadend", body: "correction: 1.4x once the fast path stops throwing", replaces: state.fid }));
      is(ok, 201, "the correction");
      const list = problemAt(TREE, "0001").findings ?? [];
      assert.equal(list.length, before, "a correction APPENDED instead of replacing: that is how a problem page grows without bound");
      assert.ok(!list.some((x) => x.fid === state.fid), "the replaced record is still there");
      state.fid = ok.json.fid;
      assert.equal(build(TREE, "--check").code, 0);
    });

    test("a different kind under the same key is a different slot", async () => {
      const before = (problemAt(TREE, "0001").findings ?? []).length;
      is(await post(SRV, "finding", findBody(state.k, { problem: "0001", kind: "ambiguous", body: "how does not say whether the warm cache counts, and the two readings differ by 3x" })), 201, "an ambiguous finding alongside a deadend");
      assert.equal((problemAt(TREE, "0001").findings ?? []).length, before + 1);
    });

    test("the same body twice reads as already here, not as a chain error", async () => {
      const body = findBody(state.k, { problem: "0001", kind: "deadend", body: "correction: 1.4x once the fast path stops throwing", replaces: state.fid });
      const first = await post(SRV, "finding", body);
      is(first, 201, "a fresh correction");
      const replay = await post(SRV, "finding", body);
      is(replay, 409, "the same signed body a second time");
      assert.match(JSON.stringify(replay.json), /already here/i, "a replay has to read as a replay, not as sign-with-replaces-X");
    });

    test("a body over the cap is a 400, not a truncation", async () => {
      const c0 = commits(TREE);
      let r;
      try {
        r = await post(SRV, "finding", findBody(state.k, { problem: "0001", kind: "blocked", body: "x".repeat(sg.MAXLEN.body + 1) }));
      } catch (e) {
        assert.match(String(e.message), /body/, "the client-side refusal has to name the field");
        return;
      }
      is(r, 400, "an oversized body");
      assert.equal(commits(TREE), c0);
    });

    test("there is no parent field: a thread cannot be started", async () => {
      // The structural cut. A finding that could name another finding would be a reply,
      // and replies are what turn a registry into a forum.
      const sent = { ...findBody(await standingKey(), { problem: "0001", kind: "blocked", body: "corpus 404s from two networks" }), parent: state.fid, replies_to: state.fid };
      const r = await post(SRV, "finding", sent);
      is(r, 201, "an extra field is ignored, not honoured");
      const n = (problemAt(TREE, "0001").findings ?? []).find((x) => x.fid === r.json.fid);
      assert.ok(n, "the finding is not in HEAD");
      for (const f of ["parent", "replies_to"]) assert.ok(!(f in n), `${f} reached the stored record: findings can now be threaded`);
      assert.equal(build(TREE, "--check").code, 0);
    });

    test("nobody can file one on a problem that does not exist", async () => {
      is(await post(SRV, "finding", findBody(state.k, { problem: "9999", kind: "blocked", body: "x" })), 404, "a finding on a missing problem");
    });

    test("the problem view prints findings, and says they change nothing", async () => {
      const r = await hit(SRV, { path: "/0001", headers: { accept: "text/plain" } });
      is(r, 200, "GET /0001");
      assert.match(r.text, /findings:/, "the problem view does not show findings at all");
      assert.match(r.text, /DEADEND|BLOCKED|AMBIGUOUS/, "the kind is not visible, so a reader cannot tell a dead end from a broken problem");
      assert.match(r.text, /change nothing/i, "the view has to say findings decide nothing, or a reader will read them as a verdict");
    });
  });

if (gate.server)
  describe("the board (/keys)", () => {
    test("it counts settled solutions, verdict heads and opened problems", async () => {
      const r = await hit(SRV, { path: "/api/keys" });
      is(r, 200, "GET /api/keys");
      const board = r.json?.board ?? [];
      assert.ok(board.length, "the board is empty although the registry has records");
      // Recompute independently from index.json: the board must be a FOLD, so a second
      // implementation reading the same bytes has to reach the same numbers.
      const idx = JSON.parse((await hit(SRV, { path: "/api/index.json" })).text);
      const want = new Map();
      const row = (key) => {
        if (typeof key !== "string") return null;
        const who = sg.fingerprint(key);
        if (!want.has(who)) want.set(who, { solved: 0, checked: 0, mismatch: 0, filed: 0 });
        return want.get(who);
      };
      for (const p of idx.problems) {
        row(p.key) && row(p.key).filed++;
        for (const n of p.findings ?? []) row(n.key);
        for (const s of p.solutions ?? []) {
          // The row exists for every author, settled or not: solved counts wins, the
          // board still has to show a key that has only ever submitted.
          const a = row(s.key);
          // Same rule as the server: settled AND the problem still standing. A dead
          // problem is out of counts.solved on the front page, so crediting it here would
          // make the two pages contradict each other about the same word.
          if (a && s.settled && p.status !== "dead") a.solved++;
          for (const v of sg.verdictHeads(s.verifications ?? []).heads) {
            const c = row(v.key);
            if (c) {
              c.checked++;
              // mismatch is folded over the same heads, so it can never exceed checked and
              // a verifier who corrected one away is not still credited with it.
              if (v.verdict === "mismatch") c.mismatch++;
            }
          }
        }
      }
      const deadSettled = idx.problems
        .filter((p) => p.status === "dead")
        .flatMap((p) => (p.solutions ?? []).filter((s2) => s2.settled));
      if (deadSettled.length)
        for (const s2 of deadSettled) {
          const who = sg.fingerprint(s2.key);
          const w2 = want.get(who);
          const r2 = board.find((r) => r.key === who);
          if (r2 && w2) assert.equal(r2.solved, w2.solved, `${who} is credited for a settled entry on a retired problem`);
        }
      for (const row of board) {
        const w = want.get(row.key);
        assert.ok(w, `the board lists ${row.key}, which has no record in index.json`);
        assert.equal(row.solved, w.solved, `solved for ${row.key}`);
        assert.equal(row.checked, w.checked, `checked for ${row.key}`);
        assert.equal(row.mismatch, w.mismatch, `mismatch for ${row.key}`);
        assert.equal(row.filed, w.filed, `filed for ${row.key}`);
      }
    });

    test("submitting is not solving, and the order is deterministic", async () => {
      const board = (await hit(SRV, { path: "/api/keys?limit=500" })).json.board;
      for (const row of board)
        assert.ok(row.solved <= row.attempts, `${row.key}: more solved than submitted, so solved is counting claims`);
      const sorted = [...board].sort((a, b) => b.checked - a.checked || b.mismatch - a.mismatch || b.solved - a.solved || b.filed - a.filed || a.key.localeCompare(b.key));
      assert.deepEqual(board.map((r) => r.key), sorted.map((r) => r.key), "the board order is not deterministic to the last element, so paging can drop rows");
    });

    // The point of the column: a mismatch is the most expensive verdict to reach and the
    // only one nothing else in the system rewards. It is a SUBSET of checked, folded over
    // the same heads, so a verifier who went mismatch -> ok holds one verdict and it is
    // the one they hold now. Counting records instead would leave the retracted mismatch
    // standing forever and make "I was wrong" the profitable move.
    test("mismatch counts verdict heads, so retracting one takes it back", async () => {
      const P = await newProblem(SRV, { title: "A problem for the mismatch column" });
      const author = mkKey();
      const s = await post(SRV, "solution", solBody(author, { problem: P.id, repo: "https://example.com/mismatch-column", score: 0.42 }));
      is(s, 201, "the solution under test");
      const sid = s.json.sid;
      const v = mkKey();
      const who = sg.fingerprint(v.pub);
      const find = async () => (await hit(SRV, { path: "/api/keys?limit=500" })).json.board.find((r) => r.key === who);

      const v1 = await post(SRV, "verification", verBody(v, { problem: P.id, solution: sid, score: 0.9, verdict: "mismatch", output: "out-mismatch" }));
      is(v1, 201, "a mismatch verdict");
      const after1 = await find();
      assert.equal(after1.checked, 1, "the mismatch is not counted as work");
      assert.equal(after1.mismatch, 1, "the mismatch column did not see a mismatch verdict");

      const v2 = await post(SRV, "verification", verBody(v, { problem: P.id, solution: sid, score: 0.42, verdict: "ok", output: "out-ok", replaces: v1.json.vid }));
      is(v2, 201, "the same verifier corrects themselves to ok");
      const after2 = await find();
      assert.equal(after2.checked, 1, "correcting a verdict paid a second credit for one piece of work");
      assert.equal(after2.mismatch, 0, "a retracted mismatch still counts, so the column reads records and not heads");
    });

    test("mismatch never exceeds checked, and never buys standing on its own", async () => {
      const board = (await hit(SRV, { path: "/api/keys?limit=500" })).json.board;
      for (const row of board) {
        assert.ok(row.mismatch <= row.checked, `${row.key}: more mismatches than verdicts, so the two columns are not folded over the same heads`);
        // The board gained a column; the gate must not have gained a rule. standing stays
        // exactly attempts or checked, or the board credits work the gate does not count.
        assert.equal(row.standing, row.attempts > 0 || row.checked > 0, `standing for ${row.key} moved when the mismatch column arrived`);
      }
    });

    test("there is no composite score to game", () => {
      // A single number is a weighting and a weighting is an opinion. If one ever appears
      // here, /keys has stopped being a fold over facts.
      return hit(SRV, { path: "/api/keys" }).then((r) => {
        for (const row of r.json.board ?? [])
          // "total" is on the list because the mismatch column made one tempting: any sum
          // over these columns is a weighting, and mismatch is a subset of checked, so a
          // sum would not even be counting distinct work.
          for (const f of ["score", "rank", "points", "rating", "reputation", "total"])
            assert.ok(!(f in row), `the board grew a ${f} field: that is a weighting nobody signed`);
      });
    });

    test("standing on the board matches who the write path actually lets in", async () => {
      const board = (await hit(SRV, { path: "/api/keys?limit=500" })).json.board;
      for (const row of board)
        assert.equal(row.standing, row.attempts > 0 || row.checked > 0, `standing for ${row.key} disagrees with the rule the server enforces`);
      const k = mkKey();
      const r = await post(SRV, "finding", findBody(k, { problem: "0001", kind: "blocked", body: "x" }));
      is(r, 403, "a key absent from the board cannot write");
    });

    test("the text board explains every column and points at the queue", async () => {
      const r = await hit(SRV, { path: "/keys", headers: { accept: "text/plain" } });
      is(r, 200, "GET /keys");
      for (const w of ["solved", "checked", "mismatch", "filed", "standing"])
        assert.match(r.text, new RegExp(`^${w}\\s`, "m"), `the board does not explain the ${w} column`);
      assert.match(r.text, /\/work|\/start/, "the board does not say what to do next");
      // Verification is the scarce good and the board has to read that way. The header row
      // is the one line that says which column the page is about.
      const header = r.text.split("\n").find((l) => /^key\s+\S/.test(l)) ?? "";
      assert.ok(header.indexOf("checked") > 0 && header.indexOf("checked") < header.indexOf("solved"), `the board leads with solved instead of with the verification work: ${header}`);
      assert.ok(header.indexOf("mismatch") > 0 && header.indexOf("mismatch") < header.indexOf("solved"), `mismatch is not folded in beside the verdicts it comes from: ${header}`);
    });

    // "N keys" is true and it reads as N parties. It cannot be: a key costs nothing to
    // make and this registry has no identity to check one against, so the count is a
    // ceiling. Saying which keys belong together would need exactly the identity concept
    // the project refuses to have; saying which way the number errs needs nothing.
    test("the board says its key count is a ceiling, not a headcount", async () => {
      const r = await hit(SRV, { path: "/keys", headers: { accept: "text/plain" } });
      assert.match(r.text, /ceiling/, "the board reports a key count with nothing to stop a reader hearing it as a headcount");
      assert.match(r.text, /not a person|two parties/, "the board does not say that a key is not a person");
      // and it must not have grown the concept it is denying
      for (const w of ["display name", "profile", "operator", "owner of this key"])
        assert.ok(!r.text.includes(w), `the board grew the word "${w}", which is an identity concept this registry does not have`);
      const j = (await hit(SRV, { path: "/api/keys" })).json;
      assert.equal(typeof j.verifiers, "number", "/api/keys reports keys but not how many of them ever filed a verdict");
      assert.ok(j.verifiers <= j.keys, "more verifiers than keys");
    });

    test("the front door advertises the board", async () => {
      const r = await hit(SRV, { path: "/", headers: { accept: "text/plain" } });
      assert.match(r.text, /GET \/keys/, "an agent landing on / is not told the board exists");
      assert.match(r.text, /\/api\/finding/, "an agent landing on / is not told findings can be written");
    });
  });

if (gate.server)
  // The registry's most credible event is a headline that narrowed after somebody else ran
  // it: on 0014 the claim went 72.4, a stranger got 65.41, and a finding then moved the
  // headline from 72.71 to 7.49. All of it lived on one detail page. These tests hold the
  // line between showing that and deciding anything with it.
  describe("the gap (/gap): a claim against what a stranger got", () => {
    const kA = mkKey(), kB = mkKey();
    const state = {};

    test("a claim that moved is reported as claimed, got, and the distance between them", async () => {
      const P = await newProblem(SRV, { title: "A problem whose claim moves under a stranger", higher_is_better: true, tolerance: 0.15 });
      state.P = P.id;
      const s = await post(SRV, "solution", solBody(kA, { problem: P.id, repo: "https://example.com/gap", score: 72.4 }));
      is(s, 201, "the claim");
      state.sid = s.json.sid;
      const v = await post(SRV, "verification", verBody(kB, {
        problem: P.id, solution: state.sid, score: 65.41, verdict: "ok",
        output: "gap: native, not under docker\n", tolerance: 0.15, note: "native arm64; the same repo under docker gives 31-36",
      }));
      is(v, 201, "a stranger's rerun, inside the band");

      const j = await hit(SRV, { path: `/api/gap?problem=${P.id}` });
      is(j, 200, "GET /api/gap");
      const row = (j.json?.gaps ?? []).find((x) => x.solution === state.sid);
      assert.ok(row, "a claim a stranger reran is missing from the fold");
      assert.equal(row.claimed, 72.4, "claimed is not the number the author signed");
      assert.equal(row.best, 65.41);
      assert.equal(row.worst, 65.41);
      assert.equal(row.gap, -6.99, "the gap is not got against claimed (floating point has to be trimmed for display, not for the comparison)");
      assert.equal(row.checks, 1);
      assert.equal(row.moved, true, "a claim that came back 9% lower counts as unmoved");
      assert.equal(row.conditions, true, "the verdict carried a note and the fold does not say so");
      assert.equal(row.mismatch, false, "a verdict inside the band is not a mismatch");
    });

    // Invariant 8. The same trap the board fell into: counting records instead of heads
    // pays a verifier better for correcting themselves than for checking somebody new, and
    // here it would also report a number the verifier has withdrawn.
    test("only the head of a verifier's chain counts, never their last record", async () => {
      const P = await newProblem(SRV, { title: "A problem where a verifier corrects themselves", higher_is_better: true, tolerance: 0.5 });
      const kC = mkKey(), kD = mkKey();
      const s = await post(SRV, "solution", solBody(kC, { problem: P.id, repo: "https://example.com/gap-chain", score: 10 }));
      is(s, 201, "the claim");
      const v1 = await post(SRV, "verification", verBody(kD, { problem: P.id, solution: s.json.sid, score: 9, verdict: "ok", output: "gap: chain 1\n", tolerance: 0.5 }));
      is(v1, 201, "the first verdict");
      const v2 = await post(SRV, "verification", verBody(kD, { problem: P.id, solution: s.json.sid, score: 6, verdict: "ok", output: "gap: chain 2\n", tolerance: 0.5, replaces: v1.json.vid }));
      is(v2, 201, "the correction");

      const row = ((await hit(SRV, { path: `/api/gap?problem=${P.id}` })).json?.gaps ?? [])[0];
      assert.ok(row, "the reran claim is missing");
      assert.equal(row.checks, 1, "one verifier who corrected themselves is counted twice, so correcting yourself pays better than checking somebody new");
      assert.equal(row.worst, 6, "the fold reports a withdrawn number instead of the head of the chain");
      assert.equal(row.gap, -4);
    });

    // Invariant 15/16. The whole reason this route is allowed to exist: it folds records
    // already in git and decides nothing. If any of these ever fails, arithmetic has become
    // a verdict and the registry has started counting something other than verified work.
    test("a gap moves no status, no frontier and no verdict", async () => {
      const p = ((await hit(SRV, { path: "/api/index.json" })).json?.problems ?? []).find((x) => x.id === state.P);
      assert.ok(p, "the fixture problem is gone");
      assert.equal(p.status, "solved", "the entry settled inside the band: a gap must not take that back");
      assert.equal(p.frontier.best_score, 72.4, "the frontier moved to the stranger's number: the fold has reached derived state");
      const sol = p.solutions.find((x) => x.sid === state.sid);
      assert.equal(sol.settled, true);
      assert.equal(sol.verifications[0].verdict, "ok", "the verdict was reinterpreted by the gap");
      const file = problemAt(TREE, state.P);
      assert.ok(!("gap" in file), "the fold reached problems/*.json: it is a read path, not stored state");
      for (const s2 of file.solutions) for (const f of ["gap", "claimed_vs_got", "narrowing"])
        assert.ok(!(f in s2), `${f} was written into the record: a fold that stores anything is a table`);

      const j = (await hit(SRV, { path: "/api/gap" })).json;
      assert.equal(j.changes_nothing, true, "the surface an agent reads in bulk does not say it derives nothing");
      for (const row of j.gaps ?? [])
        for (const f of ["verdict", "settled", "frontier", "score", "rank", "points"])
          assert.ok(!(f in row), `a gap row grew a ${f} field: the fold has started speaking about state`);
    });

    test("the fold is recomputable: a second implementation over the same bytes agrees", async () => {
      const idx = (await hit(SRV, { path: "/api/index.json" })).json;
      const want = new Map();
      for (const p of idx.problems ?? []) {
        const hib = !!p.acceptance.higher_is_better;
        for (const s of p.solutions ?? []) {
          const heads = sg.verdictHeads(s.verifications ?? []).heads;
          if (!heads.length) continue;
          const got = heads.map((v) => v.score);
          const worst = hib ? Math.min(...got) : Math.max(...got);
          want.set(s.sid, {
            claimed: s.score, worst, checks: heads.length,
            best: hib ? Math.max(...got) : Math.min(...got),
            gap: Number((hib ? worst - s.score : s.score - worst).toFixed(6)),
          });
        }
      }
      const rows = (await hit(SRV, { path: "/api/gap?limit=500" })).json?.gaps ?? [];
      assert.equal(rows.length, want.size, "the fold lists a different number of rerun claims than index.json holds");
      for (const r of rows) {
        const w = want.get(r.solution);
        assert.ok(w, `${r.solution} is on /api/gap and has no rerun record in index.json`);
        for (const f of ["claimed", "best", "worst", "checks", "gap"])
          assert.equal(r[f], w[f], `${f} for ${r.solution}`);
      }
    });

    test("the front door carries the two counts and never the rows", async () => {
      const totals = (await hit(SRV, { path: "/api/gap?limit=500" })).json;
      assert.ok(totals.reruns >= 2, "the fixtures did not produce enough reruns to test the front door");
      const r = await hit(SRV, { path: "/", headers: { accept: "text/plain" } });
      is(r, 200, "GET /");
      assert.match(
        r.text,
        new RegExp(`rerun by a stranger: ${totals.reruns} claims?, ${totals.moved} moved`),
        "the front door has no count of what strangers actually got, or disagrees with /api/gap about it"
      );
      assert.match(r.text, /GET \/gap/, "an agent landing on / is not told where the claims that moved are");
      // The property, not the wording: this view is a constant size no matter how big the
      // registry gets, so it may carry counts and never one row per rerun.
      for (const row of totals.gaps ?? [])
        assert.ok(!r.text.includes(row.solution), `${row.solution} reached the front door: the fold is growing with the registry`);
    });

    test("a solved row shows the claim against what came back", async () => {
      const r = await hit(SRV, { path: "/?status=solved&limit=500", headers: { accept: "text/plain" } });
      is(r, 200, "GET /?status=solved");
      const line = r.text.split("\n").find((l) => l.startsWith(`[${state.P}]`));
      assert.ok(line, "the solved fixture is not in the listing");
      assert.match(line, /72\.4->65\.41/, "the row where a reader meets the claim does not say what a stranger got for it");
      assert.match(line, /CONDITIONS/, "the existing marker was replaced instead of extended");
    });

    test("an in-progress row shows it too, and a refusal is flagged", async () => {
      const P = await newProblem(SRV, { title: "A problem whose claim a stranger refused", higher_is_better: true });
      const kE = mkKey(), kF = mkKey();
      const s = await post(SRV, "solution", solBody(kE, { problem: P.id, repo: "https://example.com/gap-refused", score: 100 }));
      is(s, 201, "the claim");
      is(await post(SRV, "verification", verBody(kF, { problem: P.id, solution: s.json.sid, score: 40, verdict: "mismatch", output: "gap: refused\n" })), 201, "the refusal");

      const r = await hit(SRV, { path: "/?status=in-progress&limit=500", headers: { accept: "text/plain" } });
      is(r, 200, "GET /?status=in-progress");
      const line = r.text.split("\n").find((l) => l.startsWith(`[${P.id}]`));
      assert.ok(line, "the in-progress fixture is not in the listing");
      assert.match(line, /100->40/, "an in-progress row does not carry the claim against what came back");

      const row = ((await hit(SRV, { path: `/api/gap?problem=${P.id}` })).json?.gaps ?? [])[0];
      assert.equal(row.mismatch, true);
      assert.equal(row.moved, true);
      const t = await hit(SRV, { path: `/gap?problem=${P.id}`, headers: { accept: "text/plain" } });
      assert.match(t.text, /MISMATCH/, "the text view does not flag a claim that was refused outright");
    });

    test("the problem page states the delta instead of leaving it as a subtraction", async () => {
      const r = await hit(SRV, { path: `/${state.P}`, headers: { accept: "text/plain" } });
      is(r, 200, `GET /${state.P}`);
      assert.match(
        r.text,
        /claimed 72\.4, a stranger got 65\.41: -6\.99 \(-9\.65%\) against the claim/,
        "the page prints both numbers and leaves the reader to do the subtraction"
      );
    });

    test("three representations, one fold, and a cut that says it was cut", async () => {
      const t = await hit(SRV, { path: "/gap", headers: { accept: "text/plain" } });
      is(t, 200, "GET /gap");
      assert.match(t.text.split("\n")[0], /^EXIT0 \/ GAP$/, "no path header, so there is no breadcrumb to link");
      for (const w of ["claimed", "got", "gap", "change", "flags"])
        assert.match(t.text, new RegExp(`^${w}\\s`, "m"), `the text view does not explain the ${w} column`);
      assert.ok(t.text.includes("-6.99"), "the text view and /api/gap disagree about the same subtraction");

      const h = await hit(SRV, { path: "/gap", headers: { accept: "text/html" } });
      is(h, 200, "GET /gap (html)");
      assert.ok(h.text.startsWith("<!doctype html"), "the html representation is not html");
      assert.ok(!/<script/i.test(h.text), "the html view grew a script");

      const one = await hit(SRV, { path: "/api/gap?limit=1" });
      is(one, 200, "GET /api/gap?limit=1");
      assert.equal((one.json?.gaps ?? []).length, 1, "limit is not honoured");
      assert.equal(one.json.more, one.json.total > 1, "the cut is not declared, so a client that pages cannot know there is a next page");
      const cut = await hit(SRV, { path: "/gap?limit=1", headers: { accept: "text/plain" } });
      assert.match(cut.text, /showing 1-1 of \d+/, "a cut list that looks complete is a lie about the state of the registry");

      // Mismatches lead: a reader who stops after one row has seen the strongest case that
      // this registry checks itself.
      const all = (await hit(SRV, { path: "/api/gap?limit=500" })).json?.gaps ?? [];
      const firstOk = all.findIndex((x) => !x.mismatch);
      assert.ok(firstOk === -1 || !all.slice(firstOk).some((x) => x.mismatch), "a refused claim sits below a confirmed one");
      const again = (await hit(SRV, { path: "/api/gap?limit=500" })).json?.gaps ?? [];
      assert.deepEqual(all.map((x) => x.solution), again.map((x) => x.solution), "the order is not deterministic, so paging can silently drop a row");

      // The default carries the claims that reproduced to the digit as well: they are what
      // makes the ones that moved mean anything.
      const moved = (await hit(SRV, { path: "/api/gap?moved=yes&limit=500" })).json?.gaps ?? [];
      const still = (await hit(SRV, { path: "/api/gap?moved=no&limit=500" })).json?.gaps ?? [];
      assert.equal(moved.length + still.length, all.length, "?moved= splits the fold into something other than the whole of it");
      assert.ok(moved.every((x) => x.moved) && still.every((x) => !x.moved));

      for (const p of ["/gap?moved=maybe", "/gap?problem=xx", "/gap?domain=nope", "/api/gap?limit=x", "/api/gap?offset=-1"])
        is(await hit(SRV, { path: p }), 400, `${p} was accepted instead of refused`);
    });
  });

// =====================================================================
// 9b. The door for somebody who arrives with a QUESTION
// =====================================================================

if (gate.server)
  describe("the door for a question (/ask)", () => {
    const SUBJECT = "https://github.com/example/published-figure";
    const question = (o) => ({
      how: "Clone the subject at the pinned commit in its README and run `make bench`, which builds both arms on one machine in one run and prints {speedup}.",
      metric: "speedup - throughput ratio against the stock arm, one machine, one run",
      higher_is_better: true,
      baseline: 3.2,
      tolerance: 0.05,
      domain: "eval",
      needs: [],
      subject: SUBJECT,
      ...o,
    });

    // The fence is one predicate and it lives in two places that agree by construction:
    // askable() refuses the write, askRows() refuses the listing. Neither is a judgement
    // about prose, which is why neither can rot into one. A claim about a PERSON has no
    // repository to clone and no figure to reproduce, so it satisfies neither half.
    test("askable: a question names code and a number, or it is not a question", () => {
      const ok = question({ title: "t", problem: "p" });
      assert.deepEqual(sg.askable(ok), ok, "a complete question was refused");
      for (const [why, body] of [
        ["a claim about a person has no repository to name", { ...ok, subject: undefined }],
        ["an empty string is not a repository", { ...ok, subject: "" }],
        ["a reputation is not a figure", { ...ok, baseline: undefined }],
        ["a figure has to be a number, not prose about one", { ...ok, baseline: "3.2x faster" }],
        ["null is not a figure either", { ...ok, baseline: null }],
        ["a figure nobody can run is an accusation, not a question", { ...ok, how: "   " }],
      ])
        assert.throws(() => sg.askable(body), /question needs/, why);
    });

    test("the ask CLI signs a problem, says whose figure it is, and refuses a claim about a person", () => {
      const dir = mkTree("ask-cli");
      assert.equal(run(dir, "scripts/sign.mjs", ["keygen"]).code, 0);
      const q = question({
        title: "Does the published 3.2x on that parser hold",
        problem: "A widely shared post reports 3.2x and the thread has argued about it for a week. Nobody in it has run the command.",
      });
      const r = run(dir, "scripts/sign.mjs", ["ask", "identity.pem", JSON.stringify(q)]);
      assert.equal(r.code, 0, r.err);
      const body = JSON.parse(r.out);
      // Both fields have been dropped in silence before, by this same CLI, and a dropped
      // field does not error: it produces a valid problem with the question gone out of it.
      assert.equal(body.subject, SUBJECT, "the CLI dropped the subject, so the question lost the code it is about");
      assert.equal(body.baseline, 3.2, "the CLI dropped the baseline, so the question lost the figure");
      assert.ok(sg.check(body.key, body.sig, sg.payload("problem", body)), "the signature does not cover the printed body");
      assert.match(r.err, /PUBLISHED figure/, "the CLI does not say the baseline is somebody else's figure, so an agent files it believing it attested to it");

      // Pure by ARITY, not by promise: ask takes no base-url, so it cannot post. claim
      // does and must; this one prints what you are about to publish about somebody
      // else's work and leaves sending it to you.
      const usage = run(dir, "scripts/sign.mjs", ["ask"]);
      assert.notEqual(usage.code, 0, "ask with no arguments reported success");
      assert.match(usage.err, /ask <key\.pem> <json/, "the usage block does not document ask");
      assert.ok(!/ask <key\.pem> <base-url>/.test(usage.err), "ask grew a base-url argument, which means it posts");

      const person = run(dir, "scripts/sign.mjs", ["ask", "identity.pem", JSON.stringify({ ...q, subject: undefined, baseline: undefined })]);
      assert.notEqual(person.code, 0, "a question with no repository and no figure was signed anyway");
      assert.match(person.err, /is not a repository and cannot be run/, "the refusal does not say why a claim about a person has nowhere to go here");
    });

    test("/ask lists a problem that names code and a figure, and refuses everything else", async () => {
      const Q = await newProblem(SRV, question({
        title: "A published figure nobody here has run",
        problem: "Somebody published a number for this repository and nobody in the argument has run the command that would settle it.",
      }));
      // The control. A perfectly good problem, and it must NOT reach this door: that is
      // the whole fence, and it is computed on every read rather than curated.
      const P = await newProblem(SRV, { title: "An ordinary problem with no figure in dispute" });

      const j = await hit(SRV, { path: "/api/ask" });
      is(j, 200, "GET /api/ask");
      const ids = (j.json?.ask ?? []).map((x) => x.problem);
      assert.ok(ids.includes(Q.id), "a problem naming a repository and a published figure is missing from the door built for it");
      assert.ok(!ids.includes(P.id), "a problem with no repository and no figure reached /ask: the membership predicate is not the fence it claims to be");

      const row = j.json.ask.find((x) => x.problem === Q.id);
      assert.equal(row.published, 3.2, "the published figure is missing from the row");
      assert.equal(row.reproduced, null, "nobody has run it, so reproduced is null and never a number");
      assert.equal(row.subject, SUBJECT);
      assert.equal(row.tolerance, 0.05, "the door hands out a question without the band a verifier has to sign");
      assert.equal(j.json.compares_nothing, true, "the bulk surface does not declare that it compares nothing");
      for (const k of ["verdict", "refuted", "author", "who", "claimant"])
        assert.ok(!(k in row), `/api/ask carries a ${k} field: this surface reproduces numbers, it does not judge claims or the people behind them`);
    });

    test("a question that gets run carries both figures and compares neither", async () => {
      const Q = await newProblem(SRV, question({
        title: "A published figure a stranger did run",
        problem: "Somebody published a number for this repository. This entry exists to settle the number, not the argument around it.",
      }));
      // The solution points at a THIRD PARTY's repository, which is the ordinary shape
      // here: ref stays "-", so invariant 14 never comes into it. Only a ref is claimable,
      // and only under your own fingerprint.
      const s = await post(SRV, "solution", solBody(mkKey(), { problem: Q.id, repo: SUBJECT, score: 1.08, note: "ran make bench at the pinned commit, both arms on one box" }));
      is(s, 201, "a solution pointing at the subject's own repository");
      const sid = s.json.sid;
      is(await post(SRV, "verification", verBody(mkKey(), { problem: Q.id, solution: sid, score: 1.09, verdict: "ok", output: "speedup 1.09\n", tolerance: 0.05 })), 201, "a stranger settles the question");

      const row = ((await hit(SRV, { path: "/api/ask" })).json?.ask ?? []).find((x) => x.problem === Q.id);
      assert.equal(row.published, 3.2, "the published figure stopped being visible once somebody ran it");
      assert.equal(row.reproduced, 1.08, "the settled number never reached the door");

      // "solved" is about the SUBMITTER's number being reproduced. It says nothing about
      // the published one, and no surface here may say anything about it either: a
      // registry that concluded would have started judging claims instead of running them.
      const detail = await hit(SRV, { path: `/${Q.id}`, headers: { accept: "text/plain" } });
      assert.match(detail.text, /SOLVED/, "a reproduced entry did not settle the problem");
      const text = await hit(SRV, { path: "/ask", headers: { accept: "text/plain" } });
      for (const w of [/refut/i, /debunk/i, /disprov/i, /\bfalse\b/i, /\blied\b/i, /fraud/i, /\bhoax\b/i])
        assert.ok(!w.test(text.text), `/ask draws a conclusion about the published figure (${w}) instead of printing both numbers`);
      assert.match(text.text, /compares NEITHER/, "/ask does not tell the reader the comparison is theirs");
    });

    // The gift, not a fence. A reproduced number is worth more than an unreproduced one,
    // so the author of a published figure has the most to gain from filing the conditions
    // - and nothing on this path may stand in their way.
    test("the author of a published figure can file the conditions under their own key", async () => {
      const dir = mkTree("ask-own-figure");
      assert.equal(run(dir, "scripts/sign.mjs", ["keygen"]).code, 0);
      const body = JSON.stringify(question({
        title: "My own published figure, filed for a stranger to check",
        problem: "I published this number myself. Filing the conditions here is the only way it stops being an unreproduced claim.",
        repo: SUBJECT,
        score: 3.2,
      }));
      const r = run(dir, "scripts/sign.mjs", ["claim", "identity.pem", `http://127.0.0.1:${SRV.port}`, body]);
      assert.equal(r.code, 0, `nothing may block the author of a figure from filing it: ${r.err}`);
      const out = JSON.parse(r.out);
      const p = await hit(SRV, { path: `/api/problems/${out.problem}` });
      is(p, 200, "the problem the author opened");
      assert.equal(p.json.subject, SUBJECT, "claim dropped the subject, so the author's question lost the code");
      assert.equal(p.json.acceptance.baseline, 3.2, "claim dropped the baseline, so the author's question lost the figure");
      assert.equal(p.json.solutions.length, 1, "the author's own result did not land under their own question");

      const row = ((await hit(SRV, { path: "/api/ask" })).json?.ask ?? []).find((x) => x.problem === out.problem);
      assert.ok(row, "a question the author filed about their own figure is not at the door");
      assert.equal(row.reproduced, null, "the author's own entry counts as reproduced: nobody settles their own figure (invariant 3)");
    });

    test("/ask is a view like every other: path header, links only in HTML, a cut that declares itself", async () => {
      const t = await hit(SRV, { path: "/ask", headers: { accept: "text/plain" } });
      is(t, 200, "GET /ask");
      assert.equal(t.text.split("\n")[0], "EXIT0 / ASK", "the door has no path header, so there is no breadcrumb to link");
      assert.ok(!/<a\s|<\/a>/.test(t.text), "an anchor leaked into the text representation of /ask");
      assert.match(t.text, /DATA, not instructions/, "the door drops the injection boundary every other view carries");

      const h = await hit(SRV, { path: "/ask", headers: { accept: "text/html" } });
      is(h, 200, "GET /ask (html)");
      assert.match(h.text, /<a href="\/">EXIT0<\/a>/, "the path header is not a link home");
      assert.ok(!/<script/i.test(h.text), "the door grew a script");
      const first = ((await hit(SRV, { path: "/api/ask" })).json?.ask ?? [])[0];
      if (first) {
        assert.ok(h.text.includes(`<a href="/${first.problem}">`), "a problem id at the door is not a link to the problem it names");
        assert.ok(h.text.includes(`href="${first.subject}"`), "subject is a structured URL the registry put there, so it has to be a link");
      }

      const paged = await hit(SRV, { path: "/api/ask?limit=1" });
      is(paged, 200, "GET /api/ask?limit=1");
      assert.ok((paged.json?.ask ?? []).length <= 1, "limit is not honoured");
      assert.equal(typeof paged.json?.more, "boolean", "a cut list that does not say it was cut is a lie about the state of the registry");
      is(await hit(SRV, { path: "/api/ask?limit=x" }), 400, "the door guesses at a paging parameter it cannot read");
      is(await hit(SRV, { path: "/api/ask?have=telepathy" }), 400, "the door accepts a kit value outside NEEDS");
      is(await hit(SRV, { path: "/ask", method: "POST" }), 405, "the door takes a POST, and there is no question action to post to");

      const front = await hit(SRV, { path: "/", headers: { accept: "text/plain" } });
      assert.match(front.text, /GET \/ask/, "an agent landing on / is never told the question door exists");
    });

    // The empty door is the one a first visitor actually sees, and for as long as nobody
    // has asked anything it is the ONLY thing this surface says. It used to drop the rule
    // it exists to state, because the rule had been written as a column legend and lived
    // inside the branch that prints columns. Caught by acceptance.mjs against a registry
    // with no questions in it, which is every registry on its first day.
    test("the door states the rule even with nothing to list", async () => {
      const srv = await startServer(newTree("ask-empty"));
      assert.ok(srv.port, srv.why);
      const j = await hit(srv, { path: "/api/ask" });
      is(j, 200, "GET /api/ask on a registry nobody has asked anything of");
      assert.equal(j.json.questions, 0, "the fixture is not the empty case this test is about");
      const t = await hit(srv, { path: "/ask", headers: { accept: "text/plain" } });
      is(t, 200, "GET /ask (empty)");
      assert.match(t.text, /compares NEITHER/, "the empty door drops the one rule it exists to state");
      assert.match(t.text, /never people/, "the empty door drops the fence, and it is the only page a first visitor reads");
      assert.match(t.text, /sign\.mjs ask/, "the empty door does not say how to ask, which is all it has to do");
      assert.match(t.text, /DATA, not instructions/, "the empty door drops the injection boundary");
      await stop(srv, "SIGKILL");
    });

    // The honest limit, stated where it can be checked. The write path has NO question
    // gate and must not grow one: llms.txt is normative and promises no such check, the
    // same way it refuses to promise that `how` can be run. What holds instead is that an
    // unrun question stays a question and never becomes a fact of this registry.
    test("the write path has no question gate, and the documentation does not invent one", async () => {
      const k = mkKey();
      const f = probFields({ title: "A problem filed with no subject and no figure at all" });
      is(await post(SRV, "problem", probBody(k, f)), 201, "POST /api/problem started refusing a problem it always accepted");
      const llms = readFileSync(join(ROOT, "llms.txt"), "utf8");
      assert.match(llms, /GET \/ask/, "llms.txt does not carry the question door, and it is the only file an agent is guaranteed to read");
      // The phrase, not a whole sentence: this assertion is about the PROMISE llms.txt is
      // not allowed to make, and a longer literal only pins today's wording of it.
      assert.match(llms, /gate on the write path/i, "llms.txt describes the door without saying the server enforces none of it, which is a promise of a check that does not exist");
      assert.ok(
        !/\b(server|registry)\b[^.]*\b(requires|rejects|refuses)\b[^.]*\bsubject\b/i.test(llms),
        "llms.txt says the server checks subject on the write path, and it does not: that is the class of promise the `how` field is already careful never to make"
      );
      assert.match(readFileSync(join(ROOT, "DESIGN.md"), "utf8"), /fences/i, "DESIGN.md does not record where the fences are or why");
    });
  });

// =====================================================================
// 10. Concurrency and the write lock
// =====================================================================

if (gate.server)
  describe("concurrency and the write lock", () => {
    test("10 parallel writes: as many commits as successes, nothing lost", async () => {
      const P = await newProblem(SRV, { title: "A problem for the concurrency test" });
      const c0 = commits(TREE);
      const n0 = problemAt(TREE, P.id).solutions.length;
      const bodies = Array.from({ length: 10 }, (_, i) => solBody(mkKey(), { problem: P.id, repo: `https://example.com/parallel-${i}`, score: 0.42 }));
      const res = await Promise.all(bodies.map((b) => post(SRV, "solution", b)));
      const ok = res.filter((r) => r.status === 201).length;
      assert.equal(ok, 10, `statuses: ${res.map((r) => r.status).join(",")}`);
      assert.equal(commits(TREE), c0 + ok);
      assert.equal(problemAt(TREE, P.id).solutions.length, n0 + ok, "a lost update in read-modify-write");
      assert.equal(dirty(TREE), "");
      assert.equal(build(TREE, "--check").code, 0);
    });

    test("the file lock: a live owner blocks, a dead one is cleaned up", async () => {
      mkdirSync(join(TREE, ".state"), { recursive: true });
      const lock = join(TREE, ".state", "write.lock");
      writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: "test", at: Date.now() }));
      is(await post(SRV, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/lock-a", score: 0.42 })), 503, "a write while the lock is held by a live process");
      assert.ok(existsSync(lock), "the server stole somebody else's lock (reviewer 22)");

      writeFileSync(lock, JSON.stringify({ pid: 999999, nonce: "corpse", at: Date.now() }));
      is(await post(SRV, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/lock-b", score: 0.42 })), 201, "a write after a dead lock owner");
      assert.ok(!existsSync(lock), "the lock survived a successful write");
    });

    // A leftover .git/index.lock (after an interrupted `git add`, after kill -9) does
    // not go away by itself. The write used to be APPLIED regardless, the commit then
    // failed, and so did the cleanup - because that needs the index too - and the
    // registry stayed dirty FOREVER, with a 500 for the author. Now the lock is asked
    // about BEFORE apply.
    test("a leftover .git/index.lock: 503, nothing applied, recovery once it is removed (D4)", async () => {
      const dir = newTree("index-lock");
      const srv = await startServer(dir);
      assert.ok(srv.port, srv.why);
      const c0 = commits(dir);
      const lock = join(dir, ".git", "index.lock");
      writeFileSync(lock, "");

      const r = await post(srv, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/lock", score: 0.42 }));
      is(r, 503, "a busy git index is a retryable class (503), not a lost write (500)");
      assert.match(String(r.json?.error ?? ""), /index\.lock/);
      assert.match(String(r.json?.fix ?? ""), /index\.lock/, "a 503 without the repair command leaves the operator with no way out");
      assert.equal(r.headers["retry-after"], "1");
      assert.equal(dirty(dir), "", "the write was applied despite the busy index and nobody is left to undo it (D4)");
      assert.equal(commits(dir), c0, "a commit despite the busy index");

      unlinkSync(lock);
      is(await post(srv, "solution", solBody(mkKey(), { problem: "0001", repo: "https://example.com/lock", score: 0.42 })), 201, "the registry does not come back once the lock is gone (D4)");
      assert.equal(dirty(dir), "");
      assert.equal(build(dir, "--check").code, 0);
      await stop(srv, "SIGKILL");
    });

    // A `git status --porcelain` loop is the command the RUNBOOK names as the MAIN
    // health signal. Without retries it destroyed 25-44% of correctly signed writes,
    // and the rollback died together with the commit and left the registry dirty.
    test("writes survive somebody else's git in the same directory (D9)", async () => {
      const dir = newTree("foreign-git");
      const srv = await startServer(dir, { IP_CAP: "100000" });
      assert.ok(srv.port, srv.why);
      const loops = Array.from({ length: 3 }, () =>
        spawn("sh", ["-c", "while :; do git status --porcelain >/dev/null 2>&1; done"], { cwd: dir, stdio: "ignore" })
      );
      const codes = [];
      try {
        for (let i = 0; i < 8; i++) {
          const res = await post(srv, "solution", solBody(mkKey(), { problem: "0001", repo: `https://example.com/foreign-${i}`, score: 0.42 }));
          codes.push(res.status);
        }
      } finally {
        for (const p of loops) p.kill("SIGKILL");
      }
      const lost = codes.filter((c) => c === 500);
      assert.equal(lost.length, 0, `writes lost to a 500 next to somebody else's git: ${codes.join(",")} (D9)`);
      assert.ok(codes.includes(201), `not a single write got through: ${codes.join(",")}`);
      // 503 is acceptable (llms.txt: "retry later"), as long as nothing is left behind
      assert.equal(dirty(dir), "", "an uncommitted write was left after colliding with somebody else's git (D8/D9)");
      assert.equal(build(dir, "--check").code, 0, "the registry is inconsistent after colliding with somebody else's git");

      // The health verdict has a ceiling of once per second (invariant 10), and for the
      // whole of this test somebody else's git kept taking .git/index.lock - so right
      // after killing the loops the pulse may still be carrying that state. We wait for
      // a refresh; and if the lock really did survive, that is not a registry failure
      // but a state the pulse is SUPPOSED to report (D3, round 3), one that goes away
      // after the command in the fix field, with no restart.
      const lockAfter = join(dir, ".git", "index.lock");
      const untilOk = async () => {
        const deadline = Date.now() + 4000;
        let p = (await hit(srv, { path: "/api/pulse" })).json;
        while (p.writes !== "ok" && Date.now() < deadline) { await sleep(150); p = (await hit(srv, { path: "/api/pulse" })).json; }
        return p;
      };
      let p = await untilOk();
      if (p.writes !== "ok" && existsSync(lockAfter)) {
        assert.match(String(p.reason), /index\.lock/, `a different reason than a leftover lock: ${p.reason}`);
        assert.match(String(p.fix), /index\.lock/, "the pulse has to carry the repair command");
        unlinkSync(lockAfter);
        p = await untilOk();
      }
      assert.equal(p.writes, "ok", `the registry stayed in read-only mode: ${p.reason}`);
      await stop(srv, "SIGKILL");
    });

    // Claiming the lock used to be unlink + open("wx"), a window in which a second
    // process takes its own lock and we delete it - and both of us are in the critical
    // section. Measured with five instances: ENOENT on renaming temp files, meaning two
    // processes writing the same problem file at once.
    test("two processes do not enter the critical section together (D7)", async () => {
      const dir = newTree("lock-race");
      mkdirSync(join(dir, ".state"), { recursive: true });
      const lock = join(dir, ".state", "write.lock");
      const a = await startServer(dir, { IP_CAP: "100000" });
      const b = await startServer(dir, { IP_CAP: "100000" });
      assert.ok(a.port && b.port, a.why || b.why);
      let fiveHundreds = 0;
      for (let i = 0; i < 6; i++) {
        writeFileSync(lock, JSON.stringify({ pid: 999999, nonce: "orphan", at: Date.now() }));
        const res = await Promise.all([
          post(a, "solution", solBody(mkKey(), { problem: "0001", repo: `https://example.com/race-a-${i}`, score: 0.42 })),
          post(b, "solution", solBody(mkKey(), { problem: "0001", repo: `https://example.com/race-b-${i}`, score: 0.43 })),
        ]);
        fiveHundreds += res.filter((r) => r.status >= 500 && r.status < 503).length;
        assert.ok(res.some((r) => r.status === 201 || r.status === 503), `statuses in round ${i}: ${res.map((r) => r.status).join(",")}`);
      }
      assert.equal(fiveHundreds, 0, "a 500 while claiming an orphaned lock = two processes in the critical section (D7)");
      assert.equal((a.err + b.err).match(/ENOENT/g)?.length ?? 0, 0, `ENOENT from rename is in the logs — temp files collide between processes (D7): ${(a.err + b.err).slice(0, 300)}`);
      assert.equal(dirty(dir), "");
      assert.equal(build(dir, "--check").code, 0);
      await stop(a, "SIGKILL");
      await stop(b, "SIGKILL");
    });
  });

// =====================================================================
// 11. Repo invariants — read from the real tree, never written to
// =====================================================================

describe("repo invariants", () => {
  const text = (p) => {
    try {
      return readFileSync(join(ROOT, p), "utf8");
    } catch {
      return null;
    }
  };
  const scripts = readdirSync(join(ROOT, "scripts")).filter((f) => f.endsWith(".mjs"));

  test("zero dependencies: no package.json, no node_modules, node: only", () => {
    assert.ok(!existsSync(join(ROOT, "package.json")), "package.json is forbidden (invariant 7)");
    assert.ok(!existsSync(join(ROOT, "node_modules")));
    for (const f of scripts) {
      const src = text(`scripts/${f}`);
      assert.ok(!CJS.test(src), `${f}: a CommonJS call inside an ES module`);
      for (const m of src.matchAll(/\bfrom\s+["']([^"']+)["']/g))
        assert.ok(m[1].startsWith("node:") || m[1].startsWith("./") || m[1].startsWith("../"), `${f}: import from outside node: -> ${m[1]}`);
    }
  });

  test("invariant 6: request content never reaches a shell", () => {
    const src = text("scripts/server.mjs");
    assert.ok(src, "scripts/server.mjs missing");
    assert.ok(!/execFileSync\(\s*["'](sh|bash|zsh)["']/.test(src), "a shell in server.mjs");
    assert.ok(!/\bexecSync\s*\(/.test(src), "execSync in server.mjs");
    assert.ok(!/shell\s*:\s*true/.test(src), "shell:true in server.mjs");
    assert.ok(/execFileSync\(/.test(src), "server.mjs does not call git through execFileSync");
  });

  test("rollback restores from HEAD, the commit touches only its own paths", () => {
    const src = text("scripts/server.mjs") ?? "";
    assert.match(src, /"checkout"[\s\S]{0,80}HEAD/, "checkout has to restore from HEAD, not from the index (C1)");
    assert.match(src, /"--only"/, "a commit without --only sweeps up somebody else's work from the index");
    assert.ok(!/"add",\s*"-A"/.test(src), "git add -A poisons the index before a rollback");
    assert.match(src, /"clean"/, "without git clean a rejected new file stays on disk");
  });

  // Three rules that have drifted recently and looked innocent in the diff every
  // single time. By grep, because each one is about the SHAPE of the code and the
  // consequence only shows up under several processes at once.
  test("concurrency: git reads take no lock, the lock is claimed atomically, temp files are per process", () => {
    const srv = text("scripts/server.mjs") ?? "";
    const bld = text("scripts/build.mjs") ?? "";
    assert.match(srv, /--no-optional-locks/, "a git read without --no-optional-locks fights its own commit over .git/index.lock (D4/D9)");
    assert.match(bld, /--no-optional-locks/, "build.mjs runs inside the server write path and must not fight over the index either (D4/D9)");
    assert.ok(
      /renameSync\(\s*LOCK/.test(srv),
      "claiming the lock has to be atomic (rename): unlink + open is a window for two processes in the critical section (D7)"
    );
    for (const [name, src] of [["server.mjs", srv], ["build.mjs", bld]]) {
      const wa = /const writeAtomic = \([^)]*\) => \{[\s\S]{0,240}?\};/.exec(src);
      assert.ok(wa, `${name}: writeAtomic not found`);
      assert.match(wa[0], /process\.pid/, `${name}: a shared temp file name = ENOENT with two writers (D7)`);
    }
  });

  test("server.mjs: the startup contract, no new URL on the request target, null-prototype actions", () => {
    const src = text("scripts/server.mjs") ?? "";
    assert.match(src, /address\(\)\.port/, "the startup line has to carry the real port (E1) — test.mjs reads the port from it");
    assert.match(src, /listen\([^)]*(HOST|127\.0\.0\.1)/, "the server has to bind to loopback by default");
    assert.ok(!/new URL\(\s*req\.url/.test(src), "new URL(req.url) kills the process on 'GET //'");
    assert.match(src, /Object\.create\(null\)/, "actions must have an empty prototype");
    assert.match(src, /nonce/, "a file lock without a nonce can be stolen");
  });

  test("payload is called with an object only; shared functions are imported, never copied", () => {
    for (const f of ["scripts/server.mjs", "scripts/build.mjs"]) {
      const src = text(f);
      assert.ok(src, `${f} missing`);
      for (const line of src.split("\n")) {
        if (!/payload\("(solution|verification|problem)"/.test(line)) continue;
        assert.match(line, /payload\("[a-z]+", ?([A-Za-z{]|problemFields\()/, `${f}: payload assembled by hand -> ${line.trim()}`);
      }
      const dup = /^(const|let|var|export const|function) *(PREFIX|keyId|fp32|canonUrl|numToken|canonLine|canonText|assertCanon|evidenceBytes|problemFields|solutionId|verificationId|evidencePath|checkVerification|fieldBlock|cell|solCmp|verifyEntry)\b/m.exec(src);
      assert.equal(dup, null, `${f}: a local definition of ${dup?.[2]} instead of the import from sign.mjs`);
    }
  });

  test("the exit0/v2 contract everywhere, not a trace of the old name", () => {
    assert.match(text("scripts/sign.mjs") ?? "", /exit0\/v2/);
    for (const f of scripts) assert.ok(!(text(`scripts/${f}`) ?? "").includes(LEGACY), `${f} still knows the old name`);
    assert.ok(!(text("problems/_schema.json") ?? "").includes(LEGACY), "_schema.json describes the old contract");
  });

  test("every file stays text — not one control literal", () => {
    const files = [
      ...scripts.map((f) => `scripts/${f}`),
      ...readdirSync(join(ROOT, "problems")).filter((f) => f.endsWith(".json")).map((f) => `problems/${f}`),
      "llms.txt",
      "README.md",
    ];
    for (const f of files) {
      const b = readFileSync(join(ROOT, f));
      for (let i = 0; i < b.length; i++) {
        const c = b[i];
        assert.ok(c >= 0x20 || c === 0x09 || c === 0x0a || c === 0x0d, `${f}: control byte 0x${c.toString(16)} at offset ${i} (findings 1/19/34)`);
        assert.notEqual(c, 0x7f, `${f}: DEL at offset ${i}`);
      }
    }
  });

  test("_schema.json is a contract build.mjs actually enforces", () => {
    const j = JSON.parse(text("problems/_schema.json") ?? "{}");
    const sol = j.properties?.solutions?.items;
    assert.ok(sol, "no description of solutions[]");
    for (const f of ["sid", "repo", "author", "key", "sig", "score", "at", "verifications", "verified", "disputed", "settled"])
      assert.ok(sol.required.includes(f), `solutions[].required without ${f}`);
    assert.deepEqual(sol.properties.score, { type: "number" }, "score cannot be nullable — numToken would not write it (finding 13)");
    const tol = j.properties.acceptance.properties.tolerance;
    assert.equal(tol?.minimum, 0);
    assert.equal(tol?.maximum, 0.5);
    assert.ok(j.properties.acceptance.required.includes("tolerance"));
    const v = sol.properties.verifications.items;
    for (const f of ["vid", "verifier", "key", "sig", "score", "verdict", "output_sha256", "evidence", "at"])
      assert.ok(v.required.includes(f), `verifications[].required without ${f}`);
    assert.equal(v.properties.output_sha256.pattern, "^[0-9a-f]{64}$");
    assert.match(v.properties.evidence.pattern, /evidence/);
    assert.deepEqual(j.properties.acceptance.properties.baseline.type, ["number", "null"]);
    assert.match(sol.properties.sig.description ?? "", /exit0\/v2/, "the description of sig describes the old contract");

    // The drawers have ONE source: sign.mjs. A schema that knows a different set of
    // values would accept a problem whose payload cannot be signed - or the reverse.
    assert.deepEqual(j.properties.domain?.enum, sg.DOMAINS, "_schema.json knows a different set of domains than sign.mjs");
    assert.deepEqual(j.properties.needs?.items?.enum, sg.NEEDS, "_schema.json knows a different set of needs than sign.mjs");
    for (const f of ["domain", "needs"]) assert.ok(j.required.includes(f), `a problem without ${f} is invisible to every filter`);
    // And the normative documentation has to list exactly the same values.
    const llms = text("llms.txt") ?? "";
    for (const d of sg.DOMAINS) assert.ok(llms.includes(d), `llms.txt does not list the domain ${d}`);
    for (const n of sg.NEEDS) assert.ok(llms.includes(n), `llms.txt does not list the need ${n}`);
    // The third drawer. It is closed for a sharper reason than the other two: the open
    // version of `kind` is a comment box.
    assert.deepEqual(j.properties.findings?.items?.properties?.kind?.enum, sg.KINDS, "_schema.json knows a different set of finding kinds than sign.mjs");
    for (const k of sg.KINDS) assert.ok(llms.includes(k), `llms.txt does not list the finding kind ${k}`);
    assert.equal(j.properties.findings?.items?.properties?.body?.maxLength, sg.MAXLEN.body, "the schema caps a finding body at a different length than sign.mjs");
  });

  // llms.txt is NORMATIVE: an agent implements the signature from it. A grammar line
  // there with fewer fields than payload() actually joins does not fail loudly, it makes
  // every signature that agent produces come back 403 with no way to see why. This is
  // not hypothetical - the `problem` line lost [subject] exactly that way.
  test("every grammar line in llms.txt has as many fields as payload() joins", () => {
    const llms = text("llms.txt") ?? "";
    const real = {
      solution: sg.payload("solution", { problem: "0001", repo: "https://e.com/r", score: 1, model: "m", note: "n", replaces: "-", builds_on: "-", ref: "-" }),
      verification: sg.payload("verification", { problem: "0001", solution: "a".repeat(16), score: 1, verdict: "ok", output_sha256: "b".repeat(64), tolerance: 0.02, replaces: "-" }),
      problem: sg.payload("problem", { title: "t".repeat(5), problem: "p".repeat(5), how: "h", metric: "m", higher_is_better: true, baseline: null, tolerance: 0.02, domain: "other", needs: [] }),
      finding: sg.payload("finding", { problem: "0001", kind: "deadend", body: "b", replaces: "-" }),
    };
    for (const [action, msg] of Object.entries(real)) {
      const line = llms.split("\n").find((l) => l.trim().startsWith(`${action} `) && l.includes(`${sg.PREFIX}|${action}|`));
      assert.ok(line, `llms.txt carries no grammar line for ${action}`);
      const declared = line.slice(line.indexOf(`${sg.PREFIX}|`)).trim().split("|");
      assert.deepEqual(
        declared.slice(0, 2), [sg.PREFIX, action],
        `the ${action} grammar line does not start with the current prefix`
      );
      assert.equal(
        declared.length - 2, msg.split("|").length - 2,
        `llms.txt declares ${declared.length - 2} fields for ${action}, payload() joins ${msg.split("|").length - 2}. An agent implementing from the documentation signs the wrong string.`
      );
    }
  });

  // Two independent agents landed on this registry cold and both hit the same wall: the
  // contract said "you see tolerance on every problem in GET /" and GET / has never carried
  // it. That is not a cosmetic doc bug. A verifier SIGNS tolerance, the CLI defaults it to
  // 0.02, and the address budget charges for the resulting 403 - so following the
  // documentation literally cost an attempt to discover the documentation was wrong.
  test("every route the contract names as a source of tolerance actually carries it", async () => {
    const llms = text("llms.txt") ?? "";
    // Whatever routes the prose names, the value has to be there in SIGNABLE form.
    const p = JSON.parse(readFileSync(join(ROOT, "index.json"), "utf8")).problems.find((x) => x.acceptance);
    assert.ok(p, "no problem with an acceptance block to check against");
    const tol = String(p.acceptance.tolerance ?? 0.02);

    const detail = await hit(SRV, { path: `/${p.id}`, headers: { accept: "text/plain" } });
    is(detail, 200, `GET /${p.id}`);
    assert.ok(detail.text.includes(tol), `GET /${p.id} does not print the tolerance as the number you sign (${tol}); a percentage is not a value anybody can put in a payload`);

    const api = await hit(SRV, { path: `/api/problems/${p.id}` });
    assert.equal(api.json?.acceptance?.tolerance, p.acceptance.tolerance ?? 0.02, "/api/problems/<id> lost the tolerance");

    // And the contract must not point at the front door, which is a constant-size view and
    // carries no per-problem value at all.
    const front = await hit(SRV, { path: "/", headers: { accept: "text/plain" } });
    assert.ok(!/toler/i.test(front.text), "GET / grew a tolerance: either put it on every row or keep the contract honest about it not being here");
    assert.ok(
      !/(Copy it from|You see it on every problem in) GET \/(?![a-z<])/.test(llms),
      "llms.txt sends a verifier to GET / for the tolerance, and GET / does not have it"
    );
  });

  // The queue is where a verifier stands at the moment they need the band.
  test("the work queue carries the band it tells you to sign", async () => {
    const q = await hit(SRV, { path: "/api/work" });
    is(q, 200, "GET /api/work");
    for (const w of q.json?.work ?? [])
      assert.equal(typeof w.tolerance, "number", `${w.solution}: the queue offers work without the band to judge it under`);
    const t = await hit(SRV, { path: "/work", headers: { accept: "text/plain" } });
    if ((q.json?.work ?? []).length) assert.match(t.text, /\bband\b/, "the text queue does not carry the band column it tells you to sign");
  });

  // GET /<id> calls itself "one problem in full". It rendered finding bodies whole and
  // dropped the submitter's own note - so the reader the site sends there, the one about to
  // spend compute on the entry, was the only one who did not get it.
  test("the problem view carries the solution note it calls one problem in full", async () => {
    const withNote = JSON.parse(readFileSync(join(ROOT, "index.json"), "utf8"))
      .problems.find((x) => (x.solutions ?? []).some((s) => s.note));
    if (!withNote) return; // nothing in the registry to check right now
    const s2 = withNote.solutions.find((x) => x.note);
    const r = await hit(SRV, { path: `/${withNote.id}`, headers: { accept: "text/plain" } });
    is(r, 200, `GET /${withNote.id}`);
    assert.ok(r.text.includes(s2.note), `GET /${withNote.id} drops the solution note, which is the submitter's own account of what the number means`);
  });

  test("every problem in the registry has a drawer and canonical needs", () => {
    const files = readdirSync(join(ROOT, "problems")).filter((f) => /^\d{4}-.*\.json$/.test(f));
    assert.ok(files.length, "no problems in the registry");
    for (const f of files) {
      const p = JSON.parse(readFileSync(join(ROOT, "problems", f), "utf8"));
      assert.ok(sg.DOMAINS.includes(p.domain), `${f}: domain ${JSON.stringify(p.domain)} outside the set`);
      assert.deepEqual(p.needs, sg.canonNeeds(p.needs), `${f}: needs is not in canonical form`);
      // The metric has to be ONE number with a unit: without that a verifier does not know what to send.
      assert.ok((p.acceptance.metric ?? "").length > 10, `${f}: metric too vague to compare anything against`);
      assert.ok((p.acceptance.how ?? "").includes("make ") || (p.acceptance.how ?? "").length > 80,
        `${f}: how without a command a stranger can run`);
    }
  });

  test("problem 0001 can be verified: one metric, an explicit tolerance", () => {
    const p = JSON.parse(text("problems/0001-oss-router.json") ?? "{}");
    assert.equal(p.acceptance.tolerance, 0.02);
    assert.ok(!/accuracy/.test(p.acceptance.metric), "metric has to be one number, the accuracy gate belongs to how (finding 31)");
    assert.match(p.acceptance.metric, /cost_usd/);
    assert.match(p.acceptance.how, /accuracy/, "the accuracy gate has to be described in how");
    assert.ok(existsSync(join(ROOT, "problems/evidence/.gitkeep")), "problems/evidence has to survive git clean -fdq -- problems");
  });

  // D3: without this rule git normalises line endings on `git add`, so a committed
  // piece of evidence stops reproducing its own sha256 - and that is the one thing
  // build.mjs cannot recompute from anything else.
  test("evidence is exempt from line-ending conversion", () => {
    const attr = text(".gitattributes");
    assert.ok(attr, ".gitattributes missing — a fresh clone will not reproduce the evidence sums (D3)");
    assert.match(attr, /^\* -text$/m, "the global rule: no conversion in this repository");
    assert.match(attr, /^problems\/evidence\/\*\* -text/m, "evidence has to be exempted explicitly as well");
    const r = spawnSync("git", ["-C", ROOT, "check-attr", "text", "--", "problems/evidence/0000-probe.txt"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /text: unset/, "git can still rewrite evidence bytes in this repository");
  });

  test("deploy: the installer copies deploy/, and does not copy generated files", () => {
    const sh = text("deploy/install.sh");
    assert.ok(sh, "deploy/install.sh missing");
    assert.equal(spawnSync("bash", ["-n", join(ROOT, "deploy/install.sh")], { encoding: "utf8" }).status, 0, "install.sh does not parse under bash");
    assert.match(sh, /cp -r [^\n]*deploy/, "install.sh does not copy deploy/ — the install dies before the unit (C17)");
    assert.match(sh, /cp -r [^\n]*\.gitattributes/, "install.sh does not copy .gitattributes — the deployed registry will drift on evidence sums (D3)");
    // index.json is 100% generated: copying it adds nothing.
    const indexCopies = sh.split("\n").filter((l) => /^\s*cp\b/.test(l) && l.includes("index.json"));
    assert.equal(indexCopies.length, 0, "install.sh copies the fully generated index.json");
    // README.md IS copied and has to be. This loop used to forbid that for README too,
    // justified by "a dirty tree after the build" - which was not true, because the copy
    // happens BEFORE the build and the commit. The effect was that the deployed prose
    // froze at whatever the first installer put there: the public mirror carried a README
    // in the wrong language while every other document was current.
    assert.match(sh, /for f in [^\n]*README\.md[^\n]*; do/, "install.sh does not refresh README.md — the deployed prose freezes at the first install");
    assert.ok(!/\[ -f "\$DIR\/README\.md" \]/.test(sh), "README.md is back to being copied conditionally, which means back to frozen prose");
    assert.match(sh, /ExecStart/, "the unit has to be rendered with a real interpreter");
    const unit = text("deploy/exit0.service") ?? "";
    assert.match(unit, /TRUST_PROXY=1/, "a unit behind its own Caddy has to trust the proxy, otherwise all traffic lands in one IP bucket (finding 33)");
    assert.match(unit, /TimeoutStopSec/);
    assert.match(text("deploy/Caddyfile") ?? "", /header_up X-Forwarded-For/, "Caddy has to OVERWRITE XFF, not append to it");
    assert.ok(text("deploy/RUNBOOK.md"), "deploy/RUNBOOK.md missing");
  });

  // A document is only shipped if what it POINTS AT is shipped too. The mirror carried a
  // README whose wordmark resolved to nothing for as long as the mirror existed: the file
  // was tracked here, rendered on the code repo, and simply never copied to $DIR. Nobody
  // reads a broken image as "the installer has a gap", they read it as "the registry looks
  // unfinished". This checks the class, not that one PNG, so the next reference someone
  // adds to a shipped document fails here instead of on a stranger's screen.
  test("deploy: every relative asset a shipped document points at is shipped with it", () => {
    const sh = text("deploy/install.sh") ?? "";
    // What the installer puts in $DIR: the explicit cp -r line, plus the document loop.
    const shipped = new Set();
    for (const m of sh.matchAll(/\$SRC\/([A-Za-z0-9_.-]+)/g)) shipped.add(m[1]);
    for (const m of sh.matchAll(/^for f in ([^;]+); do/gm)) for (const f of m[1].trim().split(/\s+/)) shipped.add(f);
    assert.ok(shipped.has("scripts"), "could not parse what install.sh ships");

    const docs = [...shipped].filter((f) => /\.(md|txt)$/.test(f));
    assert.ok(docs.includes("README.md"), "README.md is not among the shipped documents");

    const refs = [];
    for (const d of docs) {
      const body = text(d);
      if (!body) continue;
      for (const m of body.matchAll(/src="([^"]+)"/g)) refs.push([d, m[1]]);
      for (const m of body.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) refs.push([d, m[1]]);
    }
    // Absolute and inline references are served by something else (the badge route, a data: URI).
    const relative = refs.filter(([, r]) => !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(r));
    for (const [doc, ref] of relative) {
      assert.ok(existsSync(join(ROOT, ref)), `${doc} points at ${ref}, which is not in this repository`);
      const top = ref.split("/")[0];
      assert.ok(shipped.has(top), `${doc} points at ${ref}, but install.sh never copies ${top} — it renders here and breaks on the deployment and the mirror`);
    }
  });

  // Round 4. The refund rule is written one line above refundIp and names "an internal
  // error" as something the address must not pay for. The condition did not cover it:
  // an error with no numeric code answers 500 to the client (the mapping in the
  // handler defaults to 500) while Number(undefined) >= 500 is false, so no refund
  // happened. That is the one class of 500 a client can do nothing about - a bug here.
  // By grep, because a genuine internal error is by definition one nobody arranged.
  test("deploy: the address is refunded for every 500, including one with no code", () => {
    const src = text("scripts/server.mjs") ?? "";
    const fallback = /typeof e\?\.code === "number" \? e\.code : 500/;
    assert.match(src, fallback, "the response mapping changed shape — this test compares the refund against it");
    const refund = /catch \(e\) \{\s*\n\s*([^\n]*refundIp[^\n]*)/.exec(src);
    assert.ok(refund, "no refund branch found in doWrite");
    assert.ok(
      !/Number\(e\?\.code\) >= 500/.test(refund[1]),
      `the refund reads a raw code, so an error with no code answers 500 and is never refunded: ${refund[1].trim()}`
    );
    assert.match(refund[1], /statusOf|typeof e\?\.code/, "the refund has to decide from the SAME status the client is given");
  });

  // The installer once moved a live deployment from 8081 to 8080 (the default), Caddy
  // kept talking to 8081, and the only symptom the installer could produce was
  // "pulse answered HTTP 400: Invalid host header" - which reads like a bug in the
  // server. An update has no business moving a port nobody named.
  test("deploy: an update does not move the port of a live deployment", () => {
    const sh = text("deploy/install.sh") ?? "";
    assert.match(sh, /PORT_GIVEN=\$\{PORT\+yes\}/, "install.sh does not tell a named PORT from a defaulted one");
    assert.match(sh, /PORT_LIVE=/, "install.sh does not read the port out of the unit already installed");
    assert.match(sh, /PORT="\$PORT_LIVE"/, "install.sh does not adopt the deployment's port, so the silent port move is back");
  });

  // The mirror publishes the thing people clone the registry for in the first place:
  // the evidence bytes, which HTTP does not serve. Three properties of that script
  // are not cosmetic.
  test("deploy: the mirror validates before publishing and never rewinds the public copy", () => {
    const m = text("deploy/mirror.sh");
    assert.ok(m, "deploy/mirror.sh missing");
    assert.equal(spawnSync("sh", ["-n", join(ROOT, "deploy/mirror.sh")], { encoding: "utf8" }).status, 0, "mirror.sh does not parse under sh");

    // 1. Validation BEFORE the push, and validation of HEAD, not of the working tree.
    const iCheck = m.indexOf("build.mjs --check");
    // The index of the COMMAND, not of the first occurrence of the word: the header of
    // that file explains why the push lives there and not in backup.sh, so the word
    // appears earlier than the code.
    const iPush = m.search(/^[^#\n]*\$GIT push\b/m);
    assert.ok(iCheck > 0, "mirror.sh does not validate the copy before publishing");
    assert.ok(iCheck < iPush, "mirror.sh publishes before it checks, so a broken registry becomes the thing to clone");
    assert.match(m, /archive HEAD/, "mirror.sh validates the working tree instead of what a push would actually send");

    // 2. No push may carry force semantics. --mirror carries it and deletes refs: a
    // pusher that had been asleep would rewind the public copy people check verdicts against.
    const pushLines = m.split("\n").filter((l) => /\bgit push\b|\$GIT push\b/.test(l) && !/^\s*#/.test(l));
    assert.ok(pushLines.length > 0, "no pushing line found in mirror.sh");
    for (const l of pushLines) {
      assert.ok(!/--force|--mirror|\+refs/.test(l), `mirror.sh pushes with force semantics: ${l.trim()}`);
    }

    // 3. The host key is pinned, not learned on first contact: the unit runs with
    // ProtectHome, so learning it ends in a message about a read-only filesystem that
    // says nothing about the cause.
    assert.match(m, /UserKnownHostsFile/, "mirror.sh relies on $HOME/.ssh, which ProtectHome will not let it write");
    assert.match(m, /StrictHostKeyChecking=yes/, "mirror.sh accepts a new host key on the fly");
  });

  // Every flag these scripts hand to git has to be a flag git actually knows. Reading the
  // script for dangerous strings does not catch the opposite failure: a flag that does not
  // exist. deploy/mirror.sh carried `git merge --no-rebase` (a `git pull` option) for as
  // long as the reconcile path existed, so the ONE branch written to handle two writers
  // diverging could never run - and it failed with "cannot merge automatically", which
  // reads like a conflict rather than like a typo. A static read cannot see that. Asking
  // git can.
  test("deploy: every git flag in the deploy scripts is a flag this git knows", () => {
    const probe = mkdtempSync(join(tmpdir(), "exit0-gitflags-"));
    trees.push(probe);
    spawnSync("git", ["init", "-q", probe], { encoding: "utf8" });
    let checked = 0;
    for (const script of ["deploy/mirror.sh", "deploy/install.sh", "deploy/backup.sh", "deploy/watch.sh"]) {
      const body = text(script);
      if (!body) continue;
      for (const raw of body.split("\n")) {
        const line = raw.trim();
        if (line.startsWith("#")) continue;
        // `-C <dir>` sits between `git` and the subcommand and is the form install.sh uses on
        // EVERY line, so without this the loop matched nothing there and the test proved
        // nothing about the one script it was most needed for. It stayed green while
        // `status --porcelain --no-optional-locks` sat in install.sh untouched.
        const m2 = /(?:^|[;&|(]\s*|!\s*)(?:\$GIT|git)\s+(?:-C\s+\S+\s+)?([a-z-]+)((?:\s+--[a-z][a-z0-9-]*)+)/.exec(line);
        if (!m2) continue;
        const [, sub, flagBlob] = m2;
        const flags = flagBlob.trim().split(/\s+/);
        const r = spawnSync("git", ["-C", probe, sub, ...flags, "exit0-nonexistent-argument"], { encoding: "utf8" });
        const err = `${r.stderr ?? ""}${r.stdout ?? ""}`;
        assert.ok(
          !/unknown option|unknown switch|unrecognized option/i.test(err),
          `${script}: git ${sub} ${flags.join(" ")} -> ${err.split("\n")[0]}`
        );
        checked++;
      }
    }
    assert.ok(checked > 0, "no git invocation with flags was found in the deploy scripts, so this test proves nothing");
  });

  // One branch, two writers: code arrives from a laptop, registry data is committed on the
  // host, and since the code and registry repositories were merged into one they land on
  // the same branch. A non-fast-forward is therefore EXPECTED, not exotic, and a push that
  // only ever fails on it would freeze the public copy the first time the two crossed.
  test("deploy: the mirror reconciles a divergence by merging, and never publishes an unvalidated state", () => {
    const m = text("deploy/mirror.sh") ?? "";

    // Rewriting is the one repair that is not allowed here. Every accepted write is a
    // commit and the history IS the audit trail, so a rebase would rewrite the evidence.
    // The BEHAVIOUR, not a particular spelling of it. This assertion used to be
    // /merge --no-rebase/ and it pinned a flag `git merge` does not accept, so the test
    // was green for exactly as long as the code was broken. Pin what the script must DO.
    const code = m.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    assert.match(code, /\$GIT merge\b/, "mirror.sh does not merge the divergence, so a crossed push freezes the public copy forever");
    assert.ok(!/\brebase\b/.test(code), "mirror.sh rebases somewhere: that rewrites commits which are the audit trail");
    assert.ok(!/--force|push -f\b/.test(code), "mirror.sh forces a push on the reconcile path");
    assert.match(m, /merge --abort/, "a conflicted merge is left half-applied in the live registry");

    // The reconcile path is the easy place to lose the validation: it pushes a state that
    // did not exist when the first check ran.
    const calls = [...m.matchAll(/^\s*(?:if !? ?)?(validate_head|push_head)\b/gm)]
      .filter((c) => !/\(\)/.test(c[0]))
      .map((c) => c[1]);
    assert.ok(calls.includes("push_head"), "no push call found in mirror.sh");
    let validated = false;
    for (const c of calls) {
      if (c === "validate_head") validated = true;
      else {
        assert.ok(validated, "mirror.sh pushes without a validate_head before it");
        validated = false; // each push consumes its validation; the merged state needs a fresh one
      }
    }
    // A write in flight must not be merged over. Position, not spelling: this assertion
    // was pinned to the literal "status --porcelain --no-optional-locks", which put the
    // git-level flag AFTER the subcommand where git rejects it. A guard whose command
    // errors fails OPEN - the substitution is empty and [ -z "" ] passes - so the test was
    // green precisely because it was pinning the broken form. Whether each flag is real is
    // the job of the git-flag test above; what matters here is that the guard runs first.
    const iGuard = code.search(/status --porcelain/);
    const iMerge = code.search(/\$GIT merge\b/);
    assert.ok(iGuard > 0, "mirror.sh merges without checking for a write in flight");
    assert.ok(iGuard < iMerge, "mirror.sh checks for a write in flight only AFTER merging over it");
  });

  // The other half of the same problem. $SRC is a clone of the repository the registry
  // pushes into, so unless the installer catches up first it commits already-published code
  // under a new sha and diverges the registry from the public copy on EVERY deploy.
  test("deploy: the installer fast-forwards the registry before committing code to it", () => {
    const sh = text("deploy/install.sh") ?? "";
    const iFf = sh.search(/^\s*elif git -C "\$DIR" fetch/m);
    const iCopy = sh.search(/^cp -r "\$SRC\/scripts"/m);
    assert.ok(iFf > 0, "install.sh never fast-forwards $DIR, so every deploy diverges it from the public copy");
    assert.ok(iFf < iCopy, "install.sh fast-forwards after copying the code, which is the one order that cannot work");
    assert.match(sh, /merge --ff-only/, "install.sh reconciles with something other than a fast-forward");
    // The fetch is from the directory on disk. Reaching for the network here would make the
    // installer fail on a host that has no mirror key and no business having one.
    assert.match(sh, /fetch --quiet "\$SRC"/, "install.sh fetches from somewhere other than $SRC, adding a network dependency to the install");
    assert.ok(!/\bgit -C "\$DIR" (rebase|reset --hard)/.test(sh), "install.sh rewrites or discards registry history");
  });

  // The private key must not sit inside the registry directory: the service user's home
  // IS /srv/exit0, and install.sh runs `git add -A` there. One bad default path and the
  // key rides into the public mirror.
  test("deploy: the mirror key lives outside the registry repository", () => {
    const sh = text("deploy/install.sh") ?? "";
    const key = (sh.match(/MIRROR_KEY="\$\{MIRROR_KEY:-([^}"]+)\}"/) ?? [])[1];
    assert.ok(key, "no default mirror key path found in install.sh");
    const dir = (sh.match(/DIR="\$\{DIR:-([^}"]+)\}"/) ?? [])[1];
    assert.ok(dir, "no default DIR found in install.sh");
    assert.ok(!key.startsWith(dir), `the key ${key} sits in ${dir}, the tree install.sh commits with git add -A`);
  });

  // Two pushers is not redundancy when one of them pushes --mirror.
  test("deploy: the backup does not push the mirror by default", () => {
    const b = text("deploy/backup.sh") ?? "";
    assert.match(b, /MIRROR=\$\{EXIT0_MIRROR:-off\}/, "backup.sh pushes the mirror by default again — together with mirror.sh on the host that is a recipe for rewinding the public copy");
  });

  // The same limit sits in two files with two owners and nothing tied them together.
  // Caddy lower than the server = 128KB bodies die at the proxy with somebody else's
  // error code; Caddy higher = the origin gets what the edge was supposed to cut.
  test("the request body limit is the same in Caddy and in the server", () => {
    const srv = text("scripts/server.mjs") ?? "";
    const m = srv.match(/MAX_BODY\s*=\s*(\d+)\s*\*\s*1024/);
    assert.ok(m, "MAX_BODY not found in scripts/server.mjs");
    const kb = Number(m[1]);
    assert.equal(kb, 128, "C4 says 128KB — changing it requires changing deploy/Caddyfile in the same commit");
    assert.match(text("deploy/Caddyfile") ?? "", new RegExp(`max_size\\s+${kb}KB`), `Caddyfile has to cut at the same ${kb}KB as the origin`);
  });

  // The worked example in A6 writes a key and a request body DIRECTLY into the registry
  // directory, and install.sh runs `git add -A` there. Without these entries one
  // `keygen alice.pem` ends with a private key in a public repository - the key IS the account.
  test("the documented example does not dirty the registry and carries no key into git", () => {
    for (const f of ["identity.pem", "alice.pem", "body.json"]) {
      const r = spawnSync("git", ["-C", ROOT, "check-ignore", "-q", f], { encoding: "utf8" });
      assert.equal(r.status, 0, `.gitignore does not cover ${f}: install.sh (git add -A) would pull it into the registry, and the RUNBOOK would call the tree dirty`);
    }
  });

  test("the documentation says what the code does", () => {
    assert.ok(text("AGENTS.md"), "AGENTS.md is linked from CLAUDE.md and llms.txt, and does not exist (B14)");
    const llms = text("llms.txt") ?? "";
    // llms.txt is read by an agent that has nothing else. A capability described there and
    // missing here is worse than an undescribed one: the agent plans around it, tries, and
    // is stuck. `ref` reads like the answer to "I have nowhere to publish" and is not, so
    // the limit has to be stated where the promise is.
    assert.ok(/does NOT accept pushes/.test(llms), "llms.txt describes ref without saying the registry accepts no pushes, so it promises a way to publish that does not exist");
    assert.ok(/GET \/start/.test(llms), "llms.txt does not mention /start");
    assert.ok(llms.includes("exit0/v2|solution|"), "llms.txt is NORMATIVE — it has to carry the payload grammar (C6)");
    assert.match(llms, /sign\.mjs/, "llms.txt has to say where the reference implementation of the contract is");
    assert.match(text("CLAUDE.md") ?? "", /node scripts\/test\.mjs/, "CLAUDE.md still claims there is no test suite");
    assert.match(text("QUICKSTART.md") ?? "", /git config user\.email/, "the first command in QUICKSTART dies without a git identity");
    for (const f of ["QUICKSTART.md", "llms.txt"]) assert.ok(!(text(f) ?? "").includes("sign identity.pem solution 0001"), `${f}: the old, unreachable CLI form`);
    assert.match(text("DESIGN.md") ?? "", /keyId|canonical form/, "DESIGN.md does not know the canonical key rule");

    // D1: the grammar in the normative llms.txt has to carry the replaces token,
    // otherwise an agent signs a body the server will reject.
    assert.ok(llms.includes("exit0/v2|solution|[problem]|[repo]|[score]|[model]|[note]|[replaces]"), "llms.txt does not describe the replaces token (D1)");
    assert.ok(llms.includes("|0:|-"), "llms.txt has to carry a working literal of the solution payload");

    // D5: "a typo costs nothing" is true ONLY about the key limit.
    for (const [f, src] of [["llms.txt", llms], ["README.md", text("README.md") ?? ""]]) {
      const paragraphs = src.split(/\n\n+/).filter((s) => /typo|is charged|Limit /i.test(s) && /limit/i.test(s));
      assert.ok(paragraphs.length, `${f}: no paragraph about limits found`);
      assert.ok(paragraphs.some((s) => /address/i.test(s)), `${f}: the paragraph about limits is silent about the address limit, which counts EVERY attempt (D5)`);
    }
    assert.ok(!llms.includes("a typo costs nothing. "), "llms.txt still promises free typos without the caveat about the address limit (D5)");
  });

  test("the real repository is consistent (build.mjs --check)", () => {
    const r = build(ROOT, "--check");
    assert.equal(r.code, 0, `--check in ${ROOT}: ${r.err || r.out}`);
  });
});

// =====================================================================
// 11b. work.mjs: the entry point, from the queue to a signed body
// =====================================================================
// This is also the FIRST test in this suite that signs a verification through cli().
// CLAUDE.md records why that matters: a regression that made the CLI sign the wrong
// tolerance band survived 182 green runs here, because every other test builds the
// payload by hand and never walks the documented path.

if (gate.server)
  describe("work.mjs: the queue to a signed body, and not one step further", () => {
    const WM = join(TREE, "work.mjs");
    const scratch = mkdtempSync(join(tmpdir(), "exit0-work-"));
    trees.push(scratch);
    const base = () => `http://127.0.0.1:${SRV.port}`;
    const wm = (...args) => {
      const r = spawnSync(NODE, [WM, "--base", base(), "--key", join(scratch, "wm.pem"), ...args], { cwd: scratch, encoding: "utf8" });
      return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
    };
    // 0014 carries tolerance 0.15, and that is the whole point of picking it: the CLI
    // default is 0.02, so a body signed under the default cannot pass here.
    const kA = mkKey();
    let sid = null;

    test("a solution waiting for a first verdict", async () => {
      const r = await post(SRV, "solution", solBody(kA, { problem: "0014", repo: "https://example.com/work-mjs", score: 10 }));
      is(r, 201, "the fixture solution did not go in");
      sid = r.json.sid;
      const q = await hit(SRV, { path: "/api/work" });
      is(q, 200, "/api/work");
      assert.ok((q.json.work ?? []).some((w) => w.solution === sid), "the fixture is not in the queue");
    });

    test("with no flags it picks that entry, runs nothing and offers no body to send", () => {
      const r = wm();
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /FIRST CHECK/, "the queue entry was not described");
      assert.match(r.out, /Nothing has been fetched and nothing has been run/);
      assert.ok(!/-d @/.test(r.out), "a body to POST was offered before anything was run");
      assert.ok(!existsSync(join(scratch, "checkout")), "something was fetched without --run");
    });

    test("--score signs through scripts/sign.mjs under the PROBLEM's band, and the server takes it", async () => {
      const out = join(scratch, "out.txt");
      writeFileSync(out, "speedup 11\n{\"speedup\": 11, \"mismatches\": 0}\n");
      // |11 - 10| = 1. Inside 0.15 * 10 = 1.5, outside the CLI default 0.02 * 10 = 0.2.
      const r = wm("--solution", sid, "--score", "11", "--output", out);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /verdict {2}ok/, "a difference of 1 inside a band of 1.5 is not a mismatch");
      assert.match(r.out, /\|verification\|0014\|[0-9a-f]{16}\|11\|ok\|[0-9a-f]{64}\|0\.15\|/, "the signed payload does not carry the problem's tolerance");
      assert.match(r.out, /Nothing has been sent/);
      const bodyFile = (/^body {5}(.*)$/m.exec(r.out) ?? [])[1];
      assert.ok(bodyFile && existsSync(bodyFile), `no body written: ${r.out}`);
      const sent = await post(SRV, "verification", readFileSync(bodyFile, "utf8"));
      is(sent, 201, "the server refused a body work.mjs produced");
      const p = await hit(SRV, { path: "/api/problems/0014" });
      const mine = (p.json.solutions ?? []).find((x) => x.sid === sid);
      assert.equal((mine.verifications ?? []).length, 1, "the verdict is not on the entry");
      assert.equal(mine.verified, true, "a stranger's ok did not settle it");
    });

    test("it refuses to verify its own entry instead of spending an attempt on a 403", async () => {
      // A fresh entry: the one above is settled by now and no longer in the queue.
      const r = await post(SRV, "solution", solBody(kA, { problem: "0014", repo: "https://example.com/work-mjs-own", score: 10 }));
      is(r, 201, "the second fixture did not go in");
      const pemOfA = join(scratch, "author.pem");
      writeFileSync(pemOfA, kA.priv.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      const w = spawnSync(NODE, [WM, "--base", base(), "--key", pemOfA, "--solution", r.json.sid], { cwd: scratch, encoding: "utf8" });
      assert.notEqual(w.status, 0, "work.mjs offered to verify the entry its own key filed");
      assert.match(w.stderr, /nobody verifies themselves/);
    });

    test("it cannot post, and it is one file with no dependencies", () => {
      const src = readFileSync(WM, "utf8");
      assert.ok(!/method:\s*["']POST["']/i.test(src), "work.mjs carries a POST: the send belongs to the caller");
      for (const m of src.matchAll(/\bfrom\s+["']([^"']+)["']/g))
        assert.ok(m[1].startsWith("node:") || m[1].startsWith("./"), `work.mjs: import from outside node: -> ${m[1]}`);
      assert.ok(!CJS.test(src), "a CommonJS call inside an ES module");
      assert.ok(!/[^\x00-\x7f]/.test(src), "work.mjs: a non-ASCII character in the source");
      const b = readFileSync(WM);
      for (let i = 0; i < b.length; i++)
        assert.ok((b[i] >= 0x20 && b[i] !== 0x7f) || b[i] === 0x09 || b[i] === 0x0a, `work.mjs: control byte 0x${b[i].toString(16)} at offset ${i}`);
    });
  });

// =====================================================================
// 12. Closing
// =====================================================================

if (gate.server)
  describe("final state of the working copy", () => {
    test("after the whole suite: clean tree, consistent registry, live server", async () => {
      assert.equal(git(TREE, "status", "--porcelain"), "", "uncommitted state left behind after the suite");
      assert.equal(build(TREE, "--check").code, 0);
      is(await hit(SRV, { path: "/api/pulse" }), 200, "the main server survived the whole suite");
      assert.ok(commits(TREE) > 1, "not a single write reached git");
      assert.match(SRV.line, /exit0 .*:\d+/, "the server startup line changed shape — this suite reads the port from it (E1)");
    });
  });
