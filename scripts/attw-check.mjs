// CI type-resolution gate — replaces `npx -y @arethetypeswrong/cli --pack .`.
//
// attw (through 0.18.2) extracts the package tarball by keeping only the LAST
// fflate Gunzip chunk. On Node 22/24, fflate 0.8.3's streaming Gunzip emits a
// trailing empty final chunk, so attw's extraction yields an empty buffer and
// the CLI crashes with "Cannot read properties of undefined (reading 'filename')"
// on every package. We decompress with node's zlib.gunzipSync (reliable), build
// the Package from the file map ourselves, and run the same core check. Pinning
// attw's pieces as devDependencies also drops the unpinned `npx -y` fetch — see
// decisions.md § "CI must not depend on unpinned npx tools".
//
// Mirrors the prior CLI flags `--ignore-rules cjs-resolves-to-esm no-resolution`.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { untar } from "@andrewbranch/untar.js";
import { checkPackage, Package } from "@arethetypeswrong/core";
import { allProblemKinds, problemKindInfo } from "@arethetypeswrong/core/problems";

const IGNORE_KINDS = new Set(["CJSResolvesToESM", "NoResolution"]);

// Fail loudly if a pinned-attw upgrade renames a kind we ignore.
for (const kind of IGNORE_KINDS) {
  if (!allProblemKinds.includes(kind)) {
    console.error(`attw-check: unknown problem kind "${kind}" — attw API changed.`);
    process.exit(2);
  }
}

// Pack exactly as `npm pack` would (honoring "files"). --ignore-scripts keeps the
// prepare lifecycle from polluting stdout.
const tgzBefore = new Set(readdirSync(".").filter((f) => f.endsWith(".tgz")));
execFileSync("npm", ["pack", "--ignore-scripts", "--silent"], {
  stdio: ["ignore", "ignore", "inherit"],
});
const tarball = readdirSync(".").find((f) => f.endsWith(".tgz") && !tgzBefore.has(f));
if (!tarball) {
  console.error("attw-check: npm pack produced no tarball");
  process.exit(2);
}

try {
  const entries = untar(new Uint8Array(gunzipSync(readFileSync(tarball))));
  const prefix = entries[0].filename.slice(0, entries[0].filename.indexOf("/") + 1);
  const manifest = entries.find((e) => e.filename === `${prefix}package.json`);
  const { name, version } = JSON.parse(new TextDecoder().decode(manifest.fileData));
  const files = {};
  for (const e of entries) {
    files[`/node_modules/${name}/${e.filename.slice(prefix.length)}`] = e.fileData;
  }

  const result = await checkPackage(new Package(files, name, version));
  const problems = (result.problems ?? []).filter((p) => !IGNORE_KINDS.has(p.kind));
  if (problems.length > 0) {
    console.error(`attw: ${problems.length} problem(s) found:`);
    for (const p of problems) {
      const where = p.entrypoint ? ` (${p.entrypoint})` : "";
      console.error(`  ${p.kind}: ${problemKindInfo[p.kind]?.shortDescription ?? ""}${where}`);
    }
    process.exit(1);
  }
  console.log(`attw: no problems (ignoring ${[...IGNORE_KINDS].join(", ")})`);
} finally {
  rmSync(tarball, { force: true });
}
