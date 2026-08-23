#!/usr/bin/env node
// Tozsamosc, kontrakt podpisu i postac kanoniczna. Jeden modul, bo regula
// zaimplementowana dwa razy zawsze sie rozjezdza: server.mjs i build.mjs
// IMPORTUJA stad, nigdy nie odtwarzaja.
//
//   node scripts/sign.mjs keygen [plik.pem] [--force]
//   node scripts/sign.mjs whoami [plik.pem]
//   node scripts/sign.mjs sign <klucz.pem> <action> <json|@plik|->

import { generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey, createHash } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Kontrakt podpisu. Zmiana tutaj uniewaznia KAZDY istniejacy podpis.
export const PREFIX = "open-problems/v2";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const bytes = (s) => Buffer.byteLength(s, "utf8");

// Budzety sa w BAJTACH utf-8, nie w znakach.
export const MAXLEN = { title: 120, problem: 4000, how: 2000, metric: 200, model: 80, note: 280, repo: 300, output: 32768 };

export const bad = (code, msg, extra) => {
  const e = new Error(msg);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
};

// Klucz publiczny w POSTACI KANONICZNEJ. base64 jest wieloznaczne: cztery rozne
// stringi dekoduja sie do tych samych 32 bajtow, wiec porownywanie stringow
// przepuszcza samoweryfikacje. Porownuj WYLACZNIE keyId.
export const keyId = (b64) => {
  if (typeof b64 !== "string") throw bad(400, "key musi byc tekstem");
  const r = Buffer.from(b64, "base64");
  if (r.length !== 32) throw bad(400, "klucz publiczny Ed25519 ma 32 bajty w base64");
  return r.toString("base64");
};

export const fp32 = (b64) => sha(Buffer.from(keyId(b64), "base64"));
export const fingerprint = (b64) => fp32(b64).slice(0, 12);

// Token liczbowy: "%.9f" bez koncowych zer. Ta sama regula w kazdym jezyku.
export const numToken = (n) => {
  if (typeof n !== "number" || !Number.isFinite(n)) throw bad(400, "musi byc liczba JSON (nie tekst, nie null)");
  const x = n + 0;
  if (Math.abs(x) >= 1e15) throw bad(400, "liczba za duza: |wartosc| < 1e15");
  let t = x.toFixed(9);
  if (t.includes(".")) t = t.replace(/0+$/, "").replace(/\.$/, "");
  if (Number(t) !== x) throw bad(400, "liczba: max 9 miejsc po przecinku");
  if (t.replace(/[-.]/g, "").replace(/^0+/, "").length > 15) throw bad(400, "liczba: max 15 cyfr znaczacych");
  return t;
};

export const canonUrl = (raw) => {
  if (typeof raw !== "string") throw bad(400, "repo musi byc tekstem");
  if (bytes(raw) > MAXLEN.repo) throw bad(400, `repo: max ${MAXLEN.repo} bajtow`);
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw bad(400, "repo nie jest URL-em");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw bad(400, "repo musi byc http(s)");
  if (!u.hostname) throw bad(400, "repo bez hosta");
  u.hash = "";
  u.username = "";
  u.password = "";
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.replace(/\/+$/, "");
  let s = u.toString();
  if (s.endsWith("?")) s = s.slice(0, -1);
  return s;
};

// Znaki sterujace C0, DEL, separatory linii i sterowanie BiDi. Tabulator i LF
// sa poza zbiorem celowo: normalizuja je regexy nizej. Zbior jest zbudowany z
// escape'ow w stringu, bo literal niedrukowalny czyni ten plik binarnym.
const CTRL = new RegExp("[\\u0000-\\u0008\\u000B-\\u001F\\u007F\\u200E\\u200F\\u202A-\\u202E\\u2028\\u2029\\u2066-\\u2069]", "g");
const NUL = String.fromCharCode(0);

