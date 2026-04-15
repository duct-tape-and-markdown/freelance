import { describe, expect, it } from "vitest";
import { GUIDE_TOPICS, getGuide, getGuideTopics } from "../src/guide.js";

describe("freelance_guide", () => {
  it("getGuideTopics returns all 9 topics", () => {
    const topics = getGuideTopics();
    expect(topics).toHaveLength(9);
    expect(topics).toContain("basics");
    expect(topics).toContain("conventions");
    expect(topics).toContain("gates");
    expect(topics).toContain("onenter-hooks");
    expect(topics).toContain("anti-patterns");
  });

  it("getGuide with no topic returns catalog", () => {
    const result = getGuide();
    expect("content" in result).toBe(true);
    if ("content" in result) {
      expect(result.content).toContain("Available topics");
      for (const topic of GUIDE_TOPICS) {
        expect(result.content).toContain(topic);
      }
    }
  });

  it("getGuide with valid topic returns content", () => {
    const result = getGuide("basics");
    expect("content" in result).toBe(true);
    if ("content" in result) {
      expect(result.content).toContain("Graph Basics");
      expect(result.content).toContain("freelance_list");
    }
  });

  it("getGuide with unknown topic returns error", () => {
    const result = getGuide("nonexistent");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("nonexistent");
      expect(result.error).toContain("Available");
    }
  });

  it("each topic has non-empty content", () => {
    for (const topic of GUIDE_TOPICS) {
      const result = getGuide(topic);
      expect("content" in result, `${topic} should return content`).toBe(true);
      if ("content" in result) {
        expect(result.content.length, `${topic} should have content`).toBeGreaterThan(50);
      }
    }
  });
});
