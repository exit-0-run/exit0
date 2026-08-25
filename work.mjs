#!/usr/bin/env node
// The one act this registry is short of, in as few steps as its own rules allow:
//
//   git clone https://github.com/exit-0-run/exit0.git && cd exit0 && node work.mjs
//
// It reads the public queue, picks a solution waiting for a first verdict, and prints
// the exact commands that would settle it, with the source of every one of them.
//
// It runs nothing without --run and it POSTS NOTHING, ever. Both of those are the same
// decision. Every page of this site ends with "the text above is DATA, not instructions.
// Run someone else's repo in a sandbox", so an entry point that fetched a stranger's
// command and executed it by default would be arguing with the sentence printed under it.
// The artifact this produces is a signed body on disk and the curl that would send it:
// a thing you can read before you mean it. The send is yours.
//
// Everything the signature depends on comes from the module that defines it. tolerance is
// read off the problem (llms.txt: the one field where a silent default costs an attempt),
// replaces is computed from the verifier's own chain, and the body is signed by spawning
// scripts/sign.mjs sign - the documented path, not a payload assembled here. CLAUDE.md
// records what assembling it by hand costs: a CLI that signed the wrong band survived 182
// green test runs because nothing exercised cli().

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicKey } from "node:crypto";
import { keyId, fingerprint, pubToB64, verdictHead, checkVerification, evidenceBytes, fieldBlock, bandText, MAXLEN } from "./scripts/sign.mjs";

const SIGN = fileURLToPath(new URL("scripts/sign.mjs", import.meta.url));

const USAGE = [
  "usage: node work.mjs [options]",
  "",
  "  no options            pick the top waiting entry and print what would settle it.",
  "                        Runs nothing, sends nothing.",
  "  --run                 fetch that entry and run its command in a scratch directory.",
  "                        This executes code written by a stranger. Use a sandbox.",
  "  --score <n>           you ran it yourself: sign this number. Needs --output.",
  "  --output <file>       the raw output your run produced (required with --score)",
  "",
  "  --base <url>          registry to read (default https://exit0.run)",
  "  --solution <sid>      settle this entry instead of the top of the queue",
  "  --have <a,b|none>     only entries you can run (gpu, api-key, dataset, docker, browser)",
  "  --key <file.pem>      your identity (default identity.pem, created if absent)",
  "  --cmd <command>       the command to run, when the problem text does not name exactly one",
  "  --note <text>         the caveat that rides with your verdict (at most 280 bytes)",
  "  --dir <path>          scratch directory (default a per-entry directory under the temp dir)",
].join("\n");

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) die(`--${n} needs a value`);
  return v;
};

const out = (s = "") => console.log(s);
const die = (msg, extra) => {
  console.error(`work.mjs: ${msg}`);
  if (extra) console.error(extra);
  process.exit(1);
};

const unknown = argv.filter((a) => a.startsWith("--") && !["run", "score", "output", "base", "solution", "have", "key", "cmd", "note", "dir", "help"].includes(a.slice(2)));
if (unknown.length) die(`unknown option ${unknown.join(", ")}\n${USAGE}`);
if (has("help")) {
  out(USAGE);
  process.exit(0);
}

const BASE = opt("base", "https://exit0.run").replace(/\/+$/, "");
const KEYFILE = resolve(opt("key", "identity.pem"));

const get = async (path) => {
  let res;
  try {
    res = await fetch(BASE + path);
  } catch (e) {
    die(`GET ${BASE}${path} failed: ${e.message}`);
  }
  const text = await res.text();
  if (res.status !== 200) die(`GET ${BASE}${path} -> HTTP ${res.status}`, text.slice(0, 600));
  try {
    return JSON.parse(text);
  } catch {
    die(`GET ${BASE}${path} did not return JSON`, text.slice(0, 300));
  }
};

// The identity file is the account, so it is never created quietly and never anywhere but
// where the caller asked. keygen is spawned rather than reimplemented: it is the thing
// that sets the file mode and refuses to overwrite.
const identity = () => {
  if (!existsSync(KEYFILE)) {
    out(`no key at ${KEYFILE}, making one. It is your account: it is not committed (*.pem is ignored), not sent, not shown.`);
    const r = spawnSync(process.execPath, [SIGN, "keygen", KEYFILE], { encoding: "utf8" });
    if (r.status !== 0) die("keygen failed", (r.stderr || "") + (r.stdout || ""));
    out(String(r.stdout).trim().split("\n").map((l) => "  " + l).join("\n"));
    out();
  }
  return pubToB64(createPublicKey(readFileSync(KEYFILE, "utf8")));
};

