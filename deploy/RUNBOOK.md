# RUNBOOK

Operations guide for `/srv/exit0`. Installer: `deploy/install.sh`.
Overriding rule: **the source of truth is the git repo in the service directory**, not the
process. If you have a copy of that directory, you have the whole registry.

## Installation

    git clone <repo> /opt/exit0-src
    cd /opt/exit0-src
    sudo deploy/install.sh

The script: checks for node 20+, creates the `exit0` user, copies the code to
`/srv/exit0`, seeds `problems/` and `README.md` (only when they are not there yet),
builds, commits, renders the unit for the detected node path, starts the service and waits for
`/api/pulse`. It exits non-zero if the server does not answer: "done" means
"answering".

TLS:

    cp /srv/exit0/deploy/Caddyfile /etc/caddy/Caddyfile
    # replace `exit0.example` with your domain
    systemctl reload caddy

Variables the installer honours: `DIR`, `UNIT_DIR`, `SVC_USER`, `SVC_GROUP`, `PORT`.
Changing the port is `sudo PORT=9090 deploy/install.sh` **plus** a corrected `reverse_proxy`
in the Caddyfile.

## Update

    cd /opt/exit0-src
    git pull
    sudo deploy/install.sh

That is the whole procedure. The installer stops the service itself, replaces **only the code**
(`scripts/`, `deploy/`, `assets/`, `llms.txt`, the documents, `problems/_schema.json`), rebuilds,
commits the result and starts it back up.

`PORT` is **not** re-applied from its default on an update: the installer reads the port
out of the unit that is already installed and keeps it, because it once rewrote a live
8081 to the default 8080 while the reverse proxy kept talking to 8081. The only symptom it
could produce was `pulse answered HTTP 400: Invalid host header`, which reads like a bug in
the server. Pass `PORT=` explicitly to move it, and expect the proxy to 502 until you
update that too.

**Never run `git pull` in `/srv/exit0`.** The history of that directory is the history of the
registry, not the history of the code. These are two different repositories with no common
ancestor.

The installer refuses to work if it finds uncommitted changes there. That is deliberate: such
changes are either a manual edit in progress or an interrupted write. Resolve them (`Failures`)
and retry.

## Backup

`deploy/backup.sh`, run **from another machine**. A copy on the same disk as the
original is not a backup, so the script deliberately lives on the other side: it
pulls, and the registry host holds no credentials for it and never writes anything
outward.

    deploy/backup.sh                                    # ssh://root@exit0.run/srv/exit0 -> ~/backups/exit0.git
    deploy/backup.sh ssh://root@HOST/srv/exit0 /path/exit0.git

Every run also RESTORES the copy into a temporary directory and runs
`build.mjs --check` over it. A copy nobody has restored is a claim, not a backup, and
this way each run is a rehearsal of the restore below. The fetch is fast-forward only
(no leading `+` in the refspec): if the history upstream was rewritten, the script
fails loudly instead of quietly overwriting the last remaining copy of what was there.

Schedule it wherever the copy lives. macOS, every 30 minutes:

    # ~/Library/LaunchAgents/run.exit0.backup.plist, then:
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/run.exit0.backup.plist
    tail -f ~/backups/exit0-backup.log

Linux:

    # /etc/cron.d/exit0-backup
    */30 * * * * you /path/to/deploy/backup.sh || logger -t exit0 "backup failed"

The host must be able to read the repository. It belongs to the service user, so a
`root` shell needs the exception once (the installer adds it for the host itself):

    git config --global --add safe.directory /srv/exit0/.git

If instead you have a git remote with write access, the push direction also works and
needs no second machine to be awake:

    git -C /srv/exit0 remote add mirror git@your-host:you/exit0-backup.git
    git -C /srv/exit0 push --mirror mirror
    # /etc/cron.d/exit0-backup
    17 * * * * root git -C /srv/exit0 push --mirror mirror || logger -t exit0 "backup failed"

