import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GraphEngine } from "../src/engine/index.js";
import { loadGraphs } from "../src/loader.js";
import type { AdvanceErrorResult, ValidatedGraph } from "../src/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

function loadFixtures(...files: string[]): Map<string, ValidatedGraph> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "returns-test-"));
  for (const f of files) {
    fs.copyFileSync(path.join(FIXTURES_DIR, f), path.join(tmpDir, f));
  }
  return loadGraphs(tmpDir);
}

function makeEngine(...files: string[]): GraphEngine {
  return new GraphEngine(loadFixtures(...files));
}

describe("return schema — engine validation", () => {
  it("blocks advance when required key is missing", () => {
    const engine = makeEngine("valid-returns.workflow.yaml");
    engine.start("valid-returns");

    // Try to advance without setting any required keys
    const result = engine.advance("done");
    expect(result.isError).toBe(true);
    if (result.isError) {
      expect(result.reason).toContain("Return schema violation");
      expect(result.reason).toContain("filesChanged");
    }
  });

  it("blocks advance when required key has wrong type", () => {
    const engine = makeEngine("valid-returns.workflow.yaml");
    engine.start("valid-returns");
    engine.contextSet({
      filesChanged: "not-an-array", // should be array
      testsWritten: true,
    });

    const result = engine.advance("done");
    expect(result.isError).toBe(true);
    if (result.isError) {
      expect(result.reason).toContain("filesChanged");
      expect(result.reason).toContain("array");
      expect(result.reason).toContain("string");
    }
  });

  it("blocks advance when array items have wrong type", () => {
    const engine = makeEngine("valid-returns.workflow.yaml");
    engine.start("valid-returns");
    engine.contextSet({
      filesChanged: ["valid.ts", 42], // 42 is not a string
      testsWritten: true,
    });

    const result = engine.advance("done");
    expect(result.isError).toBe(true);
    if (result.isError) {
      expect(result.reason).toContain("filesChanged");
      expect(result.reason).toContain("item [1]");
      expect(result.reason).toContain("string");
    }
  });

  it("blocks advance when optional key has wrong type", () => {
    const engine = makeEngine("valid-returns.workflow.yaml");
    engine.start("valid-returns");
    engine.contextSet({
      filesChanged: ["file.ts"],
      testsWritten: true,
      scopeNotes: 42, // should be string
    });

    const result = engine.advance("done");
    expect(result.isError).toBe(true);
    if (result.isError) {
      expect(result.reason).toContain("scopeNotes");
      expect(result.reason).toContain("string");
    }
  });

  it("allows advance when all required keys are present and typed correctly", () => {
    const engine = makeEngine("valid-returns.workflow.yaml");
    engine.start("valid-returns");
    engine.contextSet({
      filesChanged: ["src/main.ts", "src/utils.ts"],
      testsWritten: true,
    });

    const result = engine.advance("done");
    expect(result.isError).toBe(false);
    if (!result.isError) {
      expect(result.currentNode).toBe("review");
    }
  });

  it("allows advance with valid optional keys", () => {
    const engine = makeEngine("valid-returns.workflow.yaml");
    engine.start("valid-returns");
    engine.contextSet({
      filesChanged: ["src/main.ts"],
      testsWritten: true,
      scopeNotes: "Found some tech debt",
      metrics: { linesChanged: 42 },
    });

    const result = engine.advance("done");
    expect(result.isError).toBe(false);
  });

  it("ignores optional keys that are not set", () => {
    const engine = makeEngine("valid-returns.workflow.yaml");
    engine.start("valid-returns");
    engine.contextSet({
      filesChanged: ["file.ts"],
      testsWritten: false,
    });

    // Should pass return schema (even though testsWritten is false — it's a boolean)
    const result = engine.advance("done");
    expect(result.isError).toBe(false);
  });

  it("return schema validates before expression validations", () => {
    const engine = makeEngine("valid-returns.workflow.yaml");
    engine.start("valid-returns");
    engine.contextSet({
      filesChanged: ["file.ts"],
      testsWritten: true,
    });
    engine.advance("done"); // now at review gate

    // At review: has both return schema (reviewPassed) and validation (testsWritten == true)
    // Set reviewPassed to wrong type — should fail on return schema, not expression validation
    engine.contextSet({ reviewPassed: "not-a-boolean" });
    const result = engine.advance("approved");
    expect(result.isError).toBe(true);
    if (result.isError) {
      expect(result.reason).toContain("Return schema violation");
      expect(result.reason).toContain("reviewPassed");
      // Should NOT mention the expression validation
      expect(result.reason).not.toContain("Tests must be written");
    }
  });

  it("context updates persist even when return schema validation fails", () => {
    const engine = makeEngine("valid-returns.workflow.yaml");
    engine.start("valid-returns");

    const result = engine.advance("done", { newKey: "persisted" });
    expect(result.isError).toBe(true);
    if (result.isError) {
      expect(result.context.newKey).toBe("persisted");
    }
  });

  it("validates object type correctly", () => {
    const engine = makeEngine("valid-returns.workflow.yaml");
    engine.start("valid-returns");
    engine.contextSet({
      filesChanged: ["file.ts"],
      testsWritten: true,
      metrics: [1, 2, 3], // array, not object
    });

    const result = engine.advance("done");
    expect(result.isError).toBe(true);
    if (result.isError) {
      expect(result.reason).toContain("metrics");
      expect(result.reason).toContain("object");
    }
  });

  it("rejects null for required keys", () => {
    const engine = makeEngine("valid-returns.workflow.yaml");
    engine.start("valid-returns");
    engine.contextSet({
      filesChanged: null,
      testsWritten: true,
    });

    const result = engine.advance("done");
    expect(result.isError).toBe(true);
    if (result.isError) {
      expect(result.reason).toContain("filesChanged");
    }
  });

  it("validates optional array items type", () => {
    const engine = makeEngine("valid-returns.workflow.yaml");
    engine.start("valid-returns");
    engine.contextSet({
      filesChanged: ["file.ts"],
      testsWritten: true,
    });
    engine.advance("done"); // now at review

    engine.contextSet({
      reviewPassed: true,
      reviewComments: ["good", 42], // 42 is not a string
    });

    const result = engine.advance("approved");
    expect(result.isError).toBe(true);
    if (result.isError) {
      expect(result.reason).toContain("reviewComments");
      expect(result.reason).toContain("item [1]");
    }
  });
});

