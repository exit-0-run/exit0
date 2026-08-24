#!/usr/bin/env bash
# Brings the registry up on a clean Debian/Ubuntu. Run as root: sudo deploy/install.sh
# A second run is an update: it replaces the CODE, it does not touch registry data.
# Overridable (a second instance on the same machine, or a test):
#   DIR UNIT_DIR SVC_USER SVC_GROUP PORT
set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DIR="${DIR:-/srv/exit0}"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
SVC_USER="${SVC_USER:-exit0}"
SVC_GROUP="${SVC_GROUP:-$SVC_USER}"
# An update must not move the port of a running deployment. It did once: the default
# below silently rewrote 8081 to 8080, the reverse proxy kept talking to 8081, and the
# only symptom the installer could produce was "pulse answered HTTP 400: Invalid host
# header" - which reads like a bug in the server. So an existing unit's port wins
# unless PORT was named on purpose.
PORT_GIVEN=${PORT+yes}
PORT="${PORT:-8080}"
UNIT=exit0.service
WATCH=exit0-watch
MIRROR_UNIT=exit0-mirror
MIRROR_KEY="${MIRROR_KEY:-/etc/exit0/mirror_key}"
MIRROR_URL="${MIRROR_URL:-git@github.com:exit-0-run/exit0-registry.git}"

die() { echo "install: $*" >&2; exit 1; }

PORT_LIVE=$(sed -n 's/^Environment=PORT=//p' "${UNIT_DIR:-/etc/systemd/system}/exit0.service" 2>/dev/null | tail -1)
if [ -n "$PORT_LIVE" ] && [ "$PORT_LIVE" != "$PORT" ]; then
  if [ -z "${PORT_GIVEN:-}" ]; then
    echo "install: keeping the port this deployment already runs on: $PORT_LIVE (pass PORT=$PORT to move it)"
    PORT="$PORT_LIVE"
  else
    echo "install: MOVING the port $PORT_LIVE -> $PORT. Whatever proxies to $PORT_LIVE will 502 until you update it."
  fi
fi
trap 'echo "install: ABORTED. deploy/RUNBOOK.md, section Failures. The service may be stopped." >&2' ERR

# --- 1. what we require from the host ---
command -v git       >/dev/null || die "git missing"
command -v systemctl >/dev/null || die "systemd missing (systemctl)"
NODE=$(command -v node) || die "node missing: install Node 20+"
case "$NODE" in *[!a-zA-Z0-9_/.-]*) die "the node path has a character I will not put into the unit: $NODE" ;; esac
NODE_MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "${NODE_MAJOR:-0}" -ge 20 ] 2>/dev/null || die "node $("$NODE" -v): 20+ required"

# --- 2. complete source; a copy missing any of these files is a dead service ---
for f in scripts/server.mjs scripts/build.mjs scripts/sign.mjs llms.txt README.md .gitignore .gitattributes \
         problems/_schema.json "deploy/$UNIT" deploy/Caddyfile deploy/RUNBOOK.md \
         deploy/watch.sh deploy/backup.sh "deploy/$WATCH.service" "deploy/$WATCH.timer" \
         deploy/mirror.sh "deploy/$MIRROR_UNIT.service" "deploy/$MIRROR_UNIT.timer"; do
  [ -e "$SRC/$f" ] || die "$f missing in $SRC"
done

# --- 3. directory, permissions, user ---
mkdir -p "$DIR" 2>/dev/null || die "cannot create $DIR: run as root"
[ -w "$DIR" ]      || die "no write permission on $DIR: run as root"
DIR=$(cd "$DIR" && pwd)   # the unit wants an absolute path, the comparison below an exact one
[ "$DIR" != "$SRC" ] || die "the service directory cannot be the source directory: step 6 deletes $DIR/scripts"
[ -d "$UNIT_DIR" ] || die "directory $UNIT_DIR missing"
[ -w "$UNIT_DIR" ] || die "no write permission on $UNIT_DIR: run as root"

id "$SVC_USER" >/dev/null 2>&1 || useradd --system -d "$DIR" -s /usr/sbin/nologin "$SVC_USER"