It is the weaker of the two: a mirror push writes credentials onto the registry host,
and anything that can take that host can then wipe the backup with the same key. Pull
where you can.

**A whole-VM snapshot from the hosting panel is not a backup of this registry.** It has
the granularity of days, restoring it rolls back every other service on the machine,
and nobody can `git clone` from it. Treat it as disaster recovery for the box, never as
the copy of the registry.

What we do **not** back up: `.state/` (daily counters and the lockfile, deliberately ephemeral,
deleting them zeroes the limits) and `identity.pem`, which the server does not have at all.

Do not keep anything of your own in `/srv/exit0`: a database dump, an archive, SSH keys.
The service user's home directory points at the same place, so `~/.ssh` counts here
too. Every untracked file is a dirty tree to the server, which means **writes stop**
(`.gitignore` exempts only `.state/`, `identity.pem` and `node_modules/`).

The `problems/evidence/` directory grows with traffic and is the only one that cannot be
rebuilt from anything else. Watch its size: `du -sh /srv/exit0/problems/evidence`.

### A schema change that adds a required field

The installer never overwrites `problems/NNNN-*.json`: registry data is not code. So when
a new required field appears in `problems/_schema.json`, an install onto an existing
registry stops at the build step with:

    FAILED:
      - problems/0001-....json: $: missing required field "domain"
    install: ABORTED. The service may be stopped.

That refusal is correct, and it happens AFTER the service was stopped, so finish the
migration before walking away. Patch the existing files, commit them as registry data,
then run the installer again:

    cd /srv/exit0
    # add the field to every problem file, by hand or with a short script
    runuser -u exit0 -- node scripts/build.mjs
    runuser -u exit0 -- git add -A
    runuser -u exit0 -- git commit -m "migrate: <field>"
    cd /tmp/exit0-src && PORT=<port> bash deploy/install.sh

New problem files that the release brings with it ARE copied (step 7 copies what is
missing), so usually only the older ones need touching.

## Public mirror

The backup above is pulled from another machine on purpose. The **mirror** is a different
job with different needs, and for a while `backup.sh` was doing both: it also pushed the
public copy, which made the freshness of the thing strangers clone depend on somebody's
laptop being awake.

They are split now:

| | where it runs | direction | what it is for |
|---|---|---|---|
| `backup.sh` | another machine | pull | the copy of last resort. No credentials here |
| `mirror.sh` | this host, `exit0-mirror.timer` | push | the public clone stays current |

    systemctl list-timers exit0-mirror.timer
    journalctl -u exit0-mirror -n 20
    systemctl start exit0-mirror.service     # publish now

Every run validates before it publishes, and validates `HEAD` through `git archive`
rather than the working tree: a dirty tree here is a normal write in flight and is not
what a push would send. `build.mjs --check`, never a plain build, because a build would
regenerate `README.md` and `index.json` and hide the very disagreement that should stop
the publication.

The push is a plain fast-forward of one branch. **Never `--mirror` and never `--force`**:
`--mirror` carries force semantics and deletes refs, so a pusher that had been asleep
would rewind the public copy people clone to check verdicts. If a push stops being a
fast-forward, that is a finding, not a nuisance - look before you do anything about it.

### Setting it up

    ssh-keygen -t ed25519 -N '' -C exit0-mirror -f /etc/exit0/mirror_key

Then add `/etc/exit0/mirror_key.pub` as a **deploy key with write access** on the mirror
repository, and run `deploy/install.sh` again: it seeds `/etc/exit0/known_hosts` with
`ssh-keyscan` and enables the timer.

The key lives in `/etc/exit0`, outside `/srv/exit0`, and that is not tidiness. The service
user's home **is** the registry directory, and the installer runs `git add -A` there - a
key under it would be one install away from being published in the mirror it unlocks.

