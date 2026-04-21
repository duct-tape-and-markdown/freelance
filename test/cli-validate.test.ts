import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validate } from "../src/cli/validate.js";
import { hashContent } from "../src/sources.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cli-validate-test-"));
}

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function copyFixtures(dir: string, ...files: string[]): void {
  for (const f of files) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(dir, f));
  }
}

// Runtime + authoring CLI handlers are JSON-only per docs/decisions.md.
// Assertions go against stdout (parsed) and exit codes.

describe("CLI validate", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  function stdoutJson(): unknown {
    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    return JSON.parse(out);
  }

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("succeeds with valid graph files (exit 0)", async () => {
    const dir = tmpDir();
    copyFixtures(dir, "valid-simple.workflow.yaml", "valid-branching.workflow.yaml");
    await expect(validate(dir)).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
    const result = stdoutJson() as { valid: boolean; graphs: Array<{ id: string }> };
    expect(result.valid).toBe(true);
    expect(result.graphs).toHaveLength(2);
  });

  it("exits with VALIDATION (3) for nonexistent directory", async () => {
    await expect(validate("/nonexistent/path")).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(3);
    const result = stdoutJson() as { valid: boolean; errors: Array<{ message: string }> };
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("does not exist");
  });

  it("exits with VALIDATION (3) for empty directory", async () => {
    const dir = tmpDir();
    await expect(validate(dir)).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(3);
    const result = stdoutJson() as { valid: boolean; errors: Array<{ message: string }> };
    expect(result.errors[0].message).toContain("No *.workflow.yaml");
  });

  it("exits with VALIDATION (3) for invalid graph", async () => {
    const dir = tmpDir();
    copyFixtures(dir, "invalid-orphan.workflow.yaml");
    await expect(validate(dir)).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(3);
    const result = stdoutJson() as { valid: boolean; errors: unknown[] };
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("reports per-file errors in the JSON response", async () => {
    const dir = tmpDir();
    copyFixtures(dir, "valid-simple.workflow.yaml", "invalid-orphan.workflow.yaml");
    await expect(validate(dir)).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(3);
    const result = stdoutJson() as {
      valid: boolean;
      graphs: Array<{ id: string }>;
      errors: Array<{ file: string; message: string }>;
    };
    expect(result.valid).toBe(false);
    // Valid graph still loaded
    expect(result.graphs.some((g) => g.id === "valid-simple")).toBe(true);
    // Invalid graph surfaced as an error
    expect(result.errors.some((e) => e.file.includes("invalid-orphan"))).toBe(true);
  });

  it("validates cross-graph subgraph references (success path)", async () => {
    const dir = tmpDir();
    copyFixtures(dir, "parent-with-subgraph.workflow.yaml", "child-review.workflow.yaml");
    await expect(validate(dir)).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("fails on broken cross-graph subgraph reference", async () => {
    const dir = tmpDir();
    copyFixtures(dir, "parent-with-subgraph.workflow.yaml");
    await expect(validate(dir)).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("accepts subgraph references to sealed memory:* workflows", async () => {
    const dir = tmpDir();
    copyFixtures(dir, "parent-with-sealed-subgraph.workflow.yaml");
    await expect(validate(dir)).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("treats directory with non-graph files as empty", async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "readme.txt"), "not a graph");
    fs.writeFileSync(path.join(dir, "data.yaml"), "id: test");
    await expect(validate(dir)).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("JSON output includes graph metadata fields", async () => {
    const dir = tmpDir();
    copyFixtures(dir, "valid-simple.workflow.yaml");
    await expect(validate(dir)).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(0);
    const result = stdoutJson() as {
      graphs: Array<{ id: string; name: string; version: string; nodeCount: number }>;
    };
    const graph = result.graphs[0];
    expect(graph.name).toBe("Simple Workflow");
    expect(graph.version).toBe("1.0.0");
    expect(graph.nodeCount).toBe(3);
  });

  describe("--sources option", () => {
    function writeGraphWithSources(dir: string, docHash: string): void {
      const graphContent = `id: source-test
version: "1.0.0"
name: "Source Test"
description: "Graph with source bindings"
startNode: start
nodes:
  start:
    type: action
    description: "Start"
    sources:
      - path: "doc.md"
        hash: "${docHash}"
    edges:
      - target: done
        label: done
  done:
    type: terminal
    description: "Done"
`;
      fs.writeFileSync(path.join(dir, "source-test.workflow.yaml"), graphContent);
    }

    it("passes when source hashes match", async () => {
      const dir = tmpDir();
      const docContent = "# Doc\n\nContent here.\n";
      fs.writeFileSync(path.join(dir, "doc.md"), docContent);
      const correctHash = hashContent(docContent);
      writeGraphWithSources(dir, correctHash);

      await expect(validate(dir, { checkSources: true, basePath: dir })).rejects.toThrow(
        "process.exit",
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("detects drift when source hash is wrong", async () => {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, "doc.md"), "# Doc\n");
      writeGraphWithSources(dir, "0000000000000000");

      await expect(validate(dir, { checkSources: true, basePath: dir })).rejects.toThrow(
        "process.exit",
      );
      expect(exitSpy).toHaveBeenCalledWith(3);
      const result = stdoutJson() as { sourceDrift: unknown[] };
      expect(result.sourceDrift.length).toBeGreaterThan(0);
    });

    it("--fix updates drifted hashes in-place", async () => {
      const dir = tmpDir();
      const docContent = "# Doc\n\nFixed content.\n";
      fs.writeFileSync(path.join(dir, "doc.md"), docContent);
      const wrongHash = "0000000000000000";
      writeGraphWithSources(dir, wrongHash);

      await expect(validate(dir, { checkSources: true, fix: true, basePath: dir })).rejects.toThrow(
        "process.exit",
      );
      expect(exitSpy).toHaveBeenCalledWith(0);

      const updatedContent = fs.readFileSync(path.join(dir, "source-test.workflow.yaml"), "utf-8");
      const correctHash = hashContent(docContent);
      expect(updatedContent).toContain(correctHash);
      expect(updatedContent).not.toContain(wrongHash);

      const result = stdoutJson() as { fixed?: number };
      expect(result.fixed).toBeGreaterThan(0);
    });

    it("--fix skips FILE_NOT_FOUND sources", async () => {
      const dir = tmpDir();
      writeGraphWithSources(dir, "0000000000000000");

      await expect(validate(dir, { checkSources: true, fix: true, basePath: dir })).rejects.toThrow(
        "process.exit",
      );
      expect(exitSpy).toHaveBeenCalledWith(3);
      const result = stdoutJson() as { sourceDrift: unknown[] };
      expect(result.sourceDrift.length).toBeGreaterThan(0);
    });

    it("reports drift in JSON output", async () => {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, "doc.md"), "# Doc\n");
      writeGraphWithSources(dir, "0000000000000000");

      await expect(validate(dir, { checkSources: true, basePath: dir })).rejects.toThrow(
        "process.exit",
      );
      const result = stdoutJson() as {
        valid: boolean;
        sourceDrift: Array<{ drifted: Array<{ expected: string; actual: string }> }>;
      };
      expect(result.valid).toBe(false);
      expect(result.sourceDrift[0].drifted[0].expected).toBe("0000000000000000");
      expect(result.sourceDrift[0].drifted[0].actual).toBeTruthy();
    });
  });

  describe("requiredMeta lint (issue #59)", () => {
    it("emits a warning when a requiredMeta key is neither documented nor set by onEnter", async () => {
      const dir = tmpDir();
      copyFixtures(dir, "required-meta-unreachable.workflow.yaml");
      await expect(validate(dir)).rejects.toThrow("process.exit");
      // Warnings do not fail validation — exit 0.
      expect(exitSpy).toHaveBeenCalledWith(0);
      const result = stdoutJson() as {
        valid: boolean;
        warnings: Array<{ file: string; rule: string; message: string }>;
      };
      expect(result.valid).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].rule).toBe("required-meta-reachability");
      expect(result.warnings[0].message).toContain("externalKey");
      expect(result.warnings[0].file).toContain("required-meta-unreachable");
    });

    it("emits no warning when the description mentions the key", async () => {
      const dir = tmpDir();
      copyFixtures(dir, "required-meta-caller.workflow.yaml");
      await expect(validate(dir)).rejects.toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(0);
      const result = stdoutJson() as { valid: boolean; warnings?: unknown[] };
      expect(result.valid).toBe(true);
      // `warnings` omitted entirely when empty — keeps success shape minimal.
      expect(result.warnings).toBeUndefined();
    });

    it("emits no warning when the start-node onEnter meta_set sets the key", async () => {
      const dir = tmpDir();
      copyFixtures(dir, "required-meta-hook.workflow.yaml");
      await expect(validate(dir)).rejects.toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(0);
      const result = stdoutJson() as { valid: boolean; warnings?: unknown[] };
      expect(result.valid).toBe(true);
      expect(result.warnings).toBeUndefined();
    });
  });

  describe("hook-script import check", () => {
    // File-existence of `./scripts/foo.js` is checked synchronously in
    // `resolveGraphHooks` (loader path). The cases here exercise errors
    // that can only be caught by actually importing the module — syntax
    // errors, missing default export, non-function default. Without the
    // eager check these would only surface at first hook invocation
    // inside a live traversal.
    function writeGraphWithHook(dir: string, scriptName: string): void {
      const graphContent = `id: hook-validate
version: "1.0.0"
name: "Hook Validate"
description: "Graph with a local hook script"
startNode: start
nodes:
  start:
    type: action
    description: "Start"
    onEnter:
      - call: ./scripts/${scriptName}
    edges:
      - target: done
        label: done
  done:
    type: terminal
    description: "Done"
`;
      fs.writeFileSync(path.join(dir, "hook-validate.workflow.yaml"), graphContent);
    }

    it("passes with a syntactically-valid default-function-exporting script", async () => {
      const dir = tmpDir();
      fs.mkdirSync(path.join(dir, "scripts"));
      fs.writeFileSync(
        path.join(dir, "scripts", "ok.js"),
        "export default async function () { return {}; }\n",
      );
      writeGraphWithHook(dir, "ok.js");

      await expect(validate(dir)).rejects.toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("reports syntax errors in hook scripts", async () => {
      const dir = tmpDir();
      fs.mkdirSync(path.join(dir, "scripts"));
      // Unterminated string literal
      fs.writeFileSync(path.join(dir, "scripts", "broken.js"), 'export default "\n');
      writeGraphWithHook(dir, "broken.js");

      await expect(validate(dir)).rejects.toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(3);
      const result = stdoutJson() as {
        valid: boolean;
        errors: Array<{ file: string; message: string }>;
      };
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("Failed to import hook script"))).toBe(
        true,
      );
    });

    it("reports missing default export", async () => {
      const dir = tmpDir();
      fs.mkdirSync(path.join(dir, "scripts"));
      fs.writeFileSync(
        path.join(dir, "scripts", "nodefault.js"),
        "export const notTheDefault = 1;\n",
      );
      writeGraphWithHook(dir, "nodefault.js");

      await expect(validate(dir)).rejects.toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(3);
      const result = stdoutJson() as { errors: Array<{ message: string }> };
      expect(result.errors.some((e) => e.message.includes("must export a default function"))).toBe(
        true,
      );
    });

    it("reports non-function default export", async () => {
      const dir = tmpDir();
      fs.mkdirSync(path.join(dir, "scripts"));
      fs.writeFileSync(path.join(dir, "scripts", "notfn.js"), "export default 42;\n");
      writeGraphWithHook(dir, "notfn.js");

      await expect(validate(dir)).rejects.toThrow("process.exit");
      expect(exitSpy).toHaveBeenCalledWith(3);
      const result = stdoutJson() as { errors: Array<{ message: string }> };
      expect(result.errors.some((e) => e.message.includes("must export a default function"))).toBe(
        true,
      );
    });
  });
});
