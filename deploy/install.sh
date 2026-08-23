#!/usr/bin/env bash
# Stawia rejestr na czystym Debianie/Ubuntu. Odpalane jako root: sudo deploy/install.sh
# Drugie uruchomienie to aktualizacja: podmienia KOD, nie rusza danych rejestru.
# Do nadpisania (druga instancja na tej samej maszynie albo test):
#   DIR UNIT_DIR SVC_USER SVC_GROUP PORT
set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DIR="${DIR:-/srv/open-problems}"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
SVC_USER="${SVC_USER:-openproblems}"
SVC_GROUP="${SVC_GROUP:-$SVC_USER}"
PORT="${PORT:-8080}"
UNIT=open-problems.service

die() { echo "install: $*" >&2; exit 1; }
trap 'echo "install: PRZERWANE — deploy/RUNBOOK.md, sekcja Awarie. Usluga moze byc zatrzymana." >&2' ERR

# --- 1. czego wymagamy od hosta ---
command -v git       >/dev/null || die "brak git"
command -v systemctl >/dev/null || die "brak systemd (systemctl)"
NODE=$(command -v node) || die "brak node — zainstaluj Node 20+"
case "$NODE" in *[!a-zA-Z0-9_/.-]*) die "sciezka do node ma znak, ktorego nie wstawie do unitu: $NODE" ;; esac
NODE_MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "${NODE_MAJOR:-0}" -ge 20 ] 2>/dev/null || die "node $("$NODE" -v) — wymagane 20+"

# --- 2. komplet zrodla; kopia bez ktoregos z tych plikow to martwa usluga ---
for f in scripts/server.mjs scripts/build.mjs scripts/sign.mjs llms.txt README.md .gitignore \
         problems/_schema.json "deploy/$UNIT" deploy/Caddyfile deploy/RUNBOOK.md; do
  [ -e "$SRC/$f" ] || die "brak $f w $SRC"
done

# --- 3. katalog, prawa, uzytkownik ---
mkdir -p "$DIR" 2>/dev/null || die "nie moge utworzyc $DIR — odpal jako root"
[ -w "$DIR" ]      || die "brak prawa zapisu do $DIR — odpal jako root"
DIR=$(cd "$DIR" && pwd)   # unit chce sciezki absolutnej, a porownanie ponizej dokladnej
[ "$DIR" != "$SRC" ] || die "katalog uslugi nie moze byc katalogiem zrodlowym: krok 6 kasuje $DIR/scripts"
[ -d "$UNIT_DIR" ] || die "brak katalogu $UNIT_DIR"
[ -w "$UNIT_DIR" ] || die "brak prawa zapisu do $UNIT_DIR — odpal jako root"

id "$SVC_USER" >/dev/null 2>&1 || useradd --system -d "$DIR" -s /usr/sbin/nologin "$SVC_USER"

# Po chownie ponizej katalog nalezy do uslugi, wiec root (ten skrypt, potem RUNBOOK)
# dostalby od gita "dubious ownership". Wpis musi byc PRZED pierwsza komenda gita.
git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$DIR" \
  || git config --global --add safe.directory "$DIR"

# --- 4. nie nadpisuj cudzej niedokonczonej roboty ---
# Kontrola jest tylko do odczytu, wiec idzie PRZED zatrzymaniem uslugi: odmowa
# instalacji nie ma prawa zostawic rejestru wylaczonego.
if [ -d "$DIR/.git" ] && [ -n "$(git -C "$DIR" status --porcelain)" ]; then
  git -C "$DIR" status --short >&2
  die "$DIR ma niezacommitowane zmiany — rozwiaz recznie i powtorz (RUNBOOK: Awarie)"
fi

# --- 5. stop przed dotknieciem plikow ---
if systemctl is-active --quiet "$UNIT" 2>/dev/null; then
  echo "install: zatrzymuje $UNIT"
  systemctl stop "$UNIT"
fi

# --- 6. kod i dokumenty: zawsze swieze ---
# rm przed cp, zeby po starszej wersji nie zostal plik, ktorego juz nie ma w zrodle.
rm -rf "$DIR/scripts" "$DIR/deploy"
cp -r "$SRC/scripts" "$SRC/deploy" "$SRC/llms.txt" "$SRC/.gitignore" "$DIR/"
for f in DESIGN.md CLAUDE.md QUICKSTART.md AGENTS.md; do
  if [ -f "$SRC/$f" ]; then cp "$SRC/$f" "$DIR/"; else echo "install: pomijam brakujacy dokument $f" >&2; fi
done
# _schema.json to kontrakt plikow, czyli kod — build.mjs go czyta i musi isc ze skryptami.
mkdir -p "$DIR/problems"
cp "$SRC/problems/_schema.json" "$DIR/problems/"