export const canonText = (raw, label, max) => {
  if (typeof raw !== "string") throw bad(400, `${label} musi byc tekstem`);
  const s = raw
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(CTRL, "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (bytes(s) > max) throw bad(400, `${label}: max ${max} bajtow, ma ${bytes(s)}`);
  return s;
};

export const canonLine = (raw, label, max) => {
  const s = canonText(raw, label, Infinity).replace(/\n/g, " ").replace(/ +/g, " ").trim();
  if (bytes(s) > max) throw bad(400, `${label}: max ${max} bajtow, ma ${bytes(s)}`);
  return s;
};

// Serwer NIGDY nie poprawia po cichu. Albo postac kanoniczna, albo 400 z podpowiedzia.
export const assertCanon = (fn, v, label, max) => {
  const c = fn(v, label, max);
  if (c !== v) throw bad(400, `${label}: przyslij postac kanoniczna`, { canonical: c });
  return v;
};

// Surowy output weryfikacji NIE jest kanonikalizowany: to dowod, nie tresc.
// Zapisujemy bajt w bajt, podpisujemy jego sha256.
export const evidenceBytes = (raw) => {
  if (typeof raw !== "string") throw bad(400, "output musi byc tekstem");
  if (!raw.trim()) throw bad(400, "surowy output jest wymagany");
  if (raw.indexOf(NUL) !== -1) throw bad(400, "output nie moze zawierac bajtu zerowego");
  const b = Buffer.from(raw, "utf8");
  if (b.length > MAXLEN.output) throw bad(400, `output: max ${MAXLEN.output} bajtow, ma ${b.length} — podlinkuj go zamiast wklejac`);
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

// --- kontrakt podpisu ---
// Kazde pole zmiennej dlugosci jest ramkowane jako <dlugosc_utf8>:<wartosc>,
// kazde pozostale jest tokenem z gramatyki, ktora nie moze zawierac "|".
// Injektywnosc jest wiec strukturalna, a payload zostaje czytelny w tresci 403.

const F = (s) => `${bytes(s)}:${s}`;

const pid = (v) => {
  if (typeof v !== "string" || !/^\d{4}$/.test(v)) throw bad(400, 'problem: 4 cyfry, np. "0001"');
  return v;
};
const hex16 = (v, l) => {
  if (typeof v !== "string" || !/^[0-9a-f]{16}$/.test(v)) throw bad(400, `${l}: 16 znakow hex`);
  return v;
};
const hex64 = (v, l) => {
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) throw bad(400, `${l}: 64 znaki hex`);
  return v;
};
const verdictT = (v) => {
  if (v !== "ok" && v !== "mismatch") throw bad(400, 'verdict musi byc "ok" albo "mismatch"');
  return v;
};
const boolT = (v, l) => {
  if (v === undefined || v === null) return "0";
  if (typeof v !== "boolean") throw bad(400, `${l} musi byc true/false`);
  return v ? "1" : "0";
};
const optNum = (v) => (v === undefined || v === null ? "-" : numToken(v));
// Stan, ktory to zgloszenie zastepuje: "-" gdy pod (problem, repo, klucz) nie
// ma jeszcze nic, albo sid wpisu, ktory tam lezal w chwili podpisu. Bez tego
// tokenu podpisane body jest wazne w nieskonczonosc: kazdy, kto je widzial —
// a widzi je caly rejestr, bo key i sig sa w gicie — cofa nim autora do
// starszego wyniku, kasuje weryfikacje i pobiera przy okazji limit autora.
export const replacesT = (v) => (v === undefined || v === null || v === "-" ? "-" : hex16(v, "replaces"));
const tolT = (v) => {
  const t = v ?? 0.02;
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > 0.5)
    throw bad(400, "tolerance: liczba z przedzialu [0, 0.5]");
  return numToken(t);
};

// JEDYNE miejsce, w ktorym plaskie body i zapisany plik sie spotykaja.
export const problemFields = (x) => ({
  title: x.title,
  problem: x.problem,
  how: x.acceptance ? x.acceptance.how : x.how,
  metric: x.acceptance ? x.acceptance.metric : x.metric,
  higher_is_better: x.acceptance ? x.acceptance.higher_is_better : x.higher_is_better,
  baseline: x.acceptance ? x.acceptance.baseline : x.baseline,
  tolerance: (x.acceptance ? x.acceptance.tolerance : x.tolerance) ?? 0.02,
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
    ].join("|");
  if (action === "verification")
    return [
      PREFIX,
      "verification",
      pid(f.problem),
      hex16(f.solution, "solution"),
      numToken(f.score),
      verdictT(f.verdict),
      hex64(f.output_sha256, "output_sha256"),
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
    ].join("|");
  throw bad(404, "nieznana akcja");
};

// --- identyfikatory wyprowadzone z tresci ---

// sid jest LANCUCHEM, nie adresem tresci: kazdy bierze sid stanu, ktory
// zastapil. Bez tego ogniwa "podpisane body wchodzi dokladnie raz" bylo prawda
// tylko o jeden krok. sid liczony wylacznie z (problem, repo, score, klucz)
// wraca do tej samej wartosci, gdy autor wraca do wczesniejszego wyniku
// (0.42 -> 0.39 -> 0.42), a razem z nim ozywa KAZDE historyczne body, ktorego
// replaces wskazywalo ten stan — i znowu cofa autora, kasuje cudze weryfikacje
// i pobiera limit autora. Zmierzone: stan wracal do sid_1 w trzech ruchach.
// Z ogniwem stan nie moze sie powtorzyc: powtorka wymagalaby kolizji sha256,
// bo "-" wystepuje dokladnie raz (rekord nigdy nie znika), a kazde nastepne
// ogniwo commituje sie do poprzedniego.
export const solutionId = (problemId, repo, score, key, replaces) =>
  sha(
    Buffer.from(
      [PREFIX, "sid", pid(problemId), F(canonUrl(repo)), numToken(score), keyId(key), replacesT(replaces)].join("|"),
      "utf8"
    )
  ).slice(0, 16);

