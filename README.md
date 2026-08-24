# semver-scan

An attempt at [exit0](https://exit0.run) problem **0014**: beat a widely used parser on
throughput with byte-identical output.

    make bench

One command. It fetches both arms, runs them on the same machine in the same run, and
prints one JSON line.

## What is being compared

| | |
| --- | --- |
| Reference | `semver@7.7.2`, the `parse` entry point, strict mode |
| Corpus | `github.com/npm/node-semver` at commit `281055e7716ef0415a8826972471331989ede58c` |
| Corpus contents | every string literal in `test/fixtures/`, deduplicated, 1 to 256 bytes |
| This attempt | `scan.mjs`, a hand written character scanner, no regex |

The corpus is the reference implementation's own fixture set, so it holds versions,
ranges and plain junk like `use strict`. The junk is not noise. Those are the inputs
`parse` has to reject, and a parser that is fast because it accepts too much would be
caught by exactly those lines.

`make bench` pins the corpus by **commit**, not by tag. A tag can be moved, and then the
corpus a verifier measures is not the corpus this number was measured on.

## The number, and what it is made of

    speedup                   69.02
    mb_per_second            253.11
    baseline_mb_per_second     3.66
    mismatches                    0    over 541 inputs

The score is `speedup`, a ratio, because both arms ran in the same process on the same
machine. Megabytes per second is a fact about the box and would make a verifier on other
hardware disagree about nothing.

Reporting only the ratio would still be misleading. The split is printed by the same run:

    mb_per_second_accepts             157.89
    baseline_mb_per_second_accepts     50.69

So on the 259 inputs the reference **accepts**, this is about 3.1 times faster. That is
the parsing win. On the 282 it **rejects** the distance is far larger, because
`semver.parse` constructs a `TypeError` with a stack trace for every invalid input and
catches it. The corpus is 52 percent rejects, so most of the headline number is exception
cost, not parsing.

Both halves are in the JSON so that nobody has to take this paragraph on trust.

## What this is not

It is not a replacement for `semver`. The reference returns a `SemVer` instance that
knows how to compare itself, format itself and hold its own raw input. `scan.mjs` returns
a plain object with `major`, `minor`, `patch`, `prerelease` and `build`, which is what the
problem defines as the output to match. The win is partly that this does less: if all you
need is the parse, you do not need the class.

Ranges, comparators and coercion are out of scope. This is `parse` only.

## Conformance

`mismatches` counts, for every input in the corpus, a disagreement in either the
accept or reject decision or the serialised parsed value. It must be 0. During
development the scanner was also run against the reference over 40000 generated strings
drawn from an alphabet chosen to be hostile (digits, letters, dots, plus, hyphen, `v`,
spaces and tabs). Two real bugs came out of that and both are in the code as comments:
the reference checks its length limit **before** trimming whitespace and matches
**after**, and prerelease identifiers that are all digits reject a leading zero while
identifiers containing a letter do not.

## Licence

MIT.
