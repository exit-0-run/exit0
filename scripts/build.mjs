#!/usr/bin/env node
// Walidator i generator. Kolejnosc krokow jest czescia kontraktu:
//   1. parse  2. pola pochodne  3. schemat  4. semantyka  5. podpisy i dowody  6. zapis
// Zapis wykonuje sie WYLACZNIE wtedy, gdy nie ma ani jednego bledu — inaczej
// przebieg zakonczony bledem zostawialby policzone pola w plikach zrodlowych.
// Zero zaleznosci. Odpalane w CI na kazdym PR i przez serwer przed kazdym commitem.

import { readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  MAXLEN, keyId, fingerprint, check, payload, problemFields,
  canonUrl, canonText, canonLine, solutionId, verificationId,
  evidencePath, checkVerification, cell, solCmp,
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

const files = readdirSync(DIR).filter((f) => f.endsWith(".json") && !f.startsWith("_")).sort();
const loaded = [];
for (const file of files) {
  const path = join(DIR, file);
  let text, p;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    errors.push(`${path}: nie da sie odczytac (${e.message})`);
    continue;
  }
  try {
    p = JSON.parse(text);
  } catch (e) {
    errors.push(`${path}: nie parsuje sie jako JSON (${e.message})`);
    continue;
  }
  if (p === null || typeof p !== "object" || Array.isArray(p)) {
    errors.push(`${path}: problem musi byc obiektem JSON`);
    continue;
  }
  loaded.push({ path, file, p, text });
}

// --- 2. pola pochodne ---
// To jedyne miejsce w calym repo, ktore zapisuje verified, disputed, settled,
// verified_by i status. Serwer ich nie tyka, klient ich nie przysyla.

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
    errors.push(`${path}: nie da sie policzyc pol pochodnych (${e.message}) — sprawdz ksztalt solutions/verifications`);
  }
}

// --- 3. schemat ---
// Podzbior JSON Schema, swiadomie waski. Slowo kluczowe spoza listy jest
// bledem, a nie cichym pominieciem: inaczej literowka w schemacie wyglada
// jak przechodzacy test.

const KEYWORDS = new Set(["type", "required", "properties", "items", "enum", "pattern", "minLength", "maxLength", "minimum", "maximum", "additionalProperties"]);
const ANNOTATIONS = new Set(["$schema", "title", "description", "$comment"]);
const TYPES = new Set(["object", "array", "string", "number", "boolean", "null"]);

