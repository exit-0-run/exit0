// The whole change. Two operations, both provably inert with respect to what the package
// exports and what it does:
//
//   1. delete every *.map file
//   2. delete the sourceMappingURL comment that pointed at one
//
// Step 2 is not cosmetic and it is the part that is easy to skip. 98 of date-fns' 2655
// javascript files carry that comment, all of them the cdn bundles. Removing the maps and
// leaving the comments would hand every one of those files a dangling reference, which is
// not a crash but is a worse artifact than either doing the job or not doing it.
//
// Nothing else is touched. No file the package exports is removed, no dependency is moved
// to the consumer, no locale, no build variant, no type declaration. What leaves is debug
// metadata for the package's own internals.
import { readdirSync, statSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SMAP = /[ \t]*(?:\/\/|\/\*)[#@][ \t]*sourceMappingURL=[^\s*]*(?:[ \t]*\*\/)?[ \t]*\r?\n?/g;

export const prune = (root) => {
  let mapBytes = 0, mapFiles = 0, rewritten = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (!e.isFile()) continue;
      if (e.name.endsWith(".map")) {
        mapBytes += statSync(f).size;
        mapFiles++;
        rmSync(f);
      } else if (/\.(js|cjs|mjs)$/.test(e.name)) {
        const s = readFileSync(f, "utf8");
        if (!s.includes("sourceMappingURL=")) continue;
        const t = s.replace(SMAP, "");
        if (t !== s) { writeFileSync(f, t); rewritten++; }
      }
    }
  };
  walk(root);
  return { mapBytes, mapFiles, rewritten };
};
