// Strict semver parse, hand written scanner. No regex.
const MAXLEN = 256, MAXSAFE = Number.MAX_SAFE_INTEGER;

const isDigit = (c) => c >= 48 && c <= 57;
const isAlnumHyphen = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45;
const isAlphaHyphen = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45;

export function parse(v) {
  if (typeof v !== "string") return null;
  // The reference checks the length BEFORE trimming and matches AFTER. Two different
  // strings, and getting that backwards is a mismatch on every padded input.
  if (v.length > MAXLEN) return null;
  v = v.trim();
  let i = 0;
  const n = v.length;
  if (i < n && (v.charCodeAt(i) === 118)) i++;            // optional leading v

  // numeric identifier: 0 | [1-9]\d*
  const num = () => {
    const st = i;
    if (i >= n || !isDigit(v.charCodeAt(i))) return -1;
    if (v.charCodeAt(i) === 48) { i++; if (i < n && isDigit(v.charCodeAt(i))) return -1; }
    else while (i < n && isDigit(v.charCodeAt(i))) i++;
    const s = v.slice(st, i);
    const x = +s;
    return x > MAXSAFE ? -1 : x;
  };

  const major = num(); if (major < 0) return null;
  if (i >= n || v.charCodeAt(i) !== 46) return null; i++;
  const minor = num(); if (minor < 0) return null;
  if (i >= n || v.charCodeAt(i) !== 46) return null; i++;
  const patch = num(); if (patch < 0) return null;

  const prerelease = [];
  if (i < n && v.charCodeAt(i) === 45) {
    i++;
    for (;;) {
      const st = i;
      let alpha = false;
      while (i < n && isAlnumHyphen(v.charCodeAt(i))) { if (isAlphaHyphen(v.charCodeAt(i))) alpha = true; i++; }
      if (i === st) return null;
      const id = v.slice(st, i);
      if (!alpha) {
        if (id.length > 1 && id.charCodeAt(0) === 48) return null;   // leading zero
        const x = +id;
        if (x > MAXSAFE) return null;
        prerelease.push(x);
      } else prerelease.push(id);
      if (i < n && v.charCodeAt(i) === 46) { i++; continue; }
      break;
    }
  }
  const build = [];
  if (i < n && v.charCodeAt(i) === 43) {
    i++;
    for (;;) {
      const st = i;
      while (i < n && isAlnumHyphen(v.charCodeAt(i))) i++;
      if (i === st) return null;
      build.push(v.slice(st, i));
      if (i < n && v.charCodeAt(i) === 46) { i++; continue; }
      break;
    }
  }
  if (i !== n) return null;
  return { major, minor, patch, prerelease, build };
}