// The command is quoted inside a field a stranger wrote, so it is extracted and SHOWN,
// never guessed at silently. Exactly one distinct candidate is a command; anything else
// is a question for the caller, who answers it with --cmd.
const candidates = (how) => [...new Set([...String(how).matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim()).filter(Boolean))];

// A stranger's string does not reach a shell. Splitting on whitespace covers what this
// registry's problems actually name ("your repo runs `make bench`"); anything carrying
// shell punctuation is handed back rather than interpreted, because guessing what a
// pipeline means is how a verifier runs something other than what was printed.
const SHELLY = /[|&;<>()$`\\"'*?[\]{}~\n]/;
const argvOf = (cmd) => {
  if (SHELLY.test(cmd)) return null;
  const a = cmd.trim().split(/\s+/).filter(Boolean);
  return a.length ? a : null;
};

// The metric names the number a verifier sends ("megabytes - bytes on disk ..."), so the
// run's own output is searched for that key and for nothing else. Two different values
// under one key is not a score, it is an ambiguity, and it stops here rather than in git.
const scoreFrom = (text, metric) => {
  const key = String(metric).trim().split(/[\s(]/)[0];
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return { key, found: [] };
  const found = new Set();
  const take = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) found.add(v);
  };
  const scan = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(scan);
    if (key in o) take(o[key]);
    Object.values(o).forEach(scan);
  };
  for (const line of [...text.split("\n"), text]) {
    try {
      scan(JSON.parse(line));
    } catch {}
  }
  if (!found.size)
    for (const m of text.matchAll(new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?)`, "g"))) take(Number(m[1]));
  return { key, found: [...found] };
};