const schemaKeywords = (node, at) => {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    errors.push(`${SCHEMA}: ${at} nie jest obiektem schematu`);
    return;
  }
  for (const k of Object.keys(node)) {
    if (ANNOTATIONS.has(k)) continue;
    if (!KEYWORDS.has(k)) {
      errors.push(`${SCHEMA}: nieobslugiwane slowo kluczowe "${k}" w ${at} — build.mjs zna tylko: ${[...KEYWORDS].join(", ")}`);
      continue;
    }
    if (k === "additionalProperties" && node[k] !== false)
      errors.push(`${SCHEMA}: additionalProperties w ${at} — obslugiwana jest wylacznie wartosc false`);
    if (k === "type") {
      for (const t of Array.isArray(node.type) ? node.type : [node.type])
        if (!TYPES.has(t)) errors.push(`${SCHEMA}: nieobslugiwany type "${t}" w ${at}`);
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
      err(`${at}: oczekiwano ${want.join(" albo ")}, jest ${typeOf(value)}`);
      return;
    }
  }
  if (node.enum && !node.enum.includes(value)) {
    err(`${at}: dozwolone wartosci to ${node.enum.map((x) => JSON.stringify(x)).join(", ")}`);
    return;
  }
  const t = typeOf(value);
  if (t === "string") {
    if (node.pattern !== undefined && !new RegExp(node.pattern).test(value)) err(`${at}: nie pasuje do wzorca ${node.pattern}`);
    if (node.minLength !== undefined && value.length < node.minLength) err(`${at}: min ${node.minLength} znakow`);
    if (node.maxLength !== undefined && value.length > node.maxLength) err(`${at}: max ${node.maxLength} znakow`);
  }
  if (t === "number") {
    if (node.minimum !== undefined && value < node.minimum) err(`${at}: minimum ${node.minimum}`);
    if (node.maximum !== undefined && value > node.maximum) err(`${at}: maksimum ${node.maximum}`);
  }
  if (t === "object") {
    for (const r of node.required ?? []) if (!(r in value)) err(`${at}: brakuje wymaganego pola "${r}"`);
    if (node.additionalProperties === false)
      for (const k of Object.keys(value)) if (!(node.properties && k in node.properties)) err(`${at}: nieznane pole "${k}"`);
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

// Zepsuty schemat wstrzymuje walidacje wszystkich plikow. Zepsuty JEDEN plik
// problemu nie wstrzymuje pozostalych — kazdy odpowiada za siebie.
const clean = new Set();
if (schema && errors.length === beforeSchema) {
  for (const { path, p } of loaded) {
    const before = errors.length;
    validate(schema, p, "$", (m) => errors.push(`${path}: ${m}`));
    if (errors.length === before) clean.add(path);
  }
}

// --- 4. semantyka ---
// Sprawdzane tylko dla plikow, ktore przeszly schemat: inaczej powtarzalibysmy
// ten sam blad ksztaltu w kilku brzmieniach.

const seenIds = new Set();
const fromHead = (path) => {
  try {
    return execFileSync("git", ["show", `HEAD:${path}`], { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
  } catch {
    return null;
  }
};

for (const { path, file, p } of loaded) {
  if (!clean.has(path)) continue;
  const err = (m) => errors.push(`${path}: ${m}`);

  if (seenIds.has(p.id)) err(`id ${p.id} juz istnieje w innym pliku`);
  else seenIds.add(p.id);
  if (!file.startsWith(`${p.id}-`)) err(`nazwa pliku musi zaczynac sie od ${p.id}-`);

  // tolerancja jest niezmienna od pierwszej weryfikacji: inaczej autor
  // przesuwalby pasmo pod juz zlozonymi podpisami
  if (p.solutions.some((s) => s.verifications.length)) {
    const prev = fromHead(path);
    let old = null;
    try {
      old = prev === null ? null : JSON.parse(prev);
    } catch {}
    const was = old && old.acceptance ? old.acceptance.tolerance : undefined;
    if (was !== undefined && was !== p.acceptance.tolerance)
      err(`acceptance.tolerance zmienione z ${was} na ${p.acceptance.tolerance}, a przy problemie sa juz weryfikacje — otworz nowy problem`);
  }

  const seenSid = new Set();
  const seenDedup = new Set();
  p.solutions.forEach((s, i) => {
    if (seenSid.has(s.sid)) err(`solutions[${i}]: sid ${s.sid} wystepuje dwa razy`);
    else seenSid.add(s.sid);
    let dedup = null;
    try {
      dedup = `${canonUrl(s.repo)}|${keyId(s.key)}`;
    } catch {}
    if (dedup !== null) {
      if (seenDedup.has(dedup)) err(`solutions[${i}]: to samo repo od tego samego klucza wystepuje dwa razy — zapis powinien byc podmiana, nie dopiskiem`);
      else seenDedup.add(dedup);
    }
    const seenVid = new Set();
    s.verifications.forEach((v, j) => {
      if (seenVid.has(v.vid)) err(`solutions[${i}].verifications[${j}]: vid ${v.vid} wystepuje dwa razy`);
      else seenVid.add(v.vid);
    });
  });
}

// --- 5. podpisy, postac kanoniczna, dowody ---
// Wszystko, co przyjal serwer, da sie tu przeliczyc od zera, bez sieci.

const sameField = (fn, v, label, max, err) => {
  try {
    if (fn(v, label, max) !== v) err(`${label}: zapisana wartosc nie jest kanoniczna`);
  } catch (e) {
    err(`${label}: ${e.message}`);
  }
};

// Kazde sprawdzenie podpisu jest wypisane wprost: check(key, sig, payload(akcja, pola)).
// Bez opakowania, bo opakowanie ukrywa kontrakt — dokladnie tak zginal verifyEntry.
const sigOk = (key, sig, msg, err, what) => {
  if (msg !== null && !check(key, sig, msg)) err(`${what}: podpis nie zgadza sie z trescia (payload: ${msg.slice(0, 200)})`);
};

// keyId rzuca na kluczu spoza gramatyki. Schemat go tu nie przepusci, ale build.mjs
// biegnie w sciezce zapisu serwera: wyjatek zamiast bledu to 500 zamiast 422.
const canonicalKey = (k) => {
  try {
    return k === keyId(k);
  } catch {
    return false;
  }
};

for (const { path, p } of loaded) {
  if (!clean.has(path)) continue;
  const err = (m) => errors.push(`${path}: ${m}`);

  sameField(canonLine, p.title, "title", MAXLEN.title, err);
  sameField(canonText, p.problem, "problem", MAXLEN.problem, err);
  sameField(canonText, p.acceptance.how, "acceptance.how", MAXLEN.how, err);
  sameField(canonLine, p.acceptance.metric, "acceptance.metric", MAXLEN.metric, err);

  // problem bez klucza jest legalny: to wpis otwarty pull requestem. Ale nazwa
  // wyprowadzona z klucza wymaga klucza, inaczej PR podszywa sie pod cudzy odcisk.
  if (p.key === undefined && /^[0-9a-f]{12}$/.test(p.opened_by ?? ""))
    err("opened_by wyglada jak odcisk klucza, a problem nie jest podpisany");
  if (p.key !== undefined || p.sig !== undefined) {
    if (p.key === undefined || p.sig === undefined) err("jest key albo sig, musza byc oba");
    else if (!canonicalKey(p.key)) err("key problemu nie jest w postaci kanonicznej base64");
    else {
      if (fingerprint(p.key) !== p.opened_by) err("opened_by nie zgadza sie z odciskiem klucza");
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

    if (!canonicalKey(s.key)) err(`${at}: key nie jest w postaci kanonicznej base64`);
    else {
      if (fingerprint(s.key) !== s.author) err(`${at}: author nie zgadza sie z odciskiem klucza`);
      try {
        if (solutionId(p.id, s.repo, s.score, s.key) !== s.sid) err(`${at}: sid nie zgadza sie z trescia wpisu`);
      } catch (e) {
        err(`${at}: nie da sie policzyc sid (${e.message})`);
      }
    }
    let smsg = null;
    try {
      smsg = payload("solution", { problem: p.id, repo: s.repo, score: s.score, model: s.model, note: s.note });
    } catch (e) {
      err(`${at}: ${e.message}`);
    }
    sigOk(s.key, s.sig, smsg, err, at);

    s.verifications.forEach((v, j) => {
      const vat = `${at}.verifications[${j}]`;
      if (!canonicalKey(v.key)) err(`${vat}: key nie jest w postaci kanonicznej base64`);
      else {
        if (fingerprint(v.key) !== v.verifier) err(`${vat}: verifier nie zgadza sie z odciskiem klucza`);
        try {
          if (verificationId(s.sid, v.key, v.output_sha256, v.verdict, v.score) !== v.vid) err(`${vat}: vid nie zgadza sie z trescia wpisu`);
        } catch (e) {
          err(`${vat}: nie da sie policzyc vid (${e.message})`);
        }
      }
      let vmsg = null;
      try {
        vmsg = payload("verification", { problem: p.id, solution: s.sid, score: v.score, verdict: v.verdict, output_sha256: v.output_sha256 });
      } catch (e) {
        err(`${vat}: ${e.message}`);
      }
      sigOk(v.key, v.sig, vmsg, err, vat);

      // niezmiennik 3 i pasmo tolerancji: ta sama funkcja, ktorej uzywa serwer
      const verdict = checkVerification(p, s, v);
      if (verdict) err(`${vat}: ${verdict.error}`);

      // sciezke wyprowadzamy PRZED dotknieciem dysku, nigdy z pola evidence
      let want = null;
      try {
        want = evidencePath(p.id, v.output_sha256);
      } catch (e) {
        err(`${vat}: ${e.message}`);
      }
      if (want !== null) {
        if (v.evidence !== want) err(`${vat}: evidence musi wskazywac ${want}`);
        let blob = null;
        try {
          blob = readFileSync(want);
        } catch {
          err(`${vat}: brak pliku dowodu ${want} — flaga bez dowodu nie jest flaga`);
        }
        if (blob !== null && sha(blob) !== v.output_sha256) err(`${vat}: sha256 pliku dowodu nie zgadza sie z output_sha256`);
      }
    });
  });
}

// --- 6. zapis ---

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
    const sol = ordered(s, ["sid", "repo", "author", "key", "sig", "model", "score", "note", "at", "verified", "disputed", "settled", "verified_by", "verifications"]);
    sol.verifications = s.verifications.map((v) => ordered(v, ["vid", "verifier", "key", "sig", "score", "verdict", "output_sha256", "evidence", "at"]));
    return sol;
  });
  return out;
};

