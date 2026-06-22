import { describe, expect, it } from "vitest";
import { EngineError } from "../src/errors.js";
import { GUIDE_TOPICS, getGuide, getGuideTopics } from "../src/guide.js";

describe("freelance guide", () => {
  it("getGuideTopics returns all topics", () => {
    const topics = getGuideTopics();
    expect(topics).toHaveLength(GUIDE_TOPICS.length);
    expect(topics).toContain("basics");
    expect(topics).toContain("conventions");
    expect(topics).toContain("gates");
    expect(topics).toContain("onenter-hooks");
    expect(topics).toContain("meta");
    expect(topics).toContain("anti-patterns");
  });

  it("getGuide with no topic returns catalog with a structured topic list", () => {
    const result = getGuide();
    expect("topics" in result).toBe(true);
    if ("topics" in result) {
      // #304: agents enumerate topics from the structured array, not by
      // parsing the markdown blob.
      expect(result.topics).toEqual([...GUIDE_TOPICS]);
      expect(result.content).toContain("Available topics");
    }
  });

  it("getGuide with valid topic returns content", () => {
    const result = getGuide("basics");
    expect("content" in result).toBe(true);
    expect(result.content).toContain("Graph Basics");
    expect(result.content).toContain("freelance status");
  });

  it("getGuide with unknown topic throws TOPIC_NOT_FOUND with topics in envelopeSlots", () => {
    // #305/#306: throws a catalogued EngineError; the valid-topic list
    // lives in envelopeSlots, not baked into error.message prose.
    try {
      getGuide("nonexistent");
      expect.unreachable("getGuide should throw on an unknown topic");
    } catch (e) {
      expect(e).toBeInstanceOf(EngineError);
      const err = e as EngineError;
      expect(err.code).toBe("TOPIC_NOT_FOUND");
      expect(err.message).toContain("nonexistent");
      expect(err.context?.envelopeSlots?.availableTopics).toEqual([...GUIDE_TOPICS]);
    }
  });

  it("each topic has non-empty content", () => {
    for (const topic of GUIDE_TOPICS) {
      const result = getGuide(topic);
      expect(result.content.length, `${topic} should have content`).toBeGreaterThan(50);
    }
  });
});