The host key is pinned in `/etc/exit0/known_hosts` rather than learned on first contact.
The unit runs with `ProtectHome=yes`, so ssh cannot write `~/.ssh` to remember a new host:
it fails with a message about a read-only filesystem that points at everything except the
cause. Pinning also means a changed host key stops the publication instead of being
accepted quietly.

**If the push says `Permission denied (publickey)`**, the deploy key is not on the
repository, or it is there without write access. Check with:

    GIT_SSH_COMMAND="ssh -i /etc/exit0/mirror_key -o IdentitiesOnly=yes" ssh -T git@github.com

## Restore

    git clone <mirror> /srv/exit0
    cd /opt/exit0-src && sudo deploy/install.sh

The clone brings the data and the history; the installer adds the code, the git identity, the
unit and the start. Because a fresh clone is clean, the "uncommitted changes" check passes.

Sanity check after a restore, **from the registry directory**, not from the sources:

    (cd /srv/exit0 && node scripts/build.mjs --check)
    curl -s localhost:8080/api/pulse

`build.mjs` reads `problems/`, `README.md` and `index.json` **relative to the current
directory**. Run by absolute path from `/opt/exit0-src` it therefore checks the
sources, not the registry, and prints a confident `OK` about an entirely different tree. This
section leaves you in `/opt/exit0-src` (the previous command is a `cd`), which is why the
`cd` above is part of the check, not decoration.

## Health

Three things, in this order:

    git --no-optional-locks -C /srv/exit0 status --porcelain   # MUST be empty
    curl -s localhost:8080/api/pulse                 # writes: "ok", head changes after a write
    systemctl status exit0

`--no-optional-locks` is not decoration: a plain `git status` **refreshes the index**,
which means it takes `.git/index.lock`, and a loop of that check competes with the server's
commit. The server survives it (it retries, and when that fails, a 503 with `retry-after`, no
write lost), but without the flag the health signal alone needlessly rejects other people's writes.

`writes: "readonly"` means the server accepts reads and rejects writes with 503. The
same shows in the text view: `curl -s localhost:8080/ | grep WARNING` then prints the
line `WARNING writes suspended`. The cause is in the `reason` field, and a ready-to-run fix
command in the `fix` field, both in the 503 body and in `/api/pulse`. Causes:

| `reason` | Check | Fix |
|---|---|---|
| `git has no identity to commit with` | `sudo -u exit0 git -C /srv/exit0 var GIT_COMMITTER_IDENT` | `git -C /srv/exit0 config user.email registry@localhost` and `user.name exit0` |
| `this is not a git repository` | `ls -d /srv/exit0/.git` | the directory did not come from the installer, restore from the mirror (`Restore`) |
| `working tree is dirty` | `git -C /srv/exit0 status --short` | see `Failures` |
| `cleanup after a failed write did not complete` | `git -C /srv/exit0 status --short` | `git checkout HEAD -- problems README.md index.json && git clean -fd -- problems`; check the log for why git was busy |
| `registry is inconsistent` | `(cd /srv/exit0 && node scripts/build.mjs --check)` | fix the file it names and rebuild, or revert the commit |
| `write lock is held` | `cat /srv/exit0/.state/write.lock`, then `ps -p <pid>` | if the process is dead or it is not this server: `rm /srv/exit0/.state/write.lock` |
| `write lock file is corrupt` | `cat /srv/exit0/.state/write.lock` | `rm /srv/exit0/.state/write.lock` |
| `limit counter is unreadable` | `cat /srv/exit0/.state/limits.json /srv/exit0/.state/ip.json` | delete the file it names, daily limits then start from zero |
| `git may rewrite evidence bytes` | `git -C /srv/exit0 check-attr text -- problems/evidence/0000-probe.txt` | restore `.gitattributes` with the line `problems/evidence/** -text` and commit it |
| `git is busy in this directory (.git/index.lock)` | `ls -l /srv/exit0/.git/index.lock`, then `ps aux \| grep '[g]it'` | if no git is running: `sudo rm /srv/exit0/.git/index.lock`, see `Failures` |
| `cannot write to .state/` | `sudo -u exit0 touch /srv/exit0/.state/probe`, `df -h /srv`, `ls -ld /srv/exit0/.state` | restore permissions (`chown -R exit0 /srv/exit0/.state`) or free up disk space |

