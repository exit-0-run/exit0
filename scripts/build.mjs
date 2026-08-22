#!/usr/bin/env node
// Waliduje problems/*.json i przepisuje tabele w README.md miedzy znacznikami.
// Zero zaleznosci. Odpalane w CI na kazdym PR.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { verifyEntry } from "./sign.mjs";

const DIR = "problems";
const README = "README.md";
const START = "<!-- INDEX:START -->";
const END = "<!-- INDEX:END -->";

const errors = [];
const problems = [];
const seenIds = new Set();

const STATUSES = ["open", "in-progress", "solved", "dead"];

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort()) {
  const path = join(DIR, file);
  let p;
  try {
    p = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    errors.push(`${path}: nie parsuje sie jako JSON (${e.message})`);
    continue;
  }

  const err = (m) => errors.push(`${path}: ${m}`);

  if (!/^\d{4}$/.test(p.id ?? "")) err("id musi byc 4 cyframi, np. \"0007\"");
  else if (seenIds.has(p.id)) err(`id ${p.id} juz istnieje`);
  else seenIds.add(p.id);

  if (!file.startsWith(`${p.id}-`)) err(`nazwa pliku musi zaczynac sie od ${p.id}-`);
  if (!p.title || p.title.length < 3 || p.title.length > 120) err("title: 3-120 znakow");
  if (!STATUSES.includes(p.status)) err(`status musi byc jednym z: ${STATUSES.join(", ")}`);
  if (!p.problem || p.problem.length < 20) err("problem: opisz go, min 20 znakow");
  if (!p.acceptance?.how) err("acceptance.how: podaj komende, ktora obcy odpali sam");
  if (!p.acceptance?.metric) err("acceptance.metric: podaj co jest mierzone");

  const sols = p.solutions ?? [];
  if (!Array.isArray(sols)) err("solutions musi byc lista");
  else
    sols.forEach((s, i) => {
      if (!/^https?:\/\//.test(s.repo ?? "")) err(`solutions[${i}].repo musi byc URL-em`);
      if (!s.author) err(`solutions[${i}].author wymagany`);
      if (typeof s.verified !== "boolean") err(`solutions[${i}].verified musi byc true/false`);
      if (s.verified && !s.verified_by) err(`solutions[${i}]: verified=true wymaga verified_by`);
      if (s.verified && s.verified_by?.toLowerCase() === s.author?.toLowerCase())
        err(`solutions[${i}]: nie mozesz zweryfikowac wlasnego rozwiazania (${s.author})`);
      const sigErr = verifyEntry("solution", p.id, s);
      if (sigErr) err(`solutions[${i}]: ${sigErr}`);
    });

  if (p.status === "solved" && !sols.some((s) => s.verified))
    err("status=solved wymaga co najmniej jednego rozwiazania z verified=true");

  problems.push(p);
}

if (errors.length) {
  console.error("NIE PRZESZLO:\n" + errors.map((e) => "  - " + e).join("\n"));
  process.exit(1);
}

const badge = { open: "otwarty", "in-progress": "w robocie", solved: "ROZWIAZANY", dead: "martwy" };
const rows = problems
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((p) => {
    const best = (p.solutions ?? []).filter((s) => s.verified);
    const link = best.length ? `[${best.length} zweryfikowanych](${best[0].repo})` : (p.solutions?.length ? `${p.solutions.length} zgloszonych, 0 zweryfikowanych` : "—");
    return `| ${p.id} | ${p.title} | ${badge[p.status]} | ${link} |`;
  });

const table = [
  `_${problems.length} problemow, ${problems.filter((p) => p.status === "solved").length} rozwiazanych. Generowane przez scripts/build.mjs — nie edytuj recznie._`,
  "",
  "| # | Problem | Status | Rozwiazania |",
  "|---|---|---|---|",
  ...rows,
].join("\n");

const readme = readFileSync(README, "utf8");const a = readme.indexOf(START);
const b = readme.indexOf(END);
if (a === -1 || b === -1) {
  console.error(`README.md: brak znacznikow ${START} / ${END}`);
  process.exit(1);
}
const next = readme.slice(0, a + START.length) + "\n" + table + "\n" + readme.slice(b);

// Read API: jeden plik, serwowany przez raw.githubusercontent.com. Bez serwera.
const index = JSON.stringify(
  {
    generated_at: new Date().toISOString().slice(0, 10),
    counts: {
      total: problems.length,
      open: problems.filter((p) => p.status === "open").length,
      solved: problems.filter((p) => p.status === "solved").length,
    },
    problems,
  },
  null,
  2
) + "\n";

const INDEX = "index.json";
let prevIndex = "";
try {
  prevIndex = readFileSync(INDEX, "utf8");
} catch {}

if (process.argv.includes("--check")) {
  // generated_at zmienia sie co dobe, wiec porownujemy tylko tresc
  const strip = (s) => s.replace(/"generated_at": "[^"]*",?\n/, "");
  if (strip(prevIndex) !== strip(index)) {
    console.error("index.json nieaktualny. Odpal `node scripts/build.mjs`.");
    process.exit(1);
  }
  if (next !== readme) {
    console.error("README nieaktualny. Odpal `node scripts/build.mjs` i dodaj wynik do commita.");
    process.exit(1);
  }
  console.log(`OK — ${problems.length} problemow, README aktualny.`);
} else {
  writeFileSync(README, next);
  writeFileSync(INDEX, index);
  console.log(`OK — ${problems.length} problemow, README + index.json przepisane.`);
}