# After the chown below the directory belongs to the service, so root (this script, then the
# RUNBOOK) would get "dubious ownership" from git. The entry must come BEFORE the first git command.
git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$DIR" \
  || git config --global --add safe.directory "$DIR"

# --- 4. do not overwrite somebody else's unfinished work ---
# The check is read-only, so it comes BEFORE stopping the service: a refused
# install has no right to leave the registry switched off.
if [ -d "$DIR/.git" ] && [ -n "$(git -C "$DIR" status --porcelain)" ]; then
  git -C "$DIR" status --short >&2
  die "$DIR has uncommitted changes: resolve them by hand and retry (RUNBOOK: Failures)"
fi

# --- 5. stop before touching files ---
if systemctl is-active --quiet "$UNIT" 2>/dev/null; then
  echo "install: stopping $UNIT"
  systemctl stop "$UNIT"
fi

# --- 6. code and documents: always fresh ---
# rm before cp, so no file dropped from the source survives from an older version.
# .gitattributes is code here, not a preference: without it git rewrites line
# endings in evidence and the committed blob stops matching its sha256.
rm -rf "$DIR/scripts" "$DIR/deploy"
cp -r "$SRC/scripts" "$SRC/deploy" "$SRC/llms.txt" "$SRC/.gitignore" "$SRC/.gitattributes" "$DIR/"
# README.md is CODE here, not registry data, even though build.mjs rewrites the table
# region inside it. Treating it as data (copy only when absent) meant the deployed prose
# was frozen at whatever the first install put there: the public mirror carried a README
# in the wrong language for a day while every other document was current. Copying it
# before the build is safe, because step 8 regenerates the table and commits, so the tree
# still comes out clean.
for f in DESIGN.md CLAUDE.md QUICKSTART.md AGENTS.md README.md; do
  if [ -f "$SRC/$f" ]; then cp "$SRC/$f" "$DIR/"; else echo "install: skipping missing document $f" >&2; fi
done
# _schema.json is the file contract, so it is code: build.mjs reads it and it must ship with the scripts.
mkdir -p "$DIR/problems"
cp "$SRC/problems/_schema.json" "$DIR/problems/"

# --- 7. registry data: seed only, never overwrite ---
# build.mjs fills in README.md and index.json. Copied from the source they would leave a dirty
# tree, and a dirty tree means read-only mode to the server.
for f in "$SRC"/problems/[0-9]*.json; do
  [ -e "$f" ] || continue
  [ -e "$DIR/problems/$(basename "$f")" ] || cp "$f" "$DIR/problems/"