# --- 7. dane rejestru: tylko zasiew, nigdy nadpisanie ---
# README.md i index.json wypelnia build.mjs. Skopiowane ze zrodla zostawialyby brudne
# drzewo, a brudne drzewo to dla serwera tryb read-only.
for f in "$SRC"/problems/[0-9]*.json; do
  [ -e "$f" ] || continue
  [ -e "$DIR/problems/$(basename "$f")" ] || cp "$f" "$DIR/problems/"
done
mkdir -p "$DIR/problems/evidence"
[ -f "$DIR/problems/evidence/.gitkeep" ] || : > "$DIR/problems/evidence/.gitkeep"
# Dowody sa adresowane suma sha256, wiec sa niezmienne — kopiujemy brakujace, zeby
# instalacja z pelnego klonu nie zostawila weryfikacji bez surowego outputu.
for f in "$SRC"/problems/evidence/*.txt; do
  [ -e "$f" ] || continue
  [ -e "$DIR/problems/evidence/$(basename "$f")" ] || cp "$f" "$DIR/problems/evidence/"
done
[ -f "$DIR/README.md" ] || cp "$SRC/README.md" "$DIR/"

# --- 8. build i commit; po tym kroku drzewo MUSI byc czyste ---
cd "$DIR"
"$NODE" scripts/build.mjs
[ -d .git ] || git init -q
git config user.email "registry@localhost"
git config user.name  "open-problems"
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -qm "deploy $(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
"$NODE" scripts/build.mjs --check
[ -z "$(git status --porcelain)" ] || die "drzewo $DIR zostalo brudne — serwer wszedlby w tryb read-only"

chown -R "$SVC_USER:$SVC_GROUP" "$DIR"

# --- 9. unit renderowany pod ten host ---
# Serwer wola `node` i `git` po nazwie, wiec katalog wykrytego node musi byc w PATH
# jednostki. Bez tego odczyty dzialaja, a kazdy zapis pada na ENOENT.
NODE_DIR=$(dirname "$NODE")
BASE_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
case ":$BASE_PATH:" in
  *":$NODE_DIR:"*) SVC_PATH="$BASE_PATH" ;;
  *)               SVC_PATH="$NODE_DIR:$BASE_PATH" ;;
esac

sed -e "s#^ExecStart=.*#ExecStart=$NODE scripts/server.mjs#" \
    -e "s#^Environment=PATH=.*#Environment=PATH=$SVC_PATH#" \
    -e "s#^Environment=PORT=.*#Environment=PORT=$PORT#" \
    -e "s#^User=.*#User=$SVC_USER#" \
    -e "s#^WorkingDirectory=.*#WorkingDirectory=$DIR#" \
    -e "s#^ReadWritePaths=.*#ReadWritePaths=$DIR#" \
    -e "s#^Documentation=.*#Documentation=file://$DIR/deploy/RUNBOOK.md#" \
    "$SRC/deploy/$UNIT" > "$UNIT_DIR/.$UNIT.new"
chmod 644 "$UNIT_DIR/.$UNIT.new"
mv "$UNIT_DIR/.$UNIT.new" "$UNIT_DIR/$UNIT"

systemctl daemon-reload
systemctl enable --now "$UNIT"

# --- 10. nie mow "stoi", zanim nie odpowie ---
"$NODE" -e '
const url = "http://127.0.0.1:" + process.argv[1] + "/api/pulse";
const fail = (m) => { console.error("install: " + m); process.exit(1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const main = async () => {
  let last = "brak polaczenia";
  for (let i = 0; i < 20; i++) {
    let res;
    try { res = await fetch(url); } catch (e) { last = e.message; await wait(500); continue; }
    const body = await res.text();
    if (!res.ok) fail("pulse odpowiedzial HTTP " + res.status + ": " + body.slice(0, 200));
    let j;
    try { j = JSON.parse(body); } catch { fail("pulse nie jest JSON-em: " + body.slice(0, 200)); }
    if (!j.head) fail("pulse bez pola head: " + body.slice(0, 200));
    if (j.writes && j.writes !== "ok") fail("serwer w trybie read-only: " + (j.reason ?? "brak powodu"));
    console.log("install: pulse OK, head=" + j.head + ", zapisy=" + (j.writes ?? "?"));
    return;
  }
  fail("serwer nie odpowiada na " + url + " (" + last + ")");
};
main();
' "$PORT" || die "usluga wstala, ale nie odpowiada — journalctl -u $UNIT -n 50"

echo
echo "install: gotowe. $DIR na porcie $PORT, jako $SVC_USER."
echo "  stan:   systemctl status $UNIT"
echo "  logi:   journalctl -u $UNIT -f"
echo "  puls:   curl -s localhost:$PORT/api/pulse"
echo "  TLS:    cp $DIR/deploy/Caddyfile /etc/caddy/Caddyfile, podmien domene, systemctl reload caddy"
echo "  kopia, aktualizacja, awarie: $DIR/deploy/RUNBOOK.md"
