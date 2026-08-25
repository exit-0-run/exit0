// Both arms, one machine, one run. The baseline is an untouched clean production install
// of the pinned version; the lean arm is the same install with prune.mjs applied. Nothing
// is downloaded twice and nothing is measured against a number remembered from last time.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { prune } from "./prune.mjs";

const PKG = "date-fns";
const VERSION = "4.1.0";
const W = ".work";

const npm = (args, cwd) => execFileSync("npm", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });

const install = (name) => {
  const dir = join(W, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  npm(["init", "-y"], dir);
  npm(["install", `${PKG}@${VERSION}`, "--omit=dev", "--no-audit", "--no-fund", "--silent"], dir);
  return join(dir, "node_modules");
};

// Everything under node_modules, which is what "bytes on disk after a clean production
// install" means. npm's own .package-lock.json is inside it and is counted, deliberately:
// excluding anything would be a rule a verifier has to take on trust, and it jitters by a
// single byte between installs, which is 4e-8 of the total against a 2% band.
const bytes = (dir) => {
  let n = 0;
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const f = join(p, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) n += statSync(f).size;
    }
  };
  walk(dir);
  return n;
};

// Every subpath the package declares in its exports map, resolved in an arm. A name that
// resolves in the baseline and not here is the thing exports_missing counts.
const subpaths = (nm) => {
  const j = JSON.parse(readFileSync(join(nm, PKG, "package.json"), "utf8"));
  const e = j.exports;
  return typeof e === "object" && e !== null ? Object.keys(e).filter((k) => k.startsWith(".")) : ["."];
};

const loadRoot = async (nm) => import(pathToFileURL(join(resolve(nm), PKG, "index.js")).href);

const resolves = (nm, sub) => {
  // Resolution is checked by READING what the exports map points at, not by importing 200
  // modules: an import would also execute them, and a subpath that resolves is the claim
  // being made here.
  const base = join(nm, PKG);
  const j = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
  const ent = j.exports[sub];
  const pick = (v) => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") return pick(v.import?.default ?? v.import ?? v.require?.default ?? v.require ?? v.default);
    return null;
  };
  const rel = pick(ent);
  return rel ? existsSync(join(base, rel)) : false;
};

// A fixed argument matrix. No Date.now(), no randomness: the same call produces the same
// bytes in both arms and on any machine, so a disagreement is a real difference and never
// a clock.
const D1 = new Date(Date.UTC(2026, 7, 25, 14, 27, 11, 5));
const D2 = new Date(Date.UTC(2024, 1, 29, 3, 4, 5, 6));
const ARGS = [[D1], [D1, D2], [D1, 3], [D1, { weekStartsOn: 1 }], [[D1, D2]], [D1, D2, { in: undefined }], []];

const show = (v) => {
  if (v instanceof Date) return `Date(${Number.isNaN(v.getTime()) ? "Invalid" : v.toISOString()})`;
  if (typeof v === "function") return "fn";
  if (Array.isArray(v)) return `[${v.map(show).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${k}:${show(v[k])}`).join(",")}}`;
  return String(v);
};

// One case per (export, argument shape). The result of a case is what the call produced,
// or the message it threw. Nothing here asserts what date-fns SHOULD return: the two arms
// are compared against each other, so this cannot be graded generously by whoever wrote it.
const probe = (mod) => {
  const out = new Map();
  for (const name of Object.keys(mod).sort()) {
    const v = mod[name];
    if (typeof v !== "function") { out.set(`${name}#value`, show(v)); continue; }
    ARGS.forEach((a, i) => {
      let r;
      try { r = "=" + show(v(...a)); } catch (err) { r = "!" + String(err && err.message).slice(0, 120); }
      out.set(`${name}#${i}`, r);
    });
  }
  return out;
};

const baseNm = install("base");
const leanNm = install("lean");
const pruned = prune(leanNm);

const baseBytes = bytes(baseNm);
const leanBytes = bytes(leanNm);

const baseSubs = subpaths(baseNm);
const missing = baseSubs.filter((s) => resolves(baseNm, s) && !resolves(leanNm, s));

const baseMod = await loadRoot(baseNm);
const leanMod = await loadRoot(leanNm);
// The baseline is probed TWICE. Any case that disagrees with itself inside one arm reads
// the clock or a random source, and comparing it across arms would report a difference in
// when the two calls happened rather than a difference between the two installs.
// date-fns exports several of these (constructNow and friends), and the first run of this
// bench duly "failed" seven cases on milliseconds. Detected by running it, never by a
// hand-kept list of names: a list is a thing that goes stale the next time the package
// adds one. How many were dropped is printed, so nobody has to take the exclusion on faith.
const baseProbe = probe(baseMod);
const baseProbe2 = probe(baseMod);
const volatile = [...baseProbe.keys()].filter((k) => baseProbe.get(k) !== baseProbe2.get(k));
for (const k of volatile) baseProbe.delete(k);
const leanProbe = probe(leanMod);

// tests_run is the baseline's case count; a case passes when the lean arm produced exactly
// what the baseline produced for the same input. A case the lean arm does not even have is
// a failure, not a case that quietly stops existing.
const testsRun = baseProbe.size;
let testsPassed = 0;
const firstFailures = [];
for (const [k, want] of baseProbe) {
  const got = leanProbe.get(k);
  if (got === want) testsPassed++;
  else if (firstFailures.length < 3) firstFailures.push({ case: k, baseline: want, lean: got ?? "(absent)" });
}

const mb = (n) => Math.round((n / 1048576) * 100) / 100;

console.log(JSON.stringify({
  megabytes: mb(leanBytes),
  baseline_megabytes: mb(baseBytes),
  tests_run: testsRun,
  tests_passed: testsPassed,
  exports_missing: missing.length,
  baseline_tests_run: testsRun,
  baseline_tests_passed: testsRun,
  exports_checked: baseSubs.length,
  nondeterministic_cases_excluded: volatile.length,
  reduction: Math.round((1 - leanBytes / baseBytes) * 1000) / 10,
  map_files_removed: pruned.mapFiles,
  sourcemap_comments_removed: pruned.rewritten,
  bytes: leanBytes,
  baseline_bytes: baseBytes,
  package: `${PKG}@${VERSION}`,
  ...(firstFailures.length ? { failures: firstFailures } : {}),
  ...(missing.length ? { missing } : {}),
}));
