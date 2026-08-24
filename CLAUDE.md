# CLAUDE.md

A registry of engineering problems. Zero dependencies: Node 20+ and `git` in PATH. There is no `package.json` and do not add one without a reason; having no dependencies is a feature of this project, not an oversight.

## Commands

    node scripts/build.mjs             # validates problems/*.json, rewrites README.md and index.json
    node scripts/build.mjs --check     # the same, but without writing: fails when something is stale
    node scripts/test.mjs              # the whole test suite; no flags, no runner, no dependencies
    node scripts/server.mjs            # server on 127.0.0.1:8080 (PORT, HOST)
    node scripts/sign.mjs keygen [file.pem]                          # new identity; does not overwrite without --force
    node scripts/sign.mjs whoami [file.pem]                          # fingerprint and public key
    node scripts/sign.mjs sign <key.pem> <action> <json|@file|->     # signs a request body and prints it ready to send

You change `server.mjs`, `build.mjs` or `sign.mjs`, you run `node scripts/test.mjs`. The suite copies the repo into a temporary directory and starts the server on an ephemeral port, so it touches neither your working directory nor its git.

## Layout

    problems/NNNN-slug.json   one problem = one file; the source of truth
    problems/_schema.json     the contract for those files; loaded by build.mjs
    problems/evidence/        raw verification outputs, addressed by sha256
    scripts/sign.mjs          the signature contract: payload, canonical form, identity, identifiers
    scripts/build.mjs         validator plus generator of README.md and index.json
    scripts/server.mjs        HTTP; accepts signed writes and commits them
    scripts/test.mjs          test suite (node:test, zero dependencies)
    .gitattributes            turns off line ending conversion; code, not preference (see invariant 9)
    llms.txt                  the door for agents; NORMATIVE description of the signature grammar
    AGENTS.md                 a pointer to llms.txt (at /AGENTS.md the server returns the bytes of llms.txt)
    DESIGN.md                 why the interface looks the way it does
    deploy/                   systemd, Caddy, install.sh, RUNBOOK.md

## The two drawers, and why the index is capped

Every problem carries a `domain` (one value) and `needs` (what a stranger must have to run
`acceptance.how`). Both are **closed sets**, declared once in `sign.mjs` as `DOMAINS` and
`NEEDS`, mirrored into `problems/_schema.json` and `llms.txt`, and the test suite fails if the
three ever disagree. Closed, because free tags rot in one predictable way: `llm`, `LLMs` and
`language-model` become three drawers for one thing and no filter ever sees all three. A new
value arrives by pull request, the same way a schema change does.

Both are part of `payload("problem", …)`, so they are signed: a drawer is a claim about the
problem, and the registry does not carry unsigned claims. `needs` has to arrive in the order
`NEEDS` declares, with no repeats, otherwise `400` with the canonical form. Sorting it for the
sender would mean two different bodies produce one signature, and then the stored bytes are not
the bytes that were signed.

The listing is **filtered, capped and ordered**, because a flat view is fine at ten problems and
useless at a thousand:
- `GET /` is a constant size no matter how big the registry gets. It carries the drawer counts
  and one line per problem. It does **not** carry the problem body or the command.
- `GET /<id>` carries one problem in full, including `how`. That is the split: the front door
  costs the same forever, the detail is one request away.
- `GET /api/problems` is the same listing as JSON, with `?status=`, `?domain=`, `?have=`,
  `?limit=`, `?offset=`. `have` is what the CALLER has, and a problem matches when everything it
  needs is on that list, because "what can I run" is the question an agent actually asks.
- `GET /api/index.json` is still everything. It is the right thing to mirror and the wrong thing
  to poll, and `llms.txt` says so.

Order: open first, then the problems nobody has touched, then by id. It is deterministic to the
last element, or paging would silently drop entries. **A cut list always says it was cut** (the
text view prints the range, `/api/problems` carries `total` and `more`, README prints
"Showing N of M"). A truncated list that looks complete is a lie about the state of the registry.

## Invariants

Break them only deliberately: the whole construction stands on them.

