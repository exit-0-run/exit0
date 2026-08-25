#!/bin/sh
# Push the registry to its PUBLIC mirror, from the registry host itself.
#
# Why this exists separately from backup.sh: those are two different jobs that were
# doing each other's work. backup.sh is a BACKUP - pulled from another machine, so
# the server holds no credential and a compromised server cannot reach the copy.
# That property is worth keeping. But it was also pushing the public mirror, which
# made the freshness of the public copy depend on someone's laptop being awake.
#
# So the jobs split along what each one actually needs:
#   backup.sh  (elsewhere)  pull, no credentials here, the copy of last resort
#   mirror.sh  (here)       push, holds a key, keeps the public clone current
#
# The key this uses can fast-forward exactly one GitHub repository and nothing else.
# An attacker who owns this host already owns the registry, so the key adds close to
# nothing to what they could do - and the backup, being a pull, stays out of reach.
#
#   deploy/mirror.sh                       # uses the defaults below
#   EXIT0_MIRROR=off deploy/mirror.sh      # disabled, exits 0
set -eu

DIR=${EXIT0_DIR:-/srv/exit0}
MIRROR=${EXIT0_MIRROR:-git@github.com:exit-0-run/exit0.git}
KEY=${EXIT0_MIRROR_KEY:-/etc/exit0/mirror_key}
STATE=${EXIT0_MIRROR_STATE:-/var/lib/exit0/mirrored}
KNOWN=${EXIT0_MIRROR_KNOWN_HOSTS:-/etc/exit0/known_hosts}

say() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
die() { say "FAILED: $*"; exit 1; }

[ "$MIRROR" = "off" ] && { say "mirror disabled"; exit 0; }

command -v git  >/dev/null || die "no git in PATH"
command -v node >/dev/null || die "no node in PATH, nothing could be validated before publishing"
[ -d "$DIR/.git" ] || die "$DIR is not a git repository"
[ -r "$KEY" ] || die "no readable key at $KEY. Create it with: ssh-keygen -t ed25519 -N '' -C exit0-mirror -f $KEY, then add the .pub as a deploy key WITH WRITE ACCESS on the mirror"
# The host key is pinned in a file, not learned on first contact. Two reasons, and the
# second one is the reason: ssh wants to write $HOME/.ssh to remember a new host, and
# this unit runs with ProtectHome, so learning it here fails with a message about a
# read-only filesystem that says nothing about what is actually wrong. Pinning also
# means a changed host key stops the publication instead of being accepted quietly.
[ -r "$KNOWN" ] || die "no known_hosts at $KNOWN. Seed it: ssh-keyscan -t ed25519 <host> > $KNOWN (deploy/install.sh does this)"

# The repository belongs to the service user and this runs as root. Without saying so
# out loud, git refuses with "dubious ownership" - and the last time that happened the
# caller read the refusal as a finding about the registry instead of about itself.
GIT="git -c safe.directory=$DIR -C $DIR"
HEAD_SHA=$($GIT rev-parse HEAD) || die "cannot read the git state of $DIR (this is about permissions here, not about the registry)"
BRANCH=$($GIT symbolic-ref --quiet --short HEAD) || die "detached HEAD in $DIR, refusing to guess a branch"

# Nothing new is not an event. Without this the timer would republish the same commit
# every few minutes and the log would say "pushed" often enough to stop meaning it.
if [ -r "$STATE" ] && [ "$(cat "$STATE")" = "$HEAD_SHA" ]; then
  say "nothing to publish, head=$HEAD_SHA"
  exit 0
fi

