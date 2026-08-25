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
# The SECOND repository: the one that holds pushed code. It is separate on purpose, so the
# registry clone carries no attempts at all, and it is published separately for the same
# reason. Its default is the sibling of $DIR that server.mjs computes when ATTEMPTS_DIR is
# unset, so the two agree without either of them being told.
ATT_DIR=${EXIT0_ATTEMPTS_DIR:-$DIR-attempts.git}
ATT_MIRROR=${EXIT0_ATTEMPTS_MIRROR:-git@github.com:exit-0-run/attempts.git}
ATT_STATE=${EXIT0_ATTEMPTS_STATE:-/var/lib/exit0/mirrored-attempts}
# Its OWN key, defaulting to the registry's. GitHub refuses to register one deploy key on
# two repositories - the second add fails with "key is already in use" - so publishing two
# repositories needs two keys. The default keeps a single-repository or self-hosted setup
# working with no extra configuration, and the failure when it is wrong is loud: the push
# is denied rather than silently landing somewhere else.
ATT_KEY=${EXIT0_ATTEMPTS_KEY:-$KEY}

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
# An unchanged registry head does NOT mean an unchanged set of attempts: a push through
# POST /api/attempt updates a ref in the other repository and adds no commit here (that is
# invariant 14's noCommit, and it is deliberate). Returning early on the head alone would
# leave every attempt unpublished until the next record happened to land, which is exactly
# how "the ref exists here and nowhere a verifier can reach" happened the first time.
if [ -r "$STATE" ] && [ "$(cat "$STATE")" = "$HEAD_SHA" ]; then
  say "nothing new in the registry, head=$HEAD_SHA"
  SKIP_HEAD=1
else
  SKIP_HEAD=0
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
# refs/attempts/* is HISTORY and is still pushed. Nothing writes there any more - attempts
# live in their own repository now - but two solution records signed before the move name
# refs under it, and their documented `git fetch <repo> <ref>` has to keep working forever.
# The refspec is additive, so it republishes what exists and creates nothing.
#
# No --force and no --mirror: --mirror carries force semantics and can DELETE refs on the
# far side, which would let a stale pusher wipe history other people have verified against.
# Fast-forward is the far side's rule and ours: without a leading +, git refuses a
# non-fast-forward exactly as the write path does.
push_head() {
  GIT_SSH_COMMAND="$SSH" $GIT push --quiet "$MIRROR" \
    "HEAD:refs/heads/$BRANCH" "refs/attempts/*:refs/attempts/*" 2>"$TMP/.push"
}

# The attempts repository publishes on completely different terms, and conflating the two
# is what the first version got wrong. There is nothing to validate here: it holds no
# records, no README and no index, only branches of somebody else's code, so build.mjs has
# no opinion about it and running --check would be theatre. What IS enforced is the same
# thing the write path enforces - additive, fast-forward, never forced - and a divergence
# is NOT reconciled by merging: this host is the only writer, so a rejected push means
# somebody wrote to the far side directly, and merging branches of unrelated attempts would
# be an invention rather than a repair. It fails loudly instead.
publish_attempts() {
  [ -d "$ATT_DIR" ] || { say "no attempts repository at $ATT_DIR yet, nothing pushed here so far"; return 0; }
  ATT="git -c safe.directory=$ATT_DIR --git-dir=$ATT_DIR"
  # A digest of every branch and where it points, so an unchanged set is not an event. The
  # registry compares one HEAD; here there is no single head to compare, and re-pushing the
  # same branches every ten minutes would make "published" stop meaning anything.
  NOW=$($ATT for-each-ref --format='%(refname) %(objectname)' refs/heads/ | git hash-object --stdin) \
    || die "cannot read the git state of $ATT_DIR (permissions here, not the registry)"
  if [ -r "$ATT_STATE" ] && [ "$(cat "$ATT_STATE")" = "$NOW" ]; then
    say "attempts unchanged"
    return 0
  fi
  if [ -z "$($ATT for-each-ref refs/heads/)" ]; then
    say "attempts repository is empty, nothing to publish"
    return 0
  fi
  [ -r "$ATT_KEY" ] || die "no readable key at $ATT_KEY for $ATT_MIRROR. A GitHub deploy key works on ONE repository, so this needs its own: ssh-keygen -t ed25519 -N '' -C exit0-attempts -f $ATT_KEY, then add the .pub WITH WRITE ACCESS there"
  ATT_SSH="ssh -i $ATT_KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$KNOWN -o StrictHostKeyChecking=yes -o BatchMode=yes"
  if GIT_SSH_COMMAND="$ATT_SSH" $ATT push --quiet "$ATT_MIRROR" "refs/heads/*:refs/heads/*" 2>"$TMP/.att"; then
    mkdir -p "$(dirname "$ATT_STATE")"
    printf '%s\n' "$NOW" > "$ATT_STATE"
    say "published attempts -> $ATT_MIRROR"
    return 0
  fi
  die "attempts push rejected. This host is the only writer, so this is not the two-writer case main has: $(head -3 "$TMP/.att" | tr '\n' ' ')"
}

if [ "$SKIP_HEAD" = "1" ]; then
  publish_attempts
  exit 0
fi

validate_head

if push_head; then
  mkdir -p "$(dirname "$STATE")"
  printf '%s\n' "$($GIT rev-parse HEAD)" > "$STATE"
  say "published $BRANCH $HEAD_SHA -> $MIRROR"
  publish_attempts
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
publish_attempts
