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
# The SECOND repository, the one that holds pushed code. It is separate state and it is not
# reachable from the registry's history at all, so a backup of the registry alone silently
# loses every attempt: the records would survive naming branches that exist nowhere, which
# is precisely the "points at nothing" failure hosting the code was meant to end. There is
# nothing to validate in it (it holds no records, so build.mjs has no opinion) - what is
# checked is that the branches arrived and that they carry a tree.
ATT_SRC=${EXIT0_ATTEMPTS_SRC:-$SRC-attempts.git}
ATT_DST=${EXIT0_ATTEMPTS_BACKUP:-${DST%.git}-attempts.git}
# Optional public mirror, OFF by default. The registry host publishes its own mirror
# now (deploy/mirror.sh on a timer there), and two pushers is not redundancy: this one
# pushes --mirror, which carries force semantics, so a run from a machine that has been
# asleep would rewind the public copy people clone to check verdicts. Set it to a URL
# only if nothing on the host is publishing.
MIRROR=${EXIT0_MIRROR:-off}
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

# The attempts repository. Fast-forward only for the same reason as above: a rewritten
# history upstream has to stop this script loudly instead of overwriting the only remaining
# copy of what was there before. An instance that has taken no pushes yet has no such
# repository, and that is not a failure.
if [ -d "$ATT_DST" ]; then
  say "fetch $ATT_SRC -> $ATT_DST"
  git -C "$ATT_DST" fetch --no-tags --quiet origin "refs/heads/*:refs/heads/*" \
    || die "attempts fetch rejected. Fast-forward only: either a branch was rewritten upstream, or this copy is ahead. Do NOT force it: git -C $ATT_DST for-each-ref"
elif git ls-remote --exit-code "$ATT_SRC" >/dev/null 2>&1; then
  say "first run: mirror $ATT_SRC -> $ATT_DST"
  mkdir -p "$(dirname "$ATT_DST")"
  git clone --quiet --mirror "$ATT_SRC" "$ATT_DST" || die "attempts clone failed"
else
  say "no attempts repository at $ATT_SRC (nothing has been pushed there yet)"
fi

if [ -d "$ATT_DST" ]; then
  # A branch count is not proof the copy is usable. Every branch has to resolve to a tree,
  # or what came across is a set of names pointing at objects that did not.
  BRANCHES=$(git -C "$ATT_DST" for-each-ref --format='%(refname)' refs/heads/ | wc -l | tr -d ' ')
  BROKEN=0
  for r in $(git -C "$ATT_DST" for-each-ref --format='%(refname)' refs/heads/); do
    git -C "$ATT_DST" ls-tree --name-only "$r" >/dev/null 2>&1 || { say "WARNING $r does not resolve to a tree"; BROKEN=$((BROKEN + 1)); }
  done
  [ "$BROKEN" = "0" ] || die "$BROKEN of $BRANCHES attempt branches did not come across whole"
  say "OK  attempts=$BRANCHES  ->  $ATT_DST"
fi

# The public mirror is what makes the registry's own promise true: the evidence bytes
# behind every `verified` are not served over HTTP at all, so without somewhere to
# clone from, nobody outside this machine can check a verdict. Normally that is the
# host's job; this stays here as the fallback for when it is not.
if [ "$MIRROR" != "off" ] && [ -n "$MIRROR" ]; then
  if git -C "$DST" push --mirror "$MIRROR" >/dev/null 2>&1; then
    say "mirror pushed -> $MIRROR"
  else
    # Not fatal: the backup itself succeeded, and that is the part that cannot wait.
    say "WARNING mirror push failed -> $MIRROR (backup itself is fine). Check the key: ssh -T git@github.com"
  fi
fi