export const verificationId = (sid, key, outSha, verdict, score) =>
  sha(
    Buffer.from(
      [PREFIX, "vid", hex16(sid, "sid"), keyId(key), hex64(outSha, "output_sha256"), verdictT(verdict), numToken(score)].join("|"),
      "utf8"
    )
  ).slice(0, 16);

export const evidencePath = (problemId, outSha) =>
  `problems/evidence/${pid(problemId)}-${hex64(outSha, "output_sha256")}.txt`;

// --- regula akceptacji: niezmiennik 3 plus tolerancja ---
// Wolana z server.mjs I z build.mjs. Zwraca null albo {code, error} — kod
// idzie do klienta bez przemapowania, walidator traktuje kazde nie-null jako blad.

// Zmierzone, nie zalozone — nie zamieniaj tego na samo keyId(a) === keyId(b),
// bo predykat zacznie rzucac zamiast zwracac {code, error}. Awaryjne porownanie
// napisow NIE oslabia niezmiennika 3: (1) dla kazdej z czterech pisowni base64
// prawdziwego klucza keyId sie UDAJE, wiec wariantowe obejscie nigdy tu nie
// dochodzi i konczy sie na 403; (2) klucz, na ktorym keyId rzuca, ma check()
// zawsze false, wiec nie da sie pod nim wyprodukowac zadnej weryfikacji.
const sameKey = (a, b) => {
  try {
    return keyId(a) === keyId(b);
  } catch {
    return a === b;
  }
};

// Pasmo to iloczyn dwoch liczb zmiennoprzecinkowych, wiec 0.02 * 0.39 wychodzi
// 0.0078000000000000005. Porownanie nizej zostaje DOKLADNE — obcinamy tylko forme
// w komunikacie, i to w dol, zeby nigdy nie obiecac pasma szerszego niz egzekwowane.
const bandText = (b) => {
  const t = (Math.floor(b * 1e9) / 1e9).toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
  return t === "-0" ? "0" : t;
};

export const checkVerification = (p, sol, v) => {
  if (sameKey(v.key, sol.key)) return { code: 403, error: "nie mozesz zweryfikowac wlasnego rozwiazania" };
  if (v.verdict !== "ok" && v.verdict !== "mismatch") return { code: 400, error: 'verdict musi byc "ok" albo "mismatch"' };
  if (typeof v.score !== "number" || !Number.isFinite(v.score)) return { code: 400, error: "score weryfikacji musi byc liczba" };
  if (typeof sol.score !== "number" || !Number.isFinite(sol.score)) return { code: 400, error: "score rozwiazania musi byc liczba" };
  const tol = p.acceptance.tolerance ?? 0.02;
  const band = tol * Math.abs(sol.score);
  const diff = Math.abs(v.score - sol.score);
  if (v.verdict === "ok" && diff > band)
    return { code: 422, error: `verdict "ok" wymaga wyniku w pasmie +/-${bandText(band)} od ${sol.score}; masz ${v.score} — wyslij verdict "mismatch"` };
  if (v.verdict === "mismatch" && diff <= band)
    return { code: 422, error: `verdict "mismatch" wymaga wyniku POZA pasmem +/-${bandText(band)} od ${sol.score}; masz ${v.score} — to jest zgodnosc, wyslij verdict "ok"` };
  return null;
};

// --- render, wspoldzielony przez serwer i build.mjs ---

// Kontynuacja pola wielolinijkowego dostaje znacznik, ktorego kanonikalizacja
// NIE wyprodukuje: po canonText zadna linia tresci nie zaczyna sie od spacji,
// wiec "<wciecie>| " jest dla obcego tekstu nieosiagalne. Samo wciecie nie
// wystarczylo — linie rekordu ("metryka:", "rozwiazania:") stoja w tej samej
// kolumnie co kontynuacja, wiec wielolinijkowe `how` podszywalo sie pod nie.
const CONT = "| ";
export const fieldBlock = (label, value, indent = 6) =>
  value.split("\n").map((l, i) => " ".repeat(indent) + (i ? CONT : label + ": ") + l).join("\n");

