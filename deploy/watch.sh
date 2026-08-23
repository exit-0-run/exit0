#!/bin/sh
# Watchdog. Answers one question: can the registry still take a write RIGHT NOW.
#
#   deploy/watch.sh                       # checks https://exit0.run and, if present, /srv/exit0
#   EXIT0_URL=http://127.0.0.1:8081 deploy/watch.sh
#   EXIT0_ALERT_URL=https://... deploy/watch.sh     # POSTs {"text": "..."} on a fault
#
# `head` is NOT enough to watch and this is the whole reason the script exists: with
# writes suspended the server keeps serving the last good index, so `head` looks
# perfectly normal while every POST has been answering 503 for hours. The field that
# tells the truth is writes.
#
# Exit codes: 0 healthy, 1 fault (loud), 2 cannot reach the registry at all.
set -eu

URL=${EXIT0_URL:-https://exit0.run}
DIR=${EXIT0_DIR:-/srv/exit0}
UNIT=${EXIT0_UNIT:-exit0.service}
say() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

FAULTS=""
add() { FAULTS="${FAULTS}${FAULTS:+; }$1"; }

PULSE=$(curl -fsS --max-time 10 "$URL/api/pulse" 2>/dev/null) || {
  say "UNREACHABLE $URL/api/pulse"
  [ -n "${EXIT0_ALERT_URL:-}" ] && curl -fsS --max-time 10 -X POST -H 'content-type: application/json' \
    --data "{\"text\":\"exit0 UNREACHABLE: $URL\"}" "$EXIT0_ALERT_URL" >/dev/null 2>&1
  exit 2
}

# No jq on a fresh box, so this reads the field the plain way. `writes` takes one of
# two values, both fixed by the server, so a substring match is exact enough here.
case "$PULSE" in
  *'"writes": "ok"'*|*'"writes":"ok"'*) : ;;
  *) add "writes suspended: $(printf '%s' "$PULSE" | tr -d '\n' | cut -c1-300)" ;;
esac

# Local checks only where the registry actually lives. Elsewhere the HTTP answer is
# everything we can honestly say.
if [ -d "$DIR/.git" ]; then
  command -v systemctl >/dev/null && ! systemctl is-active --quiet "$UNIT" && add "$UNIT is not active"
  DIRTY=$(git --no-optional-locks -C "$DIR" status --porcelain -- problems README.md index.json 2>/dev/null || echo "?")
  [ -n "$DIRTY" ] && add "uncommitted state in the tree: $(printf '%s' "$DIRTY" | tr '\n' ' ' | cut -c1-200)"
  FREE=$(df -Pk "$DIR" | awk 'NR==2 {print int($4/1024)}')
  [ "$FREE" -lt 512 ] && add "less than 512 MB free on the registry filesystem (${FREE} MB)"
fi

if [ -n "$FAULTS" ]; then
  say "FAULT $FAULTS"
  [ -n "${EXIT0_ALERT_URL:-}" ] && curl -fsS --max-time 10 -X POST -H 'content-type: application/json' \
    --data "$(printf '{"text":"exit0 FAULT: %s"}' "$(printf '%s' "$FAULTS" | tr '"' "'" | tr -d '\n')")" \
    "$EXIT0_ALERT_URL" >/dev/null 2>&1
  exit 1
fi

say "OK writes=ok $URL"