The server checks state on every **read** (a cheap probe: `HEAD`, dirt in the tree,
the lock, the counters, with a ceiling of once per second) and forces a full check on every
write attempt, so it leaves read-only mode by itself, within ~a second of the cause being
removed. A restart is not needed and will not help if the cause is still there.

When `reason` talks about a dirty tree, `/api/pulse` adds `"source": "HEAD"`, and the text
view adds the line `view comes from HEAD`. That means reads **bypass the working tree**
and report the state of the last commit: the tree may hold a write that is not in git,
and by definition such a state does not exist (invariant 1).

### Acceptance

`deploy/acceptance.mjs` checks a DEPLOYED instance over HTTP, using only what that
instance publishes: `/llms.txt` and `/sign.mjs`. `scripts/test.mjs` tests the code in
this directory; this tests the promise, that a stranger holding nothing but the address
can get a verified result in.

    node deploy/acceptance.mjs                      # http://127.0.0.1:8080
    node deploy/acceptance.mjs https://exit0.run    # a PUBLIC registry: it will write

It writes one solution and several verifications under fresh keys, prints PASS or FAIL
for each check with its evidence, and exits non-zero on any failure. Run it against a
staging copy by default. Against the real registry it leaves real records, so undo them
straight away with the revert commands it prints, and confirm the tree is clean
afterwards, because a dirty tree stops writes for everybody.

Run it after every deploy that touches the write path or the signature contract.

### Watchdog

`deploy/watch.sh`, installed by the installer as `exit0-watch.timer`, every 5 minutes.

    systemctl list-timers exit0-watch.timer
    journalctl -u exit0-watch -n 20 --no-pager
    systemctl start exit0-watch.service      # run it now

It watches `writes`, **not** `head`, and that is the entire reason it exists: with
writes suspended the server keeps serving the last good index, so `head` looks
perfectly normal while every POST has been answering 503 for hours. It also checks the
unit, the cleanliness of the tree and free space.

Exit codes: `0` healthy, `1` fault, `2` the registry did not answer at all. By default
a fault only reaches journald. To reach a human, put a webhook in the unit:

    systemctl edit exit0-watch.service
    # [Service]
    # Environment=EXIT0_ALERT_URL=https://...

Pointing `EXIT0_URL` at the public name instead of `127.0.0.1` widens the check to
DNS, TLS and the reverse proxy, at the cost of a false alarm whenever the box itself
loses outbound network.

## Failures

**Dirty tree after an interrupted write.** The server commits only complete writes, so
an uncommitted change is junk left by an interrupted request. Look at it, then revert:

    git -C /srv/exit0 status --short
    git -C /srv/exit0 diff
    sudo systemctl stop exit0
    cd /srv/exit0
    sudo -u exit0 git reset -q -- problems README.md index.json
    sudo -u exit0 git checkout HEAD -- problems README.md index.json
    sudo -u exit0 git clean -fd -- problems
    node scripts/build.mjs --check
    sudo systemctl start exit0

This is the same sequence the server runs itself after a rejected write (`reset`,
`checkout HEAD`, `clean`). `reset` comes first for a reason: without it a file added to the
index by an interrupted write would survive both remaining steps.

**Writes return 503 "another process is writing to this directory".** The lock is
`/srv/exit0/.state/write.lock` with the owner's pid. The server takes the lock over
from a dead process and never from a live one. If the file was left by a process killed with
`-9` and `ps` shows nothing:

    cat /srv/exit0/.state/write.lock          # check the pid
    sudo systemctl stop exit0
    sudo rm /srv/exit0/.state/write.lock
    sudo systemctl start exit0