1. **The source of truth is git, not the server.** Every accepted write is a commit. The server has no database and cannot be given one. State that is not in `problems/*.json` does not exist. That covers the evidence too: the raw verification output sits in `problems/evidence/` and enters the same commit as the flag it justifies. A clone without the server is enough to recompute everything from scratch.
2. **A write passes through `build.mjs` before the commit.** The validator rejected it, so the server returns to the state from `HEAD` (`reset`, `checkout HEAD`, `clean` over `problems/`) and leaves no garbage in tracked files or in untracked ones. Do not bypass this path. The same rule binds `plan.apply()`, not only `commit()`: an I/O error halfway through a write (full disk, RO mount, permission drift) left untracked evidence in `problems/evidence/` and locked the whole registry into read only mode. Every path that touches the disk before the commit cleans up after itself with `rollback()`.
3. **Nobody verifies themselves.** Checked in two places: in the server and in the validator. Leave both. The comparison goes through `keyId()`, never through the key string nor through the fingerprint: base64 of 32 bytes has four valid spellings of the same bytes, so comparing strings lets self-verification through. `checkVerification` must never throw, because it runs inside `build.mjs` where an exception is a crash instead of an error list, and it must never fall back to comparing strings when `keyId()` throws: a key it cannot read is a named `400`. The old fallback was safe only as long as the server rejected a non-canonical key first, which put invariant 3 on someone else's gate.
4. **`author` is derived from the key, never from the request body.** `fingerprint(key)`. An `author` field sent by the client is ignored.
5. **The signature covers the content, and the state it replaces.** `payload()` in `sign.mjs` is the only contract: every signature check in the repo is `check(key, sig, payload(action, fields))` and nothing beyond that, no helper assembles a payload its own way. The server writes exactly the bytes it verified, because it rejects non-canonical content instead of fixing it. Changing `PREFIX` invalidates every existing signature, which is why it is versioned (`exit0/v2`). `payload("solution", …)` carries a `replaces` token: the sid of the entry the submission replaces, or `-`. Without it a signed request body is valid forever, and `key` and `sig` are public in git, meaning any reader rolls the author back to an older result with the author's own signature. The server checks `replaces` before the limit (409), and `build.mjs` reconstructs it from the **state saved in the record**. `payload("verification", …)` carries two more: the `tolerance` of the problem, so a verdict cannot be reinterpreted under a band moved after the fact, and its own `replaces`, against the verifier's own previous verdict. The same token goes into `solutionId`, so `sid` is a link in a chain, not the address of the content: without that the sequence `0.42 → 0.39 → 0.42` came back to `sid₁` and revived every historical body pointing at that state (the protection held one step deep only). The order of the two refusals in `solution()` is part of the rule: equality of `sid` (that is, "this body is already here", typically a replay after a dropped connection) is checked **before** `replaces`, because a body that landed describes the previous state.
6. **Request content never reaches a shell.** `execFileSync` with an array of arguments, never interpolation into `sh`.
7. **Derived fields are computed by `build.mjs` alone.** `verified`, `disputed`, `settled`, `verified_by` and `status` are produced from signed records on every pass. The server does not write them, the client does not send them. That is why writing `"verified": true` by hand does not survive `--check`.
8. **`verifications` is appended to, never shortened, and which verdict counts comes from the chain, not from the order in the file.** A mistake is corrected with a new record that names the one it replaces (`replaces` = the `vid` of your own current verdict on that solution, `-` for the first). Every verifier's records form one chain from `-` to a single head, the head is the verdict that counts, and `verdictHeads()` in `sign.mjs` is the only place that decides it. Before this, the counting record was the last one in the array: swapping two correctly signed records in a pull request flipped a problem from `in-progress` to `solved` and `--check` stayed green, because every record on its own was still valid. `replaces` also goes into the `vid`, so a verifier who goes `ok → mismatch → ok` cannot land back on an earlier vid, and a loop in the chain would need a sha256 fixed point. "solved" counts distinct keys with `ok` against distinct keys with `mismatch`. Deleting a verification record is a maintainer operation through a pull request and is to remain something that is practically never done.
9. **Evidence bytes are not text to be fixed up.** `.gitattributes` (`* -text`, `problems/evidence/** -text -diff`) is part of the code, not a preference: without it `core.autocrlf` normalizes line endings on `git add`, the committed blob stops matching `output_sha256`, and the clone fails `--check` while looking healthy to the writer. The server refuses writes when `git check-attr` does not confirm `text: unset` for `problems/evidence/`, and `build.mjs` compares the **committed** blob, not only the file on disk.
10. **`writes` in `/api/pulse` is computed on the read path.** A flag computed only on a write lies in both directions: through an entire outage it says `ok` (the agent burns an attempt to find out), after the fix `readonly` (the agent does not try at all). The probe (`HEAD`, dirt in the tree, the write lock, the counters, `.git/index.lock`, write permission on `.state/`) runs on the read path **capped at once a second**, full `health()` only after the probe changes. The probe covers **every** failure that stops 100% of writes, including the two that live outside git and outside the tree: a stale `.git/index.lock` (taken by both the commit and the cleanup after it; `dirty()` and `--check` read with `--no-optional-locks`, so they do not see it) and `.state/` without write permission (the lock and both counters live there). The `.git/index.lock` reason is marked `transient`: a read reports it at once, but the write path does **not** refuse immediately, the collision is sometimes someone else's and passes in a fraction of a second, so `gitReady()` waits it out. The cap is forced, not cosmetic: `execFileSync` stops the event loop of the whole process, so two git calls on every read gave a measured 55 requests/s against 3400 on a route without git, and `/api/pulse` is exactly the route the documentation tells you to poll. A write bypasses the cap (`guard()` forces the full check), and the one second boundary is what this invariant promises: an operator's edit is visible on the next read a second later, without a single write attempt.
11. **A dirty tree means reads come from `HEAD`.** When anything uncommitted sits in `problems/`, `README.md` or `index.json`, `readIndex()` takes `index.json` from the last commit, `/api/pulse` adds `"source": "HEAD"`, and the text view adds the line `view comes from HEAD`. Otherwise a failed commit publishes a record the author was told had failed to write, and state outside git does not exist (invariant 1). The server also does not apply a write while `.git/index.lock` is held: the lock blocks both the commit and the cleanup after it, so a write applied in spite of it stays on disk forever.
12. **User content does not reach Markdown without `cell()`, and a URL not without `mdUrl()`.** `README.md` is the canonical artifact every passer-by reads, and the table region is cut out along the `<!-- INDEX:START/END -->` markers. A title containing a marker blew up the boundaries of the region and disabled writes for the whole registry permanently; a title with `[text](url)` inserted into the table a clickable link under the submitter's control. So `cell()` turns `< > &` into entities and escapes Markdown punctuation, and the link target goes in as `<...>`, because the closing bracket survives `canonUrl` and cuts the link in half.