done
mkdir -p "$DIR/problems/evidence"
[ -f "$DIR/problems/evidence/.gitkeep" ] || : > "$DIR/problems/evidence/.gitkeep"
# Evidence is addressed by sha256, so it is immutable: we copy what is missing, so an
# install from a full clone does not leave a verification without its raw output.
for f in "$SRC"/problems/evidence/*.txt; do
  [ -e "$f" ] || continue
  [ -e "$DIR/problems/evidence/$(basename "$f")" ] || cp "$f" "$DIR/problems/evidence/"
done

# --- 8. build and commit; after this step the tree MUST be clean ---
cd "$DIR"
"$NODE" scripts/build.mjs
[ -d .git ] || git init -q
git config user.email "registry@localhost"
git config user.name  "exit0"
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -qm "deploy $(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
"$NODE" scripts/build.mjs --check
[ -z "$(git status --porcelain)" ] || die "tree $DIR came out dirty: the server would enter read-only mode"

chown -R "$SVC_USER:$SVC_GROUP" "$DIR"

# --- 9. unit rendered for this host ---
# The server calls `node` and `git` by name, so the directory of the detected node must be in
# the unit's PATH. Without it reads work and every write dies on ENOENT.
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

# --- 9b. watchdog ---
# Nobody finds out that writes fell into read-only mode until somebody looks at
# /api/pulse by hand, and `head` does not show it: with writes suspended the server
# still serves the last good index, so head looks perfectly normal. WATCH=0 skips it.
if [ "${WATCH_ENABLE:-1}" = "1" ]; then
  sed -e "s#^WorkingDirectory=.*#WorkingDirectory=$DIR#" \
      -e "s#^ExecStart=.*#ExecStart=/bin/sh $DIR/deploy/watch.sh#" \
      -e "s#^Environment=EXIT0_URL=.*#Environment=EXIT0_URL=http://127.0.0.1:$PORT#" \
      -e "s#^Environment=EXIT0_DIR=.*#Environment=EXIT0_DIR=$DIR#" \
      -e "s#^Environment=EXIT0_UNIT=.*#Environment=EXIT0_UNIT=$UNIT#" \
      -e "s#^Documentation=.*#Documentation=file://$DIR/deploy/RUNBOOK.md#" \
      "$SRC/deploy/$WATCH.service" > "$UNIT_DIR/.$WATCH.service.new"
  chmod 644 "$UNIT_DIR/.$WATCH.service.new"
  mv "$UNIT_DIR/.$WATCH.service.new" "$UNIT_DIR/$WATCH.service"
  sed -e "s#^Documentation=.*#Documentation=file://$DIR/deploy/RUNBOOK.md#" \
      "$SRC/deploy/$WATCH.timer" > "$UNIT_DIR/.$WATCH.timer.new"
  chmod 644 "$UNIT_DIR/.$WATCH.timer.new"
  mv "$UNIT_DIR/.$WATCH.timer.new" "$UNIT_DIR/$WATCH.timer"
fi

# --- 9c. public mirror ---
# Default OFF unless a key is already there. A timer that fails every ten minutes
# because a credential was never created teaches the operator to ignore its alerts,
# and this host already has a watchdog whose alerts have to keep meaning something.
MIRROR_ENABLE="${MIRROR_ENABLE:-$([ -r "$MIRROR_KEY" ] && echo 1 || echo 0)}"
if [ "$MIRROR_ENABLE" = "1" ]; then
  [ -r "$MIRROR_KEY" ] || die "MIRROR_ENABLE=1 but no readable key at $MIRROR_KEY"
  install -d -m 700 /var/lib/exit0
  # Pin the host key now, while there is a terminal to complain to. At run time the
  # unit has ProtectHome, so ssh cannot learn a host on first contact: it fails with
  # a read-only-filesystem message that points at everything except the cause.
  MIRROR_KNOWN="$(dirname "$MIRROR_KEY")/known_hosts"
  if [ ! -s "$MIRROR_KNOWN" ]; then
    MIRROR_HOST=$(echo "$MIRROR_URL" | sed -e 's#^ssh://##' -e 's#^[^@]*@##' -e 's#[:/].*$##')
    [ -n "$MIRROR_HOST" ] || die "cannot read a host out of MIRROR_URL=$MIRROR_URL"
    command -v ssh-keyscan >/dev/null || die "ssh-keyscan missing, cannot pin the host key for $MIRROR_HOST"
    ssh-keyscan -t rsa,ecdsa,ed25519 "$MIRROR_HOST" > "$MIRROR_KNOWN.new" 2>/dev/null \
      || die "ssh-keyscan $MIRROR_HOST failed"
    [ -s "$MIRROR_KNOWN.new" ] || die "ssh-keyscan $MIRROR_HOST returned nothing"
    chmod 644 "$MIRROR_KNOWN.new"; mv "$MIRROR_KNOWN.new" "$MIRROR_KNOWN"
    echo "install: pinned the host key of $MIRROR_HOST in $MIRROR_KNOWN"
  fi
  sed -e "s#^WorkingDirectory=.*#WorkingDirectory=$DIR#" \
      -e "s#^ExecStart=.*#ExecStart=/bin/sh $DIR/deploy/mirror.sh#" \
      -e "s#^Environment=EXIT0_DIR=.*#Environment=EXIT0_DIR=$DIR#" \
      -e "s#^Environment=EXIT0_MIRROR=.*#Environment=EXIT0_MIRROR=$MIRROR_URL#" \
      -e "s#^Environment=EXIT0_MIRROR_KEY=.*#Environment=EXIT0_MIRROR_KEY=$MIRROR_KEY#" \
      -e "s#^Environment=EXIT0_MIRROR_KNOWN_HOSTS=.*#Environment=EXIT0_MIRROR_KNOWN_HOSTS=$MIRROR_KNOWN#" \
      -e "s#^Documentation=.*#Documentation=file://$DIR/deploy/RUNBOOK.md#" \
      "$SRC/deploy/$MIRROR_UNIT.service" > "$UNIT_DIR/.$MIRROR_UNIT.service.new"
  chmod 644 "$UNIT_DIR/.$MIRROR_UNIT.service.new"
  mv "$UNIT_DIR/.$MIRROR_UNIT.service.new" "$UNIT_DIR/$MIRROR_UNIT.service"
  sed -e "s#^Documentation=.*#Documentation=file://$DIR/deploy/RUNBOOK.md#" \
      "$SRC/deploy/$MIRROR_UNIT.timer" > "$UNIT_DIR/.$MIRROR_UNIT.timer.new"
  chmod 644 "$UNIT_DIR/.$MIRROR_UNIT.timer.new"
  mv "$UNIT_DIR/.$MIRROR_UNIT.timer.new" "$UNIT_DIR/$MIRROR_UNIT.timer"
fi

systemctl daemon-reload
systemctl enable --now "$UNIT"
[ "${WATCH_ENABLE:-1}" = "1" ] && systemctl enable --now "$WATCH.timer"
[ "$MIRROR_ENABLE" = "1" ] && systemctl enable --now "$MIRROR_UNIT.timer"

# --- 10. do not say "up" before it answers ---
"$NODE" -e '
const url = "http://127.0.0.1:" + process.argv[1] + "/api/pulse";
const fail = (m) => { console.error("install: " + m); process.exit(1); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const main = async () => {
  let last = "no connection";
  for (let i = 0; i < 20; i++) {
    let res;
    try { res = await fetch(url); } catch (e) { last = e.message; await wait(500); continue; }
    const body = await res.text();
    if (!res.ok) fail("pulse answered HTTP " + res.status + ": " + body.slice(0, 200));
    let j;
    try { j = JSON.parse(body); } catch { fail("pulse is not JSON: " + body.slice(0, 200)); }
    if (!j.head) fail("pulse has no head field: " + body.slice(0, 200));
    if (j.writes && j.writes !== "ok") fail("server in read-only mode: " + (j.reason ?? "no reason given"));
    console.log("install: pulse OK, head=" + j.head + ", writes=" + (j.writes ?? "?"));
    return;
  }
  fail("server not answering at " + url + " (" + last + ")");
};
main();
' "$PORT" || die "service came up but does not answer: journalctl -u $UNIT -n 50"

echo
echo "install: done. $DIR on port $PORT, as $SVC_USER."
echo "  state:  systemctl status $UNIT"
echo "  logs:   journalctl -u $UNIT -f"
echo "  pulse:  curl -s localhost:$PORT/api/pulse"
echo "  TLS:    cp $DIR/deploy/Caddyfile /etc/caddy/Caddyfile, replace the domain, systemctl reload caddy"
echo "  watchdog: systemctl list-timers $WATCH.timer   journalctl -u $WATCH -n 20"
echo "  backup: run deploy/backup.sh FROM ANOTHER MACHINE (it needs a second disk to mean anything)"
if [ "$MIRROR_ENABLE" = "1" ]; then
  echo "  mirror: systemctl list-timers $MIRROR_UNIT.timer   journalctl -u $MIRROR_UNIT -n 20"
else
  echo "  mirror: OFF. ssh-keygen -t ed25519 -N '' -C exit0-mirror -f $MIRROR_KEY, add the .pub"
  echo "          as a deploy key WITH WRITE ACCESS on $MIRROR_URL, then run this again."
fi
echo "  backup, update, failures: $DIR/deploy/RUNBOOK.md"