# Validate BEFORE publishing, and validate what would actually be published: HEAD, via
# archive, not the working tree. A dirty tree here is normal (a write in flight), and
# it is not what git push would send.
TMP=$(mktemp -d "${TMPDIR:-/tmp}/exit0-mirror.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM

SSH="ssh -i $KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$KNOWN -o StrictHostKeyChecking=yes -o BatchMode=yes"

# A function, because the reconcile path below has to validate again. A second push that
# skipped this would publish exactly the state the first push was right to hold back.
validate_head() {
  rm -rf "$TMP/w"
  mkdir -p "$TMP/w"
  $GIT archive HEAD | tar -x -C "$TMP/w" || die "cannot unpack HEAD"
  [ -f "$TMP/w/scripts/build.mjs" ] || die "HEAD has no scripts/build.mjs"
  # --check, never a plain build: it must agree that README and index.json at HEAD already
  # match the records. A build would regenerate them and hide exactly the disagreement
  # that should stop the publication.
  ( cd "$TMP/w" && node scripts/build.mjs --check ) >/dev/null 2>"$TMP/.err" \
    || die "HEAD does not validate, NOT publishing: $(head -3 "$TMP/.err" | tr '\n' ' ')"
}

# Push by URL rather than through a named remote: no remote-tracking ref is written, so
# this touches nothing inside a repository it does not own.
# No --force and no --mirror. --mirror carries force semantics and can delete refs, and
# a stale pusher would then silently rewind the public copy that people clone to check
# verdicts.
# refs/attempts/* goes WITH main, and this is not optional decoration. Phase 3 lets a
# stranger push an attempt into the registry's own repository, and the solution record then
# names the MIRROR as its repo. Push only main and the ref exists on this host and nowhere
# a verifier can reach it: the documented `git fetch <repo> <ref>` returns "ref not found"
# and the entry is unverifiable. Shipped that way for one afternoon; caught by checking
# where the refs actually were rather than where the code said they went.
#
# Still no --force and no --mirror: --mirror carries force semantics and can DELETE refs on
# the far side, which would let a stale pusher wipe attempts other people have verified.
# The refspec is explicit and additive, so a ref can be created and advanced and never
# removed from here. Fast-forward is the far side's rule and ours: without a leading +,
# git refuses a non-fast-forward attempt ref exactly as the write path does.
#
# The clone stays small regardless: a normal `git clone` fetches refs/heads and refs/tags,
# never refs/attempts/*, which is the measured reason invariant 14 chose that namespace.
push_head() {
  GIT_SSH_COMMAND="$SSH" $GIT push --quiet "$MIRROR" \
    "HEAD:refs/heads/$BRANCH" "refs/attempts/*:refs/attempts/*" 2>"$TMP/.push"
}

validate_head

if push_head; then
  mkdir -p "$(dirname "$STATE")"
  printf '%s\n' "$($GIT rev-parse HEAD)" > "$STATE"
  say "published $BRANCH $HEAD_SHA -> $MIRROR"
  exit 0
fi

# A rejected push has two causes that must not be treated alike. No write access is a
# fact about credentials and retrying cannot fix it. A non-fast-forward is the expected
# consequence of ONE branch with TWO writers: code is pushed from a laptop, registry data
# is committed here, and both land on the same branch since the two repositories were
# merged into one. Neither side is wrong and neither may be dropped.
if ! grep -qi 'non-fast-forward\|fetch first\|behind\|rejected.*fetch' "$TMP/.push"; then
  die "push rejected: $(head -3 "$TMP/.push" | tr '\n' ' ')"
fi

# Only ever from a clean tree. A dirty tree means a write is in flight, and merging under
# one would fold a half-written record into the history. Ten minutes from now it is clean.
#
# --no-optional-locks goes BEFORE the subcommand: it is a git-level option, and
# `git status --no-optional-locks` is rejected outright. It sat after `status` here, and a
# guard built out of a command that errors FAILS OPEN - the substitution returns the empty
# string, `[ -z "" ]` is true, and the guard waved every dirty tree through while reading
# like it was protecting one. The rest of the repo already had this right
# (server.mjs gitRead, build.mjs gitRead); this line was the outlier.
[ -z "$($GIT --no-optional-locks status --porcelain)" ] \
  || { say "diverged from $MIRROR but the tree is dirty (write in flight). Leaving it; the next run retries."; exit 0; }

say "diverged from the public copy, merging it in"
GIT_SSH_COMMAND="$SSH" $GIT fetch --quiet "$MIRROR" "$BRANCH" 2>"$TMP/.fetch" \
  || die "diverged, and cannot fetch to reconcile: $(head -3 "$TMP/.fetch" | tr '\n' ' ')"

# MERGE, never rebase and never force. Every accepted write is a commit and the history IS
# the audit trail, so rewriting these commits would rewrite the evidence. A merge only adds.
# There is no --no-rebase here and there must not be: that is a `git pull` flag, `git merge`
# rejects it outright ("unknown option"). It sat here and made this whole branch dead code -
# the ONE path that exists to handle two writers diverging could not run at all, and it
# failed with "cannot merge automatically", which reads like a conflict and is not one.
# git merge does not rebase, so the guarantee needs no flag.
if ! $GIT merge --no-edit FETCH_HEAD >"$TMP/.merge" 2>&1; then
  $GIT merge --abort >/dev/null 2>&1
  die "cannot merge the public copy automatically, registry left untouched: $(head -3 "$TMP/.merge" | tr '\n' ' ')"
fi

# The merged state is a state nobody has validated yet: it is the first time these two
# sets of commits have existed in one tree.
validate_head

push_head || die "push still rejected after merging: $(head -3 "$TMP/.push" | tr '\n' ' ')"
mkdir -p "$(dirname "$STATE")"
printf '%s\n' "$($GIT rev-parse HEAD)" > "$STATE"
say "merged and published $BRANCH $($GIT rev-parse HEAD) -> $MIRROR"