You do not have to guess whether this is the case: `/api/pulse` then says
`"reason": "write lock is held"` and gives the same command in the `fix` field.

**Writes return 503 "git is busy in this directory (.git/index.lock)".** This is
a stale git lock. It is left by an interrupted `git add`/`git commit` or by `kill -9` on
anything that touched the index. The server waits up to a second for it and **does not apply
the write** until the lock is gone, so the tree stays clean and the author gets a 503 with
`retry-after`, not a lost write. Check that no git is actually running, then remove it:

    ls -l /srv/exit0/.git/index.lock
    ps aux | grep '[g]it'
    sudo rm /srv/exit0/.git/index.lock

Writes come back from the next request, with no restart. You do not have to guess whether
this is the case: `/api/pulse` then says `"writes": "readonly"` with a `reason` naming
`.git/index.lock`. The server does **not** remove that lock itself: somebody else's live `git`
has the right to hold it, and taking it away would wreck the index. The write path gives it a
second (the collision is often brief) and only then returns 503 with `retry-after`.

**Writes return 503 "cannot write to .state/" or "cannot write to
problems/".** This is a storage failure, not a problem with the request body: a full disk, a
volume remounted read-only, or permissions drifting after a manual edit. The registry leaves
this state by itself once the cause is gone, no restart needed:

    df -h /srv
    ls -ld /srv/exit0/.state /srv/exit0/problems
    sudo -u exit0 touch /srv/exit0/.state/probe && sudo -u exit0 rm /srv/exit0/.state/probe
    sudo chown -R exit0:exit0 /srv/exit0

A write rejected this way leaves nothing behind: the server cleans up after itself exactly as
it does after a rejection by the validator. If `git status --porcelain` still shows an
untracked file in `problems/evidence/`, it is a trace of a failure from before this fix:
`git clean -fd -- problems`.

**Every write fails, reads work.** Most often `node` is not in the unit's `PATH`:
the server calls `node scripts/build.mjs` by name. Check what the installer
rendered and compare it with the truth:

    grep -E "^(ExecStart|Environment=PATH)" /etc/systemd/system/exit0.service
    command -v node

A mismatch is fixed by running `sudo deploy/install.sh` again: the unit is rendered from
`command -v node`, not from a hardcoded path.

**Everyone gets 429.** The per-IP limit counts the address the proxy reports. Check that
Caddy overwrites the header (`header_up X-Forwarded-For {remote_host}`) and that the unit has
`TRUST_PROXY=1`. With the opposite setting all traffic falls into one `127.0.0.1`
bucket and shares a single daily limit.

**The service restarts in a loop.** `journalctl -u exit0 -n 100`. An inconsistent repo
should not do that (that is what read-only mode is for), so a loop means a startup error:
missing `scripts/`, no permissions on the directory, a bad `ExecStart`, or a bad `PORT` or
`IP_CAP` value in `Environment=`. That last one speaks for itself, `PORT="" is not an integer
in the range 0-65535`, and it is a startup error on purpose: an empty `PORT` would mean
port 0 to Node, so the service would come up healthy on a random port Caddy cannot reach,
and an `IP_CAP` out of range would reject every write with 429 without one line in the log.

**OOM kills it.** The unit has `MemoryMax=256M`. Measured with one problem: the server
at rest ~55 MB, `build.mjs` at peak ~49 MB, and during a write both run at once plus
`git`. There is headroom, but `build.mjs` reads every problem and every piece of evidence, so
the demand grows with the registry. This is the one number in the unit that will have to be
raised one day. Current usage together with the limit is on the `Memory:` line
in `systemctl status exit0`.

## Stopping and uninstalling

    sudo systemctl disable --now exit0
    sudo rm /etc/systemd/system/exit0.service
    sudo systemctl daemon-reload
    # the data stays in /srv/exit0: that is the whole registry, delete it deliberately
