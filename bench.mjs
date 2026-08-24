// Both arms, one run, one machine. Fetches the reference and the corpus by pinned
// version and pinned commit, so the number does not depend on what happens to be
// installed here.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SEMVER = "7.7.2";
const CORPUS_REPO = "https://github.com/npm/node-semver.git";
const CORPUS_COMMIT = "281055e7716ef0415a8826972471331989ede58c";
const W = ".work";

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

if (!existsSync(join(W, "ref/package/index.js"))) {
  rmSync(W, { recursive: true, force: true });
  mkdirSync(join(W, "ref"), { recursive: true });
  run("npm", ["pack", `semver@${SEMVER}`, "--silent"], join(W, "ref"));
  run("tar", ["xzf", `semver-${SEMVER}.tgz`], join(W, "ref"));
}
if (!existsSync(join(W, "corpus/.git"))) {
  // Pinned by COMMIT, not by tag: a tag can be moved and then the corpus a verifier
  // measures is not the corpus the number was measured on.
  mkdirSync(join(W, "corpus"), { recursive: true });
  run("git", ["init", "-q"], join(W, "corpus"));
  run("git", ["remote", "add", "origin", CORPUS_REPO], join(W, "corpus"));
  run("git", ["fetch", "-q", "--depth", "1", "origin", CORPUS_COMMIT], join(W, "corpus"));
  run("git", ["checkout", "-q", "FETCH_HEAD"], join(W, "corpus"));
}
const got = run("git", ["rev-parse", "HEAD"], join(W, "corpus")).trim();
if (got !== CORPUS_COMMIT) throw new Error(`corpus is at ${got}, expected ${CORPUS_COMMIT}`);

const semver = (await import(pathToFileURL(join(process.cwd(), W, "ref/package/index.js")).href)).default;
const mine = await import(pathToFileURL(join(process.cwd(), "scan.mjs")).href);

// Every string literal in the fixtures. Versions, ranges, and junk like "use strict":
// the junk is the point, those are the reject cases.
const fixtures = join(W, "corpus/test/fixtures");
const set = new Set();
for (const f of readdirSync(fixtures))
  for (const m of readFileSync(join(fixtures, f), "utf8").matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"/g))
    set.add(m[1] ?? m[2]);
const corpus = [...set].filter((s) => s.length > 0 && s.length <= 256);

const ser = (r) => (r === null || r === undefined ? "null" : JSON.stringify({ major: r.major, minor: r.minor, patch: r.patch, prerelease: r.prerelease, build: r.build }));

// Conformance FIRST. A throughput number from a parser that disagrees is not a result.
let mismatches = 0;
for (const s of corpus) {
  let a, b;
  try { a = ser(mine.parse(s)); } catch { a = "THROW"; }
  try { b = ser(semver.parse(s)); } catch { b = "THROW"; }
  if (a !== b) mismatches++;
}

// Split the corpus, because the headline ratio is not what a reader will assume it is.
// The reference constructs and catches a TypeError for every input it rejects, so on a
// reject-heavy corpus most of the distance is exception cost, not parsing. Both halves
// are printed: the number the problem asks for is the whole-corpus one, and anybody who
// reads only that should still be able to see what it is made of.
const accepts = corpus.filter((s) => semver.parse(s) !== null);
const rejects = corpus.filter((s) => semver.parse(s) === null);

const bytes = corpus.reduce((a, s) => a + Buffer.byteLength(s), 0);
// The corpus is 5 KB, which is a conformance corpus and not a stopwatch. Repeating it is
// how the clock gets long enough to mean anything, and REPEATS is printed so nobody has
// to guess what the megabytes were.
const REPEATS = 400;
const time = (f, list = corpus) => {
  const b = list.reduce((a, s) => a + Buffer.byteLength(s), 0);
  const t = process.hrtime.bigint();
  for (let r = 0; r < REPEATS; r++) for (const s of list) f(s);
  return (b * REPEATS) / 1048576 / (Number(process.hrtime.bigint() - t) / 1e9);
};
const med = (a) => a.sort((x, y) => x - y)[1];
const pair = (list) => {
  for (let i = 0; i < 2; i++) { time(mine.parse, list); time((s) => semver.parse(s), list); }
  const A = [], B = [];
  for (let i = 0; i < 3; i++) { A.push(time(mine.parse, list)); B.push(time((s) => semver.parse(s), list)); }
  return [med(A), med(B)];
};
const [A0, B0] = pair(corpus);
const [A1, B1] = pair(accepts);

console.log(JSON.stringify({
  // The score. A ratio and not megabytes per second, because throughput is a fact about
  // the machine: an absolute number would make every verifier on other hardware report a
  // mismatch about nothing. Both arms ran in this process, on this box, minutes apart.
  speedup: +(A0 / B0).toFixed(2),
  mb_per_second: +A0.toFixed(2),
  baseline_mb_per_second: +B0.toFixed(2),
  inputs: corpus.length,
  mismatches,
  // The same measurement over the inputs the reference ACCEPTS. This is the parsing win
  // on its own, with the reference's exception path taken out of it.
  mb_per_second_accepts: +A1.toFixed(2),
  baseline_mb_per_second_accepts: +B1.toFixed(2),
  accepts: accepts.length,
  rejects: rejects.length,
  repeats: REPEATS,
  corpus_commit: CORPUS_COMMIT,
  reference: `semver@${SEMVER}`,
}));
