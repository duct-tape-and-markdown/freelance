/**
 * Git helpers for content-reachability prune.
 *
 * Two narrow capabilities:
 *   - `resolveRef(cwd, ref)` — turn a user-supplied ref (branch, tag,
 *     remote ref, SHA) into a commit SHA. Fails loudly so prune can
 *     hard-error before touching the db.
 *   - `readBlobsAtRefs(cwd, specs)` — batched `git cat-file --batch`
 *     read of many `<ref>:<path>` blobs in one subprocess. Returns
 *     the bytes (or null for missing path / missing object).
 *
 * Both are pure: no mutation of the working tree, no branch switching,
 * no stash. `cat-file` streams from the git object store directly, so
 * the user's current checkout stays untouched while prune inspects
 * every `--keep` ref.
 */

import { spawnSync } from "node:child_process";

const SHA40 = /^[0-9a-f]{40}$/i;

export type RefResolution =
  | { ok: true; ref: string; sha: string }
  | { ok: false; ref: string; error: string };

/**
 * Resolve a user-supplied ref to a commit SHA. `^{commit}` forces
 * dereference: annotated tags resolve to the pointed-to commit rather
 * than the tag object, so downstream `ref:path` specs work uniformly.
 */
export function resolveRef(cwd: string, ref: string): RefResolution {
  const res = spawnSync("git", ["-C", cwd, "rev-parse", "--verify", `${ref}^{commit}`], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    const stderr = (res.stderr ?? "").trim();
    return { ok: false, ref, error: stderr || `git rev-parse failed for ${ref}` };
  }
  const sha = res.stdout.trim();
  if (!SHA40.test(sha)) {
    return { ok: false, ref, error: `git rev-parse returned non-SHA: ${sha}` };
  }
  return { ok: true, ref, sha };
}

/**
 * Return the git working-tree root for `cwd`, or null when `cwd`
 * isn't inside a git checkout. `file_path` values stored in
 * `proposition_sources` are relative to the Freelance source root,
 * which may be a subdirectory of the git repo; `cat-file` speaks in
 * repo-root-relative paths, so prune needs this for translation.
 */
export function resolveGitTopLevel(cwd: string): string | null {
  const res = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (res.status !== 0) return null;
  return res.stdout.trim() || null;
}

/**
 * Batched blob read via `git cat-file --batch`. One subprocess, many
 * specs; stdin feeds `<ref>:<path>` lines, stdout streams responses.
 * Output format per spec (binary-safe):
 *
 *   "<oid> blob <size>\n<bytes>\n"   when the blob exists
 *   "<spec> missing\n"               when the ref doesn't have that path
 *
 * Non-existent paths, submodule gitlinks, and trees at the requested
 * path all come back as `missing`. The caller doesn't need to
 * distinguish — anything that doesn't yield bytes is "not present".
 */
export function readBlobsAtRefs(cwd: string, specs: string[]): Map<string, Buffer | null> {
  const out = new Map<string, Buffer | null>();
  if (specs.length === 0) return out;

  const res = spawnSync("git", ["-C", cwd, "cat-file", "--batch"], {
    input: `${specs.join("\n")}\n`,
    stdio: ["pipe", "pipe", "ignore"],
    // `encoding: "buffer"` keeps stdout raw so we can slice payloads
    // byte-exact. Headers are still ASCII within the buffer.
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) {
    // Node surfaces maxBuffer overflow via the returned `error`. Throw
    // rather than silently returning all-null — a null response here
    // gets interpreted downstream as "not present at ref", which would
    // classify every row as a prune candidate. Loud failure is the
    // only safe behavior.
    const err = res.error as NodeJS.ErrnoException;
    if (err.code === "ENOBUFS" || err.message?.includes("maxBuffer")) {
      throw new Error(
        `git cat-file --batch exceeded 256MB buffer — too much blob content to hash in one batch. ` +
          `Narrow the --keep set or split the source tree.`,
      );
    }
    throw err;
  }
  if (res.status !== 0 || !res.stdout) {
    throw new Error(`git cat-file --batch failed (status ${res.status ?? "null"})`);
  }

  const buf = res.stdout as Buffer;
  let offset = 0;
  for (const spec of specs) {
    const nl = buf.indexOf(0x0a, offset);
    if (nl < 0) {
      out.set(spec, null);
      continue;
    }
    const header = buf.subarray(offset, nl).toString("utf-8");
    offset = nl + 1;
    if (header.endsWith(" missing")) {
      out.set(spec, null);
      continue;
    }
    const parts = header.split(" ");
    if (parts.length !== 3 || parts[1] !== "blob") {
      out.set(spec, null);
      continue;
    }
    const size = Number.parseInt(parts[2], 10);
    if (!Number.isFinite(size) || size < 0) {
      out.set(spec, null);
      continue;
    }
    const payload = buf.subarray(offset, offset + size);
    offset += size + 1;
    out.set(spec, Buffer.from(payload));
  }
  return out;
}
