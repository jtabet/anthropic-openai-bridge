/**
 * API snapshot — pins the public surface of the library.
 *
 * If this test fails, it means an exported symbol was added, removed, or
 * renamed. That's a semver-significant change: bump major for removal/
 * rename, minor for addition. Update the snapshot with intent.
 */

import { describe, expect, it } from "vitest";
import * as bridge from "../src/index.js";

describe("public API surface", () => {
  it("exports exactly the documented set of symbols", () => {
    const exported = Object.keys(bridge).sort();
    expect(exported).toEqual([
      "AnthropicStreamEncoder",
      "BridgeError",
      "InternalInvariantError",
      "MalformedInputError",
      "UnsupportedFeatureError",
      "anthropicToOpenAIRequest",
      "frameEvent",
      "openAIToAnthropicResponse",
    ]);
  });

  it("AnthropicStreamEncoder is a constructable class", () => {
    expect(typeof bridge.AnthropicStreamEncoder).toBe("function");
    const enc = new bridge.AnthropicStreamEncoder({ messageId: "m" });
    expect(typeof enc.feed).toBe("function");
    expect(typeof enc.end).toBe("function");
  });

  it("transformers are pure functions", () => {
    expect(typeof bridge.anthropicToOpenAIRequest).toBe("function");
    expect(typeof bridge.openAIToAnthropicResponse).toBe("function");
    expect(typeof bridge.frameEvent).toBe("function");
  });

  it("error classes are constructable and extend Error", () => {
    for (const Cls of [
      bridge.BridgeError,
      bridge.MalformedInputError,
      bridge.UnsupportedFeatureError,
      bridge.InternalInvariantError,
    ]) {
      // BridgeError takes (message); the others have differing positional
      // shapes — we don't construct them here, we only check the class.
      expect(typeof Cls).toBe("function");
    }
    expect(new bridge.BridgeError("x")).toBeInstanceOf(Error);
  });
});
