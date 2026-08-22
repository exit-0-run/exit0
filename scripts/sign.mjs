#!/usr/bin/env node
// Tozsamosc, ktora nie nalezy do nikogo poza wlascicielem klucza.
// Zero zaleznosci — node:crypto ma Ed25519 natywnie.
//
//   node scripts/sign.mjs keygen
//   node scripts/sign.mjs sign identity.pem solution 0001 https://gitlab.com/ty/repo 0.42
//   node scripts/sign.mjs whoami identity.pem

import { generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey, createHash } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";

// Kontrakt podpisu. Zmiana tutaj uniewaznia KAZDY istniejacy podpis.
export const payload = (action, ...parts) => ["open-problems/v1", action, ...parts].join("|");

export const pubToB64 = (keyObject) =>
  keyObject.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");

export const b64ToPub = (b64) => {
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 32) throw new Error("klucz publiczny Ed25519 ma 32 bajty");
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
};

// Publiczna nazwa obywatela. Wyprowadzona z klucza, wiec nikt jej nie przydziela.
export const fingerprint = (keyB64) =>
  createHash("sha256").update(Buffer.from(keyB64, "base64")).digest("hex").slice(0, 12);

export const check = (keyB64, sigB64, msg) => {
  try {
    return verify(null, Buffer.from(msg), b64ToPub(keyB64), Buffer.from(sigB64, "base64"));
  } catch {
    return false;
  }
};

// Uzywane przez build.mjs do walidacji tego, co juz lezy w repo.
export const verifyEntry = (action, problemId, entry) => {
  if (!entry.key) return "kazdy wpis musi miec klucz publiczny";
  if (!entry.sig) return "jest key, brakuje sig";
  if (fingerprint(entry.key) !== entry.author) return "author nie zgadza sie z odciskiem klucza";
  return check(entry.key, entry.sig, payload(action, problemId, entry.repo, entry.score))
    ? null
    : "podpis nie zgadza sie z trescia wpisu";
};

// --- CLI ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "keygen") {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    writeFileSync("identity.pem", privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    const pub = pubToB64(publicKey);
    console.log("klucz prywatny -> ./identity.pem   NIE commituj, nie wysylaj, nie pokazuj");
    console.log("klucz publiczny:", pub);
    console.log("twoja nazwa:    ", fingerprint(pub));
  } else if (cmd === "whoami") {
    const pub = pubToB64(createPublicKey(readFileSync(rest[0] ?? "identity.pem", "utf8")));
    console.log(fingerprint(pub), pub);
  } else if (cmd === "sign") {
    const [pem, action, ...parts] = rest;
    if (!pem || !action || !parts.length)
      throw new Error("uzycie: sign <klucz.pem> <action> <czesc> [czesc...]");
    const priv = createPrivateKey(readFileSync(pem, "utf8"));
    const pub = pubToB64(createPublicKey(priv));
    const msg = payload(action, ...parts);
    console.log(JSON.stringify({
      author: fingerprint(pub),
      key: pub,
      sig: sign(null, Buffer.from(msg), priv).toString("base64"),
      signed: msg,
    }, null, 2));
  } else {
    console.log("uzycie: keygen | whoami [klucz.pem] | sign <klucz.pem> <action> <czesc...>");
    process.exit(1);
  }
}
