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
MIRROR=${EXIT0_MIRROR:-git@github.com:exit-0-run/exit0-registry.git}
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
$GIT archive HEAD | tar -x -C "$TMP" || die "cannot unpack HEAD"
[ -f "$TMP/scripts/build.mjs" ] || die "HEAD has no scripts/build.mjs"

# --check, never a plain build: it must agree that README and index.json at HEAD already
# match the records. A build would regenerate them and hide exactly the disagreement
# that should stop the publication.
( cd "$TMP" && node scripts/build.mjs --check ) >/dev/null 2>"$TMP/.err" \
  || die "HEAD does not validate, NOT publishing: $(head -3 "$TMP/.err" | tr '\n' ' ')"

# Push by URL rather than through a named remote: no remote-tracking ref is written, so
# this touches nothing inside a repository it does not own.
# No --force and no --mirror. --mirror carries force semantics and can delete refs, and
# a stale pusher would then silently rewind the public copy that people clone to check
# verdicts. If this ever stops being a fast-forward, that is a finding, not a nuisance.
if GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes" \
   $GIT push --quiet "$MIRROR" "HEAD:refs/heads/$BRANCH" 2>"$TMP/.push"; then
  mkdir -p "$(dirname "$STATE")"
  printf '%s\n' "$HEAD_SHA" > "$STATE"
  say "published $BRANCH $HEAD_SHA -> $MIRROR"
else
  die "push rejected: $(head -3 "$TMP/.push" | tr '\n' ' ')"
fi
