import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveSourceRoot } from "../src/graph-resolution.js";

describe("resolveSourceRoot", () => {
  it("returns parent of first graphsDir by default", () => {
    const result = resolveSourceRoot(["/workspace/dev-docs/.freelance"]);
    expect(result).toBe("/workspace/dev-docs");
  });

  it("returns parent of first graphsDir when multiple dirs provided", () => {
    const result = resolveSourceRoot([
      "/workspace/project/.freelance",
      "/home/user/.freelance",
    ]);
    expect(result).toBe("/workspace/project");
  });

  it("uses explicit override when provided", () => {
    const result = resolveSourceRoot(
      ["/workspace/project/.freelance"],
      "/custom/root"
    );
    expect(result).toBe(path.resolve("/custom/root"));
  });

  it("explicit override takes precedence over graphsDirs", () => {
    const result = resolveSourceRoot(
      ["/workspace/project/.freelance"],
      "/other/base"
    );
    expect(result).toBe(path.resolve("/other/base"));
  });

  it("returns undefined when no graphsDirs and no explicit", () => {
    const result = resolveSourceRoot([]);
    expect(result).toBeUndefined();
  });

  it("returns explicit even when graphsDirs is empty", () => {
    const result = resolveSourceRoot([], "/explicit/root");
    expect(result).toBe(path.resolve("/explicit/root"));
  });
});