// Komorka tabeli w README. Samo "\|" nie wystarcza z dwoch powodow, oba
// zmierzone na dzialajacym serwerze:
//   1. tytul z "<!-- INDEX:END -->" laduje W SRODKU regionu generowanego,
//      wiec build.mjs tnie README po CUDZYM znaczniku i przestaje sie zbiegac —
//      jeden podpisany POST wylaczal zapisy calego rejestru na stale,
//   2. "[klik](https://phish)" renderuje sie na GitHubie jako prawdziwy odnosnik
//      w tabeli, ktora caly projekt przedstawia jako zweryfikowana.
// Dlatego: "<", ">" i "&" ida na encje (to zabija znacznik), reszta interpunkcji
// Markdowna dostaje odwrotny ukosnik. Kolejnosc jest istotna — encje wchodza
// pierwsze, bo inaczej ukosnik trafilby w srodek "&amp;".
const ENT = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
export const cell = (s) =>
  String(s)
    .replace(/[&<>]/g, (c) => ENT[c])
    .replace(/[\\`*_[\]()~|!]/g, "\\$&")
    .replace(/\r?\n/g, " ");

// Cel odnosnika. Nawias zamykajacy przezywa canonUrl (sprawdzone:
// "https://example.com/a)x" wychodzi bez zmian), a w postaci [tekst](cel)
// konczy odnosnik za wczesnie i reszta URL-a staje sie tekstem strony.
// Postac <cel> tego nie ma; lamia ja tylko "<", ">" i biale znaki, a te
// canonUrl juz procentuje — wiec ponizsze jest siatka bezpieczenstwa, nie
// zmiana adresu.
export const mdUrl = (s) =>
  `<${String(s).replace(/[<>\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)}>`;

export const solCmp = (p) => (a, b) => {
  const w = (s) => (s.verified && !s.disputed ? 0 : 1);
  if (w(a) !== w(b)) return w(a) - w(b);
  if (a.score !== b.score) return p.acceptance.higher_is_better ? b.score - a.score : a.score - b.score;
  return a.sid.localeCompare(b.sid);
};

// --- CLI ---

const USAGE = [
  "uzycie:",
  "  node scripts/sign.mjs keygen [plik.pem] [--force]",
  "  node scripts/sign.mjs whoami [plik.pem]",
  "  node scripts/sign.mjs sign <klucz.pem> <solution|verification|problem> <json|@plik|->",
  "",
  "Trzeci argument komendy sign to DOKLADNIE to body, ktore zaraz POST-ujesz.",
  "Na stdout wychodzi kompletne body z polami key i sig; stderr niesie tylko komentarz.",
].join("\n");

const readArg = (a) => {
  if (a === "-") return readFileSync(0, "utf8");
  if (a.startsWith("@")) return readFileSync(a.slice(1), "utf8");
  return a;
};

// Kanonikalizacja po stronie klienta: serwer nigdy nie poprawia, wiec robi to
// CLI i mowi, co zmienilo.
const canonBody = (action, b, changed) => {
  const fix = (label, before, after) => {
    if (before !== undefined && before !== after) changed.push([label, before, after]);
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
    // "-" = pod (problem, repo, klucz) nie ma jeszcze nic. Poprawiajac wlasny
    // wpis, podaj sid, ktory tam lezy; serwer sprawdzi, czy nadal lezy.
    out.replaces = replacesT(b.replaces);
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
      output_sha256: fix("output_sha256", b.output_sha256, sha(evidenceBytes(output))),
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
    };
  throw bad(404, `nieznana akcja "${action}": solution, verification albo problem`);
};

const cli = (argv) => {
  const flags = argv.filter((a) => a.startsWith("--"));
  const [cmd, ...rest] = argv.filter((a) => !a.startsWith("--"));

  if (cmd === "keygen") {
    const out = rest[0] ?? "identity.pem";
    if (existsSync(out) && !flags.includes("--force")) {
      console.error(`${out} juz istnieje — to jest twoje konto. Nadpisz swiadomie: keygen ${out} --force`);
      process.exit(1);
    }
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(out, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    const pub = pubToB64(publicKey);
    console.log(`klucz prywatny -> ./${out}   NIE commituj, nie wysylaj, nie pokazuj`);
    console.log("klucz publiczny:", pub);
    console.log("twoja nazwa:    ", fingerprint(pub));
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
      throw bad(400, `trzeci argument nie jest poprawnym JSON-em: ${e.message}`);
    }
    const changed = [];
    const out = canonBody(action, parsed, changed);
    const msg = payload(action, out);
    out.key = pub;
    out.sig = sign(null, Buffer.from(msg, "utf8"), priv).toString("base64");
    for (const [label, before, after] of changed)
      console.error(`poprawiono ${label}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    console.error(`podpisano: ${msg}`);
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.error(USAGE);
  process.exit(1);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    cli(process.argv.slice(2));
  } catch (e) {
    console.error(`blad: ${e.message}`);
    if (e.canonical !== undefined) console.error(`postac kanoniczna: ${JSON.stringify(e.canonical)}`);
    process.exit(1);
  }
}
