# Half of a date-fns install is source maps

Problem [0014's neighbour](https://exit0.run/0013): halve the install footprint of a
popular npm package with its tests and its public API unchanged.

- **Package:** `date-fns`
- **Pinned version:** `4.1.0`
- **Upstream repo:** https://github.com/date-fns/date-fns

```
make bench
```

## The number

```
megabytes            10.4
baseline_megabytes   21.55
reduction            51.8%
tests_run            1712
tests_passed         1712
exports_missing      0     (over 741 declared subpaths)
```

A clean `npm install date-fns@4.1.0 --omit=dev` puts **21.55 MB** on disk. Of that,
**11.15 MB is `.map` files**: source maps for code almost nobody steps into, downloaded and
written on every clean CI run by everyone who depends on the package.

## The change

Two operations, and that is the whole of it:

1. delete every `*.map` file (196 of them)
2. delete the `sourceMappingURL` comment that pointed at one (98 files)

Step 2 is the part that is easy to skip. 98 of the package's 2655 javascript files carry
that comment, all of them the `cdn` bundles. Removing the maps and leaving the comments
would give every one of those files a dangling reference. That is not a crash, but it is a
worse artifact than either doing the job or not doing it.

Nothing else is touched. No locale is dropped, no build variant, no type declaration, no
dependency is moved onto the consumer. `date-fns` has no dependencies at all, so the
footprint is the package.

## What this costs, stated plainly

Source maps are not free to remove. If you set a breakpoint inside `date-fns` in a browser
devtools session using the `cdn` build, you now step through the shipped file instead of
the original source.

That is a real loss and it is narrow. Nothing the package exports changes, every one of
741 declared subpaths still resolves, and 1712 differential cases produce byte identical
results in both arms. The problem statement names the cheating answers as dropping a
feature, moving a dependency to the consumer, or shipping less and calling it lighter. What
leaves here is debug metadata about the package's own internals, not an API and not
behaviour. You can disagree with where that line sits, and the number above tells you
exactly what is on each side of it.

## How the check works, and why it is not graded by me

`bench.mjs` installs both arms into clean directories on the same machine in the same run,
then compares them against **each other**, never against expectations I wrote down.

For every named export it calls the function across a fixed argument matrix with pinned
dates, records what came back or what was thrown, and requires the lean arm to produce
exactly what the baseline produced. A test suite whose expected values are written by the
person submitting the result proves very little; a differential one cannot be graded
generously.

`exports_missing` reads the package's own `exports` map, resolves each of the 741 declared
subpaths in both arms, and counts the ones the baseline has and the lean arm does not.

**14 cases are excluded and the JSON says so.** The baseline is probed twice, and any case
that disagrees with itself inside one arm reads the clock (`constructNow` and friends).
Comparing those across arms would report the milliseconds between two calls as a
difference between two installs. They are found by running the probe twice, never by a
hand kept list of names, because a list goes stale the next time the package adds one.
The first run of this bench duly reported seven such failures before that was fixed.

## Reproducing

Node 20 or newer, git, and a network connection. Nothing else. Both arms are installed
fresh from the registry inside `make bench`, so the number does not depend on what is
already in your cache.

Two clean installs of the same pinned version differ by **one byte** on this machine, in
npm's own `node_modules/.package-lock.json`. It is counted rather than excluded: an
exclusion is a rule a verifier has to take on trust, and one byte is 4e-8 of the total
against a 2% band.