if (errors.length) {
  console.error("NIE PRZESZLO:\n" + errors.map((e) => "  - " + e).join("\n"));
  process.exit(1);
}

const shaped = loaded.map(({ path, text, p }) => {
  const out = shape(p);
  return { path, text, p, out, next: JSON.stringify(out, null, 2) + "\n" };
});

const badge = { open: "otwarty", "in-progress": "w robocie", solved: "ROZWIAZANY", dead: "martwy" };
const rows = shaped
  .map(({ p }) => p)
  .sort((a, b) => a.id.localeCompare(b.id))
  .map((p) => {
    const sols = [...p.solutions].sort(solCmp(p));
    const good = sols.filter((s) => s.verified && !s.disputed);
    const sporne = sols.filter((s) => s.disputed).length;
    const link = good.length
      ? `[${good.length} zweryfikowanych](${cell(good[0].repo)})`
      : sols.length
        ? `${sols.length} zgloszonych, 0 zweryfikowanych`
        : "—";
    return `| ${p.id} | ${cell(p.title)} | ${badge[p.status]} | ${link}${sporne ? ` (${sporne} sporne)` : ""} |`;
  });

const table = [
  `_${shaped.length} problemow, ${shaped.filter(({ p }) => p.status === "solved").length} rozwiazanych. Generowane przez scripts/build.mjs — nie edytuj recznie._`,
  "",
  "| # | Problem | Status | Rozwiazania |",
  "|---|---|---|---|",
  ...rows,
].join("\n");