describe("return schema — NodeInfo includes returns", () => {
  it("start result includes returns field", () => {
    const engine = makeEngine("valid-returns.workflow.yaml");
    const result = engine.start("valid-returns");
    expect(result.node.returns).toBeDefined();
    expect(result.node.returns!.required).toBeDefined();
    expect(result.node.returns!.required!.filesChanged).toBeDefined();
    expect(result.node.returns!.required!.filesChanged.type).toBe("array");
    expect(result.node.returns!.required!.filesChanged.items).toBe("string");
  });

  it("inspect result includes returns field", () => {
    const engine = makeEngine("valid-returns.workflow.yaml");
    engine.start("valid-returns");
    const result = engine.inspect("position");
    if ("node" in result) {
      expect(result.node.returns).toBeDefined();
    }
  });

  it("nodes without returns don't include the field", () => {
    const engine = makeEngine("valid-simple.workflow.yaml");
    const result = engine.start("valid-simple");
    expect(result.node.returns).toBeUndefined();
  });
});

describe("return schema — loader validation", () => {
  function writeGraph(content: string): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "returns-loader-test-"));
    fs.writeFileSync(path.join(tmpDir, "test.workflow.yaml"), content);
    return tmpDir;
  }

  it("rejects terminal node with returns", () => {
    const dir = writeGraph(`
id: test-terminal-returns
version: "1.0.0"
name: "Test"
description: "Test"
startNode: start
nodes:
  start:
    type: action
    description: "Start"
    edges:
      - target: done
        label: go
  done:
    type: terminal
    description: "Done"
    returns:
      required:
        result:
          type: string
`);
    expect(() => loadGraphs(dir)).toThrow(/terminal.*returns/i);
  });

  it("rejects overlapping required/optional keys", () => {
    const dir = writeGraph(`
id: test-overlap
version: "1.0.0"
name: "Test"
description: "Test"
startNode: start
nodes:
  start:
    type: action
    description: "Start"
    returns:
      required:
        key1:
          type: string
      optional:
        key1:
          type: string
    edges:
      - target: done
        label: go
  done:
    type: terminal
    description: "Done"
`);
    expect(() => loadGraphs(dir)).toThrow(/key1.*required.*optional|key1.*both/i);
  });

  it("rejects items on non-array type", () => {
    const dir = writeGraph(`
id: test-items-string
version: "1.0.0"
name: "Test"
description: "Test"
startNode: start
nodes:
  start:
    type: action
    description: "Start"
    returns:
      required:
        name:
          type: string
          items: string
    edges:
      - target: done
        label: go
  done:
    type: terminal
    description: "Done"
`);
    expect(() => loadGraphs(dir)).toThrow(/items.*array/i);
  });

  it("accepts valid return schema", () => {
    const graphs = loadFixtures("valid-returns.workflow.yaml");
    expect(graphs.has("valid-returns")).toBe(true);
    const def = graphs.get("valid-returns")!.definition;
    const implementNode = def.nodes["implement"];
    expect(implementNode.returns).toBeDefined();
    expect(implementNode.returns!.required!.filesChanged.type).toBe("array");
  });
});
