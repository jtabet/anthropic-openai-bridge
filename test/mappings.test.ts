import { describe, expect, it } from "vitest";
import {
  type AnthropicToolChoice,
  finishReasonToStopReason,
  mapToolChoice,
} from "../src/mappings.js";

describe("finishReasonToStopReason", () => {
  it.each([
    ["stop", "end_turn"],
    ["length", "max_tokens"],
    ["tool_calls", "tool_use"],
    ["function_call", "tool_use"],
    ["content_filter", "end_turn"],
    ["unknown_future_value", "end_turn"],
  ] as const)("maps %s -> %s", (input, expected) => {
    expect(finishReasonToStopReason(input)).toBe(expected);
  });

  it("maps null/undefined to end_turn", () => {
    expect(finishReasonToStopReason(null)).toBe("end_turn");
    expect(finishReasonToStopReason(undefined)).toBe("end_turn");
  });
});

describe("mapToolChoice", () => {
  it("returns undefined when input is undefined", () => {
    expect(mapToolChoice(undefined)).toBeUndefined();
  });

  it("maps auto to 'auto'", () => {
    expect(mapToolChoice({ type: "auto" })).toBe("auto");
  });

  it("maps any to 'required'", () => {
    expect(mapToolChoice({ type: "any" })).toBe("required");
  });

  it("maps none to 'none'", () => {
    expect(mapToolChoice({ type: "none" })).toBe("none");
  });

  it("maps tool to function-typed object preserving name", () => {
    const result = mapToolChoice({ type: "tool", name: "get_weather" });
    expect(result).toEqual({ type: "function", function: { name: "get_weather" } });
  });

  it("ignores disable_parallel_tool_use field on inputs", () => {
    const input: AnthropicToolChoice = { type: "auto", disable_parallel_tool_use: true };
    expect(mapToolChoice(input)).toBe("auto");
  });
});