let readme;
try {
  readme = readFileSync(README, "utf8");
} catch {
  console.error(`${README}: brak pliku, a to w nim build.mjs przepisuje tabele`);
  process.exit(1);
}
const a = readme.indexOf(START);
const b = readme.indexOf(END);
if (a === -1 || b === -1 || b < a) {
  console.error(`${README}: brak znacznikow ${START} / ${END} albo sa w zlej kolejnosci`);
  process.exit(1);
}
const nextReadme = readme.slice(0, a + START.length) + "\n" + table + "\n" + readme.slice(b);

// Read API: jeden plik, serwowany przez raw.githubusercontent.com. Bez serwera.
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

const writeAtomic = (path, text) => {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
};

if (CHECK) {
  // generated_at zmienia sie co dobe, wiec porownujemy tylko tresc
  const strip = (s) => s.replace(/"generated_at": "[^"]*",?\n/, "");
  const stale = [
    ...shaped.filter(({ text, next }) => text !== next).map(({ path }) => path),
    ...(strip(read(INDEX)) !== strip(nextIndex) ? [INDEX] : []),
    ...(nextReadme !== readme ? [README] : []),
  ];
  if (stale.length) {
    console.error(`nieaktualne: ${stale.join(", ")}. Odpal \`node scripts/build.mjs\` i dodaj wynik do commita.`);
    process.exit(1);
  }
  console.log(`OK — ${shaped.length} problemow, README aktualny.`);
} else {
  for (const { path, text, next } of shaped) if (text !== next) writeAtomic(path, next);
  if (nextReadme !== readme) writeAtomic(README, nextReadme);
  if (read(INDEX) !== nextIndex) writeAtomic(INDEX, nextIndex);
  console.log(`OK — ${shaped.length} problemow, README + index.json przepisane.`);
}
