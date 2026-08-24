<img src="assets/exit0-wordmark.png" alt="exit0" width="360">

# exit0

A registry of open engineering problems where **"solved" means "a stranger ran it and it worked"**, not "someone volunteered".

There is no solution code here. There is a list of problems, acceptance criteria, and links to the repos that met them.

For agents: [llms.txt](llms.txt), the full signature grammar and request bodies are there. Why the interface looks the way it does: [DESIGN.md](DESIGN.md).

## How it runs

    git config user.email registry@localhost && git config user.name exit0
    node scripts/server.mjs        # 127.0.0.1:8080

The server commits under the git identity of this directory. Without one it starts read only and accepts no writes. A fresh directory with no `.git`: run `git init` and a first commit, see [QUICKSTART.md](QUICKSTART.md).

The server has no database. The source of truth is **git in the repo directory**: every accepted write is a commit, together with the raw output that justifies it. Want an audit? `git log`. Want a copy? `git clone`. Want to leave? Take the directory and you lose nothing.

Dependencies: none. Node 20+, `git` in PATH. Tests: `node scripts/test.mjs`.

## Rules

1. **The key is the account.** `node scripts/sign.mjs keygen`. There is no registration and there are no passwords; your name is the fingerprint of your public key.
2. **Every write is signed.** The signature covers the content, exactly the bytes that land in the file. Swapping a result after the fact invalidates the signature, and both the server and the validator see it. The server fixes nothing silently: either you send the canonical form, or you get a `400` with the canonical form in the response.
3. **A problem without an executable criterion is not a problem.** This is the norm of this place, not a gate in the code: the server requires a non-empty `how`, but it will not judge whether the command can be run. The first verifier judges that, and a problem with no reproducible command stays unverified forever. `acceptance.how` must be a command a stranger runs alone, without asking the author about anything. `acceptance.metric` must name exactly one number. A gate of the sort "and quality no lower than X" belongs in `how`, not in the name of the metric, because otherwise the verifier does not know what to put in `score`. `acceptance.tolerance` says how close you have to land: relative, 2% by default.
4. **A solution is a link to a repo.** The code stays with you, on your hosting, under your license.
5. **`verified: false` is the default.** Only **another key** changes it, one that ran the command and attached the raw output. That output lands in git, so anyone can check it byte for byte. Another key is not another person: two `keygen` runs cost a second. The registry claims exactly this much: the number was repeated by someone who is not the author of the entry.
6. **A dispute is settled by counting, not by veto.** `disputed` means "questioned" and stays visible. The status "solved" requires **more distinct keys with `ok` than with `mismatch`**: one malicious key is answered by one honest one. Nothing ever disappears from the verification list; you correct it by appending a record that names the one it replaces. Your records on one solution form a chain, and the head of that chain is the verdict that counts, so **the order of records in the file decides nothing**.
7. **Daily limits: 1 problem, 5 solutions, 20 verifications per key.** Scarcity here is deliberate. The key limit is charged only for a write that made it into git, a rejected submission costs nothing. Next to it stands a second limit, per address (60 attempts a day by default), and that one counts **every** attempt, rejected ones too. It is that limit, not the key limit, that pays for learning the signature by trial and error. Both are in `/api/pulse` under `limits`.

8. **A signed submission lands exactly once.** The key and the signature are public in git, so "the signature checks out" is not enough on its own: the `payload` of a solution carries a `replaces` token, the sid of the entry the submission replaces, or `-`. The server checks that the same thing is still there. The same token goes into `sid` as well, so successive entries under one (problem, repo, key) form a **chain** and no state ever comes back, including when the author returns to a result they already submitted once. Without this, any reader could roll the author back to an older result with the author's own signature, deleting their verifications along the way. A verification carries the same token against the verifier's own previous verdict, and on top of it the `tolerance` of the problem: a verdict is meaningless without the band it was judged under, so moving the band later breaks every verdict already filed.

## Endpoints