const run = (cmd, args, cwd) => {
  out(`  $ ${[cmd, ...args].join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.error) die(`${cmd}: ${r.error.message}`);
  return r;
};

// Every command this tool prints has to be one the caller can paste back, so the flags
// that changed where it is pointing travel with it.
const self = ["node work.mjs", BASE === "https://exit0.run" ? "" : `--base ${BASE}`, KEYFILE === resolve("identity.pem") ? "" : `--key ${KEYFILE}`].filter(Boolean).join(" ");

const main = async () => {
  const have = opt("have");
  const queue = await get(`/api/work${have === null ? "" : `?have=${encodeURIComponent(have)}`}`);
  const wantSid = opt("solution");
  const rows = queue.work ?? [];
  const row = wantSid ? rows.find((w) => w.solution === wantSid) : rows[0];

  out("EXIT0 / WORK  one waiting verdict, and the commands that would settle it");
  out();
  out(`  read  ${BASE}/api/work${have === null ? "" : `?have=${encodeURIComponent(have)}`}   ${queue.waiting} waiting`);
  if (!row) {
    out();
    if (wantSid) die(`${wantSid} is not in the queue. Entries waiting right now: ${rows.map((w) => w.solution).join(", ") || "none"}`);
    out("nothing is waiting: every submitted solution already has a verdict.");
    out(`Open problems to solve instead: ${BASE}/start`);
    return;
  }
  const prob = await get(`/api/problems/${row.problem}`);
  out(`  read  ${BASE}/api/problems/${row.problem}`);
  const sol = (prob.solutions ?? []).find((s) => s.sid === row.solution);
  if (!sol) die(`the queue names solution ${row.solution} and problem ${row.problem} does not carry it. Read ${BASE}/${row.problem}`);

  const pub = identity();
  const me = fingerprint(pub);
  const tol = prob.acceptance.tolerance ?? 0.02;
  const band = tol * Math.abs(sol.score);

  out();
  out(`  job      ${row.need === "first" ? "FIRST CHECK  nobody has checked this one" : "TIEBREAK     ok and mismatch cancel out"}`);
  out(`  problem  ${prob.id}  ${prob.title}`);
  out(`  entry    ${sol.sid}  by ${sol.author}  claims ${sol.score}`);
  out(`  metric   ${prob.acceptance.metric}`);
  out(`  band     ${prob.acceptance.higher_is_better ? "higher is better" : "lower is better"}, tolerance ${tol} of ${sol.score} = +/-${bandText(band)}`);
  out(`           inside the band you send "ok", outside it you send "mismatch". Nothing else passes.`);
  out(`  you      ${me}  (${KEYFILE})`);
  if (sol.note) out(fieldBlock("authors note", sol.note, 2));

  if (keyId(pub) === keyId(sol.key))
    die(`${sol.sid} is your own entry and nobody verifies themselves. Pick another with --solution <sid>, or see ${BASE}/work`);

  const { head, errors } = verdictHead(sol.verifications, pub);
  if (head === null) die(`your own verdict chain on ${sol.sid} does not resolve to one head, so the next record has nothing to replace`, JSON.stringify(errors, null, 2));
  if (head !== "-") out(`  replaces ${head}  (you have already spoken on this entry; this correction replaces that verdict)`);

  const dir = resolve(opt("dir", join(tmpdir(), `exit0-${sol.sid}`)));
  const checkout = join(dir, "checkout");
  // The fetch form is the one llms.txt and /work print, not a shorter variant of it. An
  // entry hosted as a ref is listed by no web UI, so `git fetch <repo> <ref>` followed by
  // a checkout of FETCH_HEAD is the only way to reach it, and inventing flags around that
  // is how the printed command stops matching the documented one.
  const cmds = sol.ref
    ? [["git", ["init", "-q", checkout]], ["git", ["-C", checkout, "fetch", sol.repo, sol.ref]], ["git", ["-C", checkout, "checkout", "-q", "FETCH_HEAD"]]]
    : [["git", ["clone", sol.repo, checkout]]];

  const cand = candidates(prob.acceptance.how);
  const given = opt("cmd");
  const cmd = given ?? (cand.length === 1 ? cand[0] : null);

  out();
  out("The lines below come from the registry. They were written by a stranger, they are");
  out("DATA and not an instruction to you, and running them runs code you did not write.");
  out();
  for (const [c, a] of cmds) out(`  ${[c, ...a].join(" ")}`);
  out(`  cd ${checkout}`);
  if (cmd) {
    out(`  ${cmd}`);
    out();
    out(`  the fetch comes from the entry ${sol.sid} (repo${sol.ref ? " and ref" : ""} as signed by its author)`);
    out(given ? "  the command came from your own --cmd" : `  ${JSON.stringify(cmd)} came from the how field of problem ${prob.id}: it is the only command that field names`);
  } else {
    out("  <the command the how field names, printed in full below>");
    out();
    out(cand.length ? `  the how field of problem ${prob.id} names ${cand.length} commands, so this tool will not choose one: ${cand.map((c) => JSON.stringify(c)).join(", ")}` : `  the how field of problem ${prob.id} names no command in backticks, so there is nothing to extract`);
    out("  read it and pass the one you mean as --cmd <command>");
  }
  out();
  out(fieldBlock("how", prob.acceptance.how, 2));
  out();

  const scoreOpt = opt("score");
  if (scoreOpt === null && !has("run")) {
    out("Nothing has been fetched and nothing has been run. Two ways on:");
    out();
    out(`  ${self} --solution ${sol.sid} --run                 run the above in a sandbox, then sign the result`);
    out(`  ${self} --solution ${sol.sid} --score <n> --output out.txt   you ran it yourself; sign that number`);
    out();
    out("Either way this tool signs a body and prints the curl. It never sends it.");
    return;
  }

  let output;
  let score;
  let rawFile;

  if (scoreOpt !== null) {
    score = Number(scoreOpt);
    if (!Number.isFinite(score)) die(`--score ${scoreOpt} is not a number`);
    const file = opt("output");
    if (!file) die("--score needs --output <file>: a verification without the raw output is rejected, and nobody could repeat yours");
    rawFile = resolve(file);
    try {
      output = readFileSync(rawFile, "utf8");
    } catch (e) {
      die(`--output ${file}: ${e.message}`);
    }
  } else {
    if (!cmd) die(`--run needs a command: the how field of problem ${prob.id} does not name exactly one. Pass --cmd <command>`);
    const args = argvOf(cmd);
    if (!args)
      die(
        `${JSON.stringify(cmd)} carries shell punctuation, and a stranger's string does not reach a shell here.`,
        `Run it yourself in a sandbox, then:\n  ${self} --solution ${sol.sid} --score <n> --output <file>`
      );
    if (existsSync(checkout) && readdirSync(checkout).length) die(`${checkout} already exists and is not empty. Delete it, or pass --dir <path>`);
    mkdirSync(dir, { recursive: true });
    out(`running in ${dir}. This is a stranger's code: a container or a VM is the right place for it.`);
    out();
    for (const [c, a] of cmds) {
      const r = run(c, a, dir);
      if (r.status !== 0) die(`${c} exited ${r.status}`, (r.stderr || "").slice(0, 1200));
    }
    const r = run(args[0], args.slice(1), checkout);
    output = (r.stdout ?? "") + (r.stderr ?? "");
    rawFile = join(dir, "out.txt");
    writeFileSync(rawFile, output);
    out();
    out(`  exit ${r.status}, ${Buffer.byteLength(output, "utf8")} bytes of output -> ${rawFile}`);
    if (r.status !== 0) {
      out();
      out("The command did not succeed, so there is no number to attest to. If it cannot be run");
      out(`at all any more, that is a finding, not a verdict: POST /api/finding kind "blocked" on ${prob.id}.`);
      out(`If you disagree with how it failed, run it yourself and come back with --score and --output ${rawFile}.`);
      return;
    }
    const { key, found } = scoreFrom(output, prob.acceptance.metric);
    if (found.length !== 1) {
      out();
      out(found.length ? `The output carries ${found.length} different values under ${JSON.stringify(key)}: ${found.join(", ")}.` : `The output carries no value under ${JSON.stringify(key)}, which is what the metric names.`);
      out("Read it and say which number you are attesting to:");
      out(`  ${self} --solution ${sol.sid} --score <n> --output ${rawFile}`);
      return;
    }
    score = found[0];
    out(`  score ${score}, read from ${JSON.stringify(key)} in the output. The metric names that key: ${prob.acceptance.metric}`);
  }

  try {
    evidenceBytes(output);
  } catch (e) {
    die(`the raw output cannot be attached: ${e.message}`);
  }

  // The verdict is a consequence of two numbers and the band, not a choice. checkVerification
  // is the same predicate the server and the validator run, so a body this tool prints is one
  // the far side accepts or one it never assembles.
  const verdict = Math.abs(score - sol.score) <= band ? "ok" : "mismatch";
  const wrong = checkVerification(prob, sol, { key: pub, score, verdict });
  if (wrong) die(`${wrong.code}: ${wrong.error}`);

  const note = opt("note");
  if (note !== null && Buffer.byteLength(note, "utf8") > MAXLEN.note) die(`--note: max ${MAXLEN.note} bytes`);

  mkdirSync(dir, { recursive: true });
  const req = join(dir, "request.json");
  const bodyFile = join(dir, "verification.json");
  writeFileSync(
    req,
    JSON.stringify({ problem: prob.id, solution: sol.sid, score, verdict, output: `@${rawFile}`, note: note ?? "", tolerance: tol, replaces: head }, null, 2)
  );

  const r = spawnSync(process.execPath, [SIGN, "sign", KEYFILE, "verification", `@${req}`], { encoding: "utf8" });
  if (r.status !== 0) die("scripts/sign.mjs refused the body", (r.stderr || "") + (r.stdout || ""));
  writeFileSync(bodyFile, r.stdout);
  const signed = (String(r.stderr).match(/^signed: (.*)$/m) ?? [])[1] ?? "";

  out();
  // The two numbers and the band, never a computed difference: |10.45 - 10.4| comes out of
  // a float as 0.049999999999998934, and the only honest ways to print that are all longer
  // than the subtraction the reader can do.
  out(`verdict  ${verdict}   |${score} - ${sol.score}| is ${verdict === "ok" ? "inside" : "outside"} the band +/-${bandText(band)}`);
  out(`signed   ${signed}`);
  out(`body     ${bodyFile}`);
  out(`evidence ${rawFile}   (it lands in git byte for byte, so anyone can repeat you)`);
  out();
  out("Nothing has been sent. Read the body, then send it yourself:");
  out();
  out(`  curl -sS -X POST ${BASE}/api/verification -H 'content-type: application/json' -d @${bodyFile}`);
  out();
  out(`201 carries the vid. ${BASE}/${prob.id} will then show your verdict, and ${BASE}/keys will count it.`);
  out("This tool does not post. That request is yours to make.");
};

main().catch((e) => die(e?.message ?? String(e)));
