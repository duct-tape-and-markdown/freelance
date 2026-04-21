import { describe, expect, it } from "vitest";
import { lintRequiredMeta } from "../src/graph-validation.js";
import type { GraphDefinition } from "../src/schema/graph-schema.js";

/**
 * Build a minimal GraphDefinition with the fields lintRequiredMeta reads.
 * Other fields are filled with schema-valid defaults; the lint doesn't
 * look at them, so tests don't need to mirror full authoring shape.
 */
function defWith(
  overrides: Partial<GraphDefinition> & { requiredMeta?: string[] },
): GraphDefinition {
  return {
    id: "test-graph",
    version: "1.0.0",
    name: "Test",
    description: "Default description with no mentioned keys.",
    startNode: "start",
    strictContext: false,
    nodes: {
      start: { type: "action", description: "start", edges: [{ target: "done", label: "next" }] },
      done: { type: "terminal", description: "done" },
    },
    ...overrides,
  } as GraphDefinition;
}

describe("lintRequiredMeta", () => {
  it("returns no warnings when requiredMeta is absent", () => {
    const def = defWith({});
    expect(lintRequiredMeta(def, "graph.yaml")).toEqual([]);
  });

  it("returns no warnings when requiredMeta is an empty array", () => {
    const def = defWith({ requiredMeta: [] });
    expect(lintRequiredMeta(def, "graph.yaml")).toEqual([]);
  });

  it("warns when a requiredMeta key is neither mentioned nor set by onEnter", () => {
    const def = defWith({
      requiredMeta: ["externalKey"],
      description: "A delivery workflow with no documented caller contract.",
    });
    const warnings = lintRequiredMeta(def, "graph.yaml");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      file: "graph.yaml",
      rule: "required-meta-reachability",
    });
    expect(warnings[0].message).toContain("externalKey");
    expect(warnings[0].message).toContain("start");
  });

  it("does not warn when the description mentions the key (escape hatch: documentation)", () => {
    const def = defWith({
      requiredMeta: ["externalKey"],
      description: "Graph requires meta.externalKey at start; caller must supply it.",
    });
    expect(lintRequiredMeta(def, "graph.yaml")).toEqual([]);
  });

  it("does not warn when the start-node onEnter meta_set sets the key (escape hatch: hook)", () => {
    const def = defWith({
      requiredMeta: ["externalKey"],
      description: "Undocumented — but the start node's hook derives the key.",
      nodes: {
        start: {
          type: "action",
          description: "start",
          onEnter: [{ call: "meta_set", args: { externalKey: "context.ticketId" } }],
          edges: [{ target: "done", label: "next" }],
        },
        done: { type: "terminal", description: "done" },
      },
    });
    expect(lintRequiredMeta(def, "graph.yaml")).toEqual([]);
  });

  it("warns on only the unreachable key when requiredMeta has mixed coverage", () => {
    const def = defWith({
      requiredMeta: ["externalKey", "prUrl"],
      description: "Mentions externalKey but not the other one.",
      nodes: {
        start: {
          type: "action",
          description: "start",
          edges: [{ target: "done", label: "next" }],
        },
        done: { type: "terminal", description: "done" },
      },
    });
    const warnings = lintRequiredMeta(def, "graph.yaml");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("prUrl");
    expect(warnings[0].message).not.toContain('"externalKey"');
  });

  it("treats a meta_set hook on a non-start node as not covering requiredMeta", () => {
    // requiredMeta is enforced at start, *after* start-node onEnter hooks
    // fire. Hooks on other nodes run too late to satisfy the check.
    const def = defWith({
      requiredMeta: ["externalKey"],
      description: "No mention; only a non-start node sets it.",
      nodes: {
        start: {
          type: "action",
          description: "start",
          edges: [{ target: "mid", label: "next" }],
        },
        mid: {
          type: "action",
          description: "mid",
          onEnter: [{ call: "meta_set", args: { externalKey: "context.ticketId" } }],
          edges: [{ target: "done", label: "next" }],
        },
        done: { type: "terminal", description: "done" },
      },
    });
    const warnings = lintRequiredMeta(def, "graph.yaml");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("externalKey");
  });

  it("ignores non-meta_set hooks on the start node (e.g. memory_status) when checking coverage", () => {
    const def = defWith({
      requiredMeta: ["externalKey"],
      description: "No mention; start-node hook is not meta_set.",
      nodes: {
        start: {
          type: "action",
          description: "start",
          onEnter: [{ call: "memory_status", args: { externalKey: "ignored" } }],
          edges: [{ target: "done", label: "next" }],
        },
        done: { type: "terminal", description: "done" },
      },
    });
    const warnings = lintRequiredMeta(def, "graph.yaml");
    expect(warnings).toHaveLength(1);
  });

  it("uses whole-word matching so substrings in the description don't falsely satisfy the lint", () => {
    // "externalKey" must be a whole-word mention, not a substring of e.g.
    // "externalKeyring", to be a reliable signal that the caller contract
    // is documented.
    const def = defWith({
      requiredMeta: ["externalKey"],
      description: "The externalKeyring container manages keys.",
    });
    const warnings = lintRequiredMeta(def, "graph.yaml");
    expect(warnings).toHaveLength(1);
  });
});
