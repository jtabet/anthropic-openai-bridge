/**
 * Tests for the auto-mode safeguards passthrough (Claude Code v2.1.278+).
 *
 * Covers extractSafeguards (request side) and the verbatim attachment of
 * caller-authored safeguard_results on both the non-streaming response and
 * the final message_delta of the stream. Fixtures mirror Continuum's
 * protocol capture and LiteLLM's verification request.
 */
import { describe, expect, it } from "vitest";
import { MalformedInputError } from "../src/errors.js";
import { openAIToAnthropicResponse } from "../src/response.js";
import { extractSafeguards } from "../src/safeguards.js";
import { AnthropicStreamEncoder } from "../src/stream.js";
import type { OpenAIChatCompletion, OpenAIChatCompletionChunk } from "../src/types.js";

const capturedRequestSafeguards = [
  {
    type: "dangerous_tool_use",
    classifier_context: { v: 1, permission_mode: "auto" },
  },
];

const capturedVerdicts = [
  {
    type: "dangerous_tool_use",
    status: {
      type: "available",
      tool_uses: {
        toolu_01: { type: "evaluated", outcome: "not_flagged" },
        toolu_02: { type: "evaluated", outcome: "flagged" },
      },
    },
  },
];

describe("extractSafeguards", () => {
  it("returns undefined when the field is absent", () => {
    expect(extractSafeguards({ model: "x", max_tokens: 1, messages: [] })).toBeUndefined();
    expect(extractSafeguards(null)).toBeUndefined();
    expect(extractSafeguards(undefined)).toBeUndefined();
    expect(extractSafeguards("not an object")).toBeUndefined();
  });

  it("returns the array unchanged from the raw body", () => {
    const body = { safeguards: capturedRequestSafeguards, model: "x" };
    expect(extractSafeguards(body)).toEqual(capturedRequestSafeguards);
  });

  it("throws MalformedInputError when present but not an array", () => {
    expect(() => extractSafeguards({ safeguards: { type: "dangerous_tool_use" } })).toThrow(
      MalformedInputError,
    );
  });

  it("throws MalformedInputError when an entry is not an object", () => {
    expect(() => extractSafeguards({ safeguards: ["nope"] })).toThrow(MalformedInputError);
    expect(() => extractSafeguards({ safeguards: [null] })).toThrow(MalformedInputError);
  });

  it("accepts an empty array (no checks requested)", () => {
    expect(extractSafeguards({ safeguards: [] })).toEqual([]);
  });
});

describe("openAIToAnthropicResponse — safeguard attach", () => {
  const base = (): OpenAIChatCompletion => ({
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o",
    choices: [
      { index: 0, message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  });

  it("omits safeguard_results when no option is passed (pre-0.4 shape)", () => {
    const out = openAIToAnthropicResponse(base());
    expect("safeguard_results" in out).toBe(false);
  });

  it("omits safeguard_results for an empty array (graceful degraded mode)", () => {
    const out = openAIToAnthropicResponse(base(), { safeguardResults: [] });
    expect("safeguard_results" in out).toBe(false);
  });

  it("attaches caller-authored verdicts verbatim", () => {
    const out = openAIToAnthropicResponse(base(), { safeguardResults: capturedVerdicts });
    expect(out.safeguard_results).toEqual(capturedVerdicts);
    // Rest of the shape untouched.
    expect(out.content).toEqual([{ type: "text", text: "Hello!" }]);
    expect(out.stop_reason).toBe("end_turn");
  });

  it("passes the same array by reference (verbatim, no clone/reorder)", () => {
    const arr = capturedVerdicts;
    const out = openAIToAnthropicResponse(base(), { safeguardResults: arr });
    expect(out.safeguard_results).toBe(arr);
  });
});

describe("AnthropicStreamEncoder — safeguard attach on message_delta", () => {
  const chunk = (extra?: Partial<OpenAIChatCompletionChunk>): OpenAIChatCompletionChunk => ({
    id: "c_1",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "gpt-4o",
    choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
    ...extra,
  });

  const feedAll = (enc: AnthropicStreamEncoder) => {
    const lines = [
      ...enc.feed(chunk()),
      ...enc.feed(chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })),
      ...enc.end(),
    ];
    return lines.map((l) => {
      const m = /data: (.*)\n/.exec(l);
      if (!m) throw new Error(`unparseable SSE frame: ${JSON.stringify(l)}`);
      return JSON.parse(m[1]!) as { type: string; delta?: Record<string, unknown> };
    });
  };

  it("final message_delta carries no safeguard_results by default", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m1" });
    const events = feedAll(enc);
    const delta = events.find((e) => e.type === "message_delta")!;
    expect("safeguard_results" in (delta.delta ?? {})).toBe(false);
  });

  it("attaches verdicts inside the final message_delta delta", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m2", safeguardResults: capturedVerdicts });
    const events = feedAll(enc);
    const delta = events.find((e) => e.type === "message_delta")!;
    expect(delta.delta!.safeguard_results).toEqual(capturedVerdicts);
    // stop_reason/usage unchanged
    expect(delta.delta!.stop_reason).toBe("end_turn");
  });

  it("omits for an empty array", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m3", safeguardResults: [] });
    const events = feedAll(enc);
    const delta = events.find((e) => e.type === "message_delta")!;
    expect("safeguard_results" in (delta.delta ?? {})).toBe(false);
  });
});
