import { describe, expect, it } from "vitest";
import {
  BridgeError,
  InternalInvariantError,
  MalformedInputError,
  UnsupportedFeatureError,
} from "../src/errors.js";

describe("BridgeError", () => {
  it("sets name to BridgeError and preserves message", () => {
    const err = new BridgeError("oops");
    expect(err.name).toBe("BridgeError");
    expect(err.message).toBe("oops");
    expect(err).toBeInstanceOf(Error);
  });

  it("preserves cause when provided", () => {
    const cause = new Error("upstream");
    const err = new BridgeError("wrapped", { cause });
    expect((err as { cause?: unknown }).cause).toBe(cause);
  });

  it("omits cause when not provided", () => {
    const err = new BridgeError("plain");
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });

  it("instanceof works on subclass instances", () => {
    const sub = new MalformedInputError("bad", "field");
    expect(sub).toBeInstanceOf(BridgeError);
    expect(sub).toBeInstanceOf(Error);
  });
});

describe("MalformedInputError", () => {
  it("appends path to message and exposes it", () => {
    const err = new MalformedInputError("required", "messages[0].role");
    expect(err.name).toBe("MalformedInputError");
    expect(err.path).toBe("messages[0].role");
    expect(err.message).toContain("required");
    expect(err.message).toContain("messages[0].role");
  });

  it("passes through cause", () => {
    const cause = new Error("inner");
    const err = new MalformedInputError("bad", "x", { cause });
    expect((err as { cause?: unknown }).cause).toBe(cause);
  });
});

describe("UnsupportedFeatureError", () => {
  it("uses default message when none provided", () => {
    const err = new UnsupportedFeatureError("image");
    expect(err.name).toBe("UnsupportedFeatureError");
    expect(err.feature).toBe("image");
    expect(err.message).toContain("image");
    expect(err.message).toContain("not supported");
  });

  it("respects custom message", () => {
    const err = new UnsupportedFeatureError("vision", "vision blocks land in v0.2");
    expect(err.message).toBe("vision blocks land in v0.2");
    expect(err.feature).toBe("vision");
  });
});

describe("InternalInvariantError", () => {
  it("prefixes message with invariant label", () => {
    const err = new InternalInvariantError("block index went backwards");
    expect(err.name).toBe("InternalInvariantError");
    expect(err.message).toMatch(/Internal invariant violated/);
    expect(err.message).toContain("block index went backwards");
  });
});