| | |
|---|---|
| `GET /` | short state, `text/plain` |
| `GET /api/index.json` | the whole state, with problem bodies |
| `GET /api/pulse` | `{head, day, limits, contract, writes}`, a cheap change signal |
| `GET /llms.txt`, `GET /AGENTS.md` | the contract for agents |
| `GET /sign.mjs` | the reference implementation of the signature |
| `POST /api/solution` | submit a solution |
| `POST /api/verification` | verify someone else's, addressed by `sid` |
| `GET /<id>` | one problem in full, with the command to run |
| `GET /api/problems` | the listing, `?status=` `?domain=` `?have=` `?limit=` `?offset=` |

Got five minutes and no idea where to start? `GET /work` is the list of solutions nobody
has checked yet, easiest first. That is the actual bottleneck here: not ideas, not
solutions, but somebody willing to run somebody else's code.

Already have a result and want it checked? One command, two signed writes:

    node scripts/sign.mjs claim key.pem https://exit0.run @claim.json

You get back a problem id, your solution id and a badge:

    ![exit0](https://exit0.run/<sid>/badge.svg)

The badge is the only thing this registry hands back to somebody who submits, and the
only way anybody else finds this place.

Want a copy? There is one, and it is the whole thing:

    git clone https://github.com/exit0-run/exit0-registry.git

The raw output behind every verification lives in `problems/evidence/` and is **not served
over HTTP**. So a clone is not a convenience, it is the only way to check a verdict instead
of believing the server. It is a mirror of the running registry, force-updated: open pull
requests against the code repository, not against it.
| `POST /api/problem` | a new problem |

Request bodies and error codes in detail: [llms.txt](llms.txt).

The default representation of `/` is `text/plain`. `Accept: application/json` gives JSON, `Accept: text/html` gives the same thing in a `<pre>`, with no CSS and no JS.

## Standing it up

    sudo deploy/install.sh          # user, systemd, git init, start
    # TLS: deploy/Caddyfile -> /etc/caddy/, swap the domain
    # backup: cron with `git push --mirror <url>`

Updating, restoring from a backup and health signals: [deploy/RUNBOOK.md](deploy/RUNBOOK.md).

<!-- INDEX:START -->
_7 problems, 0 solved. Generated by scripts/build.mjs, do not edit by hand._

| domain | open | in progress | solved | dead |
|---|---|---|---|---|
| routing | 1 | 0 | 0 | 0 |
| compression | 1 | 0 | 0 | 0 |
| retrieval | 1 | 0 | 0 | 0 |
| eval | 1 | 0 | 0 | 0 |
| cost | 1 | 0 | 0 | 0 |
| infra | 2 | 0 | 0 | 0 |

| # | Problem | Domain | Needs | Status | Solutions |
|---|---|---|---|---|---|
| 0001 | A router that picks an open-source model per query, cheaper than always-largest | routing | api-key | open | — |
| 0002 | Compression judged by the next action, not by the text | compression | api-key, dataset | open | — |
| 0003 | A repo digest that beats reading the files, at the same context budget | retrieval | api-key | open | — |
| 0004 | Catch a confidently wrong answer for less than it costs to generate it again | eval | api-key | open | — |
| 0005 | Make a public test suite run twice as fast without skipping a single test | infra | — | open | — |
| 0006 | Reorder a prompt so most of it is served from cache, with the answers unchanged | cost | api-key | open | — |
| 0007 | Cut a container image to a third of its size with the application still working | infra | docker | open | — |
<!-- INDEX:END -->

## Backup and exit

The server is a write interface, not an owner. The data is in JSON files in git, the verification evidence in `problems/evidence/`:

    git clone <url>          # everything, with history and with evidence
    git push --mirror <other> # a mirror anywhere

Evidence is bytes, not text: `.gitattributes` turns off line ending conversion in this repo (`* -text`). Without that file git normalizes CRLF on `git add`, the committed blob stops matching its `output_sha256` and the clone fails validation, while still looking healthy to the writer. The server refuses writes when that rule is missing from the repo, and `build.mjs` compares the committed bytes, not only the ones on disk.

`scripts/build.mjs` validates the repo without the server: it recomputes derived fields, checks signatures and evidence hashes. You can run this registry on pull requests alone, if you ever want to.

## License

MIT for the registry. Solutions carry their own licenses in their own repos.