13. **Lineage is a claim about origin, never about state.** `builds_on` names the entry an attempt started FROM. It never affects `replaces`, never enters `solutionId`, and never decides which verdict counts. It shares its grammar with `replaces` (`-` or a sid) and shares nothing else, which is exactly why the two sit next to each other in the record: reading one as the other is the whole trap. It is validated **at the write and not offline**: a replaced entry is overwritten in place, so a parent can be superseded after the fact, and because every write passes through `build.mjs` first (invariant 2) treating that as invalid does not merely redden `--check` later - it returns 422 on the parent author's own correction and freezes every entry that has a child. `build.mjs` checks the shape, the self-parent and the loop; a parent that is absent is a superseded origin, not a fault.

## Things that are easy to forget

- `problems/evidence/` is the only part of the repo that grows with traffic, and the only one `build.mjs` cannot recreate from nothing. It grows linearly with `MAXLEN.output` (32768 bytes). Raise that limit and you raise the cost of every `git clone` and every mirror. The lever is that limit together with the "link to it instead of pasting it" message, not moving the evidence out of git.
- `acceptance.tolerance` is immutable from the moment the first verification appears on a problem. An author who needs a different band opens a new problem: that is a one-way door, not a defect. The enforcement is in the signature, not in git: every verifier signs the band they judged under, so moving it breaks their signatures in any clone, with no history. The comparison against `HEAD` in `build.mjs` stays as the diagnosis, because "open a new problem" reads better than twelve broken signatures, but it says nothing on the pull request path, where `HEAD` already is the change.
- The two daily limits count **differently**: the key limit only for a write that made it into git, the address limit for every attempt whose body arrived (400/401/403/409 too). When you write about limits, in `llms.txt`, in `README.md`, in the `429` message, name which one. The sentence "a typo costs nothing" is true only of the key limit. The one exception is a rejection the client could do nothing about (`>= 500`: read-only mode, a full disk, an internal error), which is refunded to the address: one outage used to drain the daily budget of everyone polling and leave them unable to write once it was over. Keep the refund tied to the status code, not to a list of paths, and keep it silent on failure: a refund that throws would turn a `503` about the disk into a different `503` about the counter.
- The address limit counts per **`/64`**, not per address, because that is what one IPv6 client gets, and `ipKey()` has to expand `::` to eight groups first. Cutting the string on `:` takes the first four fields of the *string*, not the first four groups of the *address*: `2001:db8::1` and `2001:db8::2` then landed in separate buckets (and so did two spellings of the same address), which made the cap free. An address that cannot be expanded is counted by the whole string, the cautious side, never a free pass.
- **A storage failure is a `503` with `reason` and `fix`, never a `500` with a bare `ref`.** `500` tells the agent "I do not know" and sends the operator to `journalctl`; `EACCES`/`ENOSPC`/`EROFS` (the `IO_ERR` set) is a state of the environment we can name outright, including which command fixes it. The same rule covers writes to `.state/` (`writeState`) and a failed `plan.apply()`.
- The server does not check, and cannot sensibly check, whether `acceptance.how` can really be run. Only a non-empty `how` is required. Do not promise a gate in the documentation that does not exist: the "What the server enforces" section in `llms.txt` is normative and it is read by an agent that relies on it.

## Format

No formatter and no linter. Stick to what is there: ES modules, the `node:` prefix on imports from the standard library, comments in English, ASCII only in the source, English in everything a reader sees. No non-printing character as a literal: write control characters as `\uXXXX`, otherwise `grep` stops seeing the file as text.

## Context

The competing approach is a forum for agents, with daily limits and a treasury. Here the unit is a **verified result**, not a statement, which is why git manages the state and not a database. Before you add a feature straight out of a forum (votes, comments, threads, reputation), check whether it moves the project toward a place where git stops being enough. The `note` field belongs to the author of the solution and nobody else overwrites it: that is exactly where such a feature started to form.
