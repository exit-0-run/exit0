#!/bin/sh
# A VERIFIED backup of the registry. Copying is the easy half: a copy nobody has
# restored is a claim, not a backup, so every run also restores the copy into a
# temporary directory and runs the validator over it. What that proves is exactly
# invariant 1: a clone without the server is enough to recompute the whole state.
#
#   deploy/backup.sh                                  # defaults below
#   deploy/backup.sh ssh://root@exit0.run/srv/exit0 ~/backups/exit0.git
#
# Run it from a machine that is NOT the registry host: the point is a second disk.
# It needs no credentials on the server side and writes nothing there.
#
# The fetch is deliberately WITHOUT a leading "+", so it is fast-forward only. A
# rewritten history upstream fails this script loudly instead of quietly copying
# the rewrite over the only remaining copy of what was there before.
set -eu

SRC=${1:-${EXIT0_SRC:-ssh://root@exit0.run/srv/exit0}}
DST=${2:-${EXIT0_BACKUP:-$HOME/backups/exit0.git}}
# Optional public mirror. Pushed only AFTER the copy has been restored and validated
# below, so a broken registry never gets republished as the thing to clone.
MIRROR=${EXIT0_MIRROR:-git@github.com:exit-0-run/exit0-registry.git}
say() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
die() { say "FAILED: $*"; exit 1; }

command -v git >/dev/null || die "no git in PATH"
command -v node >/dev/null || die "no node in PATH, the copy cannot be verified"

# Every branch, never a hardcoded name: the deployed registry sits on `master` and
# the working repo on `main`, and a backup that breaks over a branch name is not one.
if [ -d "$DST" ]; then
  say "fetch $SRC -> $DST"
  git -C "$DST" fetch --no-tags --quiet origin "refs/heads/*:refs/heads/*" \
    || die "fetch rejected. Fast-forward only: either the history upstream was rewritten, or this copy is ahead. Do NOT force it, look first: git -C $DST log --oneline -5"
else
  say "first run: mirror $SRC -> $DST"
  mkdir -p "$(dirname "$DST")"
  git clone --quiet --mirror "$SRC" "$DST" || die "clone failed"
fi

BRANCH=$(git -C "$DST" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "?")
HEAD_SHA=$(git -C "$DST" rev-parse HEAD)
COMMITS=$(git -C "$DST" rev-list --count HEAD)

# Restore, then validate. `git archive` instead of a worktree: it touches nothing
# in the mirror, so a failure here cannot leave the backup itself in a broken state.
TMP=$(mktemp -d "${TMPDIR:-/tmp}/exit0-restore.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM
git -C "$DST" archive HEAD | tar -x -C "$TMP" || die "cannot restore the copy"
[ -f "$TMP/scripts/build.mjs" ] || die "the restored copy has no scripts/build.mjs"

# --check, not a plain build: it has to agree that README and index.json in the
# copy already match the records. Regenerating them would hide the disagreement.
( cd "$TMP" && node scripts/build.mjs --check ) >/dev/null 2>"$TMP/.err" \
  || die "the copy does not validate: $(head -3 "$TMP/.err" | tr '\n' ' ')"

PROBLEMS=$(ls "$TMP/problems"/[0-9]*.json 2>/dev/null | wc -l | tr -d ' ')
EVIDENCE=$(ls "$TMP/problems/evidence" 2>/dev/null | wc -l | tr -d ' ')
say "OK  branch=$BRANCH  head=$HEAD_SHA  commits=$COMMITS  problems=$PROBLEMS  evidence=$EVIDENCE  ->  $DST"

# The public mirror is what makes the registry's own promise true: the evidence bytes
# behind every `verified` are not served over HTTP at all, so without somewhere to
# clone from, nobody outside this machine can check a verdict. Set EXIT0_MIRROR=off to
# skip it.
if [ "$MIRROR" != "off" ] && [ -n "$MIRROR" ]; then
  if git -C "$DST" push --mirror "$MIRROR" >/dev/null 2>&1; then
    say "mirror pushed -> $MIRROR"
  else
    # Not fatal: the backup itself succeeded, and that is the part that cannot wait.
    say "WARNING mirror push failed -> $MIRROR (backup itself is fine). Check the key: ssh -T git@github.com"
  fi
fi
