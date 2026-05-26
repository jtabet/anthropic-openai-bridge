import { beforeEach, describe, expect, it } from "vitest";
import { InternalInvariantError, MalformedInputError } from "../src/errors.js";
import { AnthropicStreamEncoder, __resetIdCounterForTests } from "../src/stream.js";
import type { AnthropicStreamEvent, OpenAIChatCompletionChunk } from "../src/types.js";

beforeEach(() => {
  __resetIdCounterForTests();
});

/**
 * Parse a flat list of SSE event strings back into Anthropic event objects.
 * Each input string is exactly one frame ("event: ...\ndata: ...\n\n").
 */
function parseEvents(frames: string[]): AnthropicStreamEvent[] {
  return frames.map((frame, i) => {
    const lines = frame.split("\n");
    expect(lines[0]?.startsWith("event: "), `frame ${i} missing event:`).toBe(true);
    expect(lines[1]?.startsWith("data: "), `frame ${i} missing data:`).toBe(true);
    expect(lines[2], `frame ${i} missing trailing blank`).toBe("");
    return JSON.parse((lines[1] as string).slice("data: ".length));
  });
}

function chunk(
  partial: Partial<OpenAIChatCompletionChunk["choices"][number]>,
  extra: Partial<OpenAIChatCompletionChunk> = {},
): OpenAIChatCompletionChunk {
  return {
    id: "chatcmpl_x",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: null,
        ...partial,
      },
    ],
    ...extra,
  };
}

describe("AnthropicStreamEncoder — text-only stream", () => {
  it("emits message_start, single text block, message_delta(end_turn), message_stop", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "msg_test" });
    const frames: string[] = [];
    frames.push(...enc.feed(chunk({ delta: { role: "assistant", content: "Hel" } })));
    frames.push(...enc.feed(chunk({ delta: { content: "lo!" } })));
    frames.push(
      ...enc.feed(
        chunk(
          { delta: {}, finish_reason: "stop" },
          { usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
        ),
      ),
    );
    frames.push(...enc.end());

    const events = parseEvents(frames);

    expect(events[0]).toMatchObject({
      type: "message_start",
      message: { id: "msg_test", role: "assistant", content: [], stop_reason: null },
    });
    expect(events[1]).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    expect(events[2]).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hel" },
    });
    expect(events[3]).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "lo!" },
    });
    expect(events[4]).toEqual({ type: "content_block_stop", index: 0 });
    expect(events[5]).toEqual({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    });
    expect(events[6]).toEqual({ type: "message_stop" });
    expect(events.length).toBe(7);
  });

  it("skips empty/whitespace content deltas as no-op (no extra deltas)", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    const frames: string[] = [];
    frames.push(...enc.feed(chunk({ delta: { role: "assistant" } })));
    frames.push(...enc.feed(chunk({ delta: { content: "" } })));
    frames.push(...enc.feed(chunk({ delta: { content: null } })));
    frames.push(...enc.feed(chunk({ delta: { content: "Hi" } })));
    frames.push(...enc.end());

    const events = parseEvents(frames);
    // message_start, content_block_start, content_block_delta(Hi),
    // content_block_stop, message_delta, message_stop = 6
    expect(events.length).toBe(6);
    expect(events[2]).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hi" },
    });
  });
});

describe("AnthropicStreamEncoder — single tool_call stream", () => {
  it("opens tool_use block, emits arg deltas, closes with tool_use stop_reason", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    const frames: string[] = [];

    // Standard OpenAI shape: first chunk has id+name; subsequent chunks stream args.
    frames.push(
      ...enc.feed(
        chunk({
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: "" },
              },
            ],
          },
        }),
      ),
    );
    frames.push(
      ...enc.feed(
        chunk({
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] },
        }),
      ),
    );
    frames.push(
      ...enc.feed(
        chunk({
          delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }] },
        }),
      ),
    );
    frames.push(...enc.feed(chunk({ delta: {}, finish_reason: "tool_calls" })));
    frames.push(...enc.end());

    const events = parseEvents(frames);
    expect(events[0]?.type).toBe("message_start");
    expect(events[1]).toEqual({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "call_1", name: "get_weather", input: {} },
    });
    // Note: when arguments is empty string on the opener, no delta is emitted.
    expect(events[2]).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"ci' },
    });
    expect(events[3]).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: 'ty":"Paris"}' },
    });
    expect(events[4]).toEqual({ type: "content_block_stop", index: 0 });
    expect(events[5]).toEqual({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 0 },
    });
    expect(events[6]).toEqual({ type: "message_stop" });
  });

  it("flushes pre-buffered argument bytes when name/id arrive late", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    const frames: string[] = [];
    // Arguments-only chunk first (rare, but defensive).
    frames.push(
      ...enc.feed(
        chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }),
      ),
    );
    // Then the chunk with id+name.
    frames.push(
      ...enc.feed(
        chunk({
          delta: {
            tool_calls: [{ index: 0, id: "call_x", function: { name: "foo", arguments: "1}" } }],
          },
        }),
      ),
    );
    frames.push(...enc.feed(chunk({ delta: {}, finish_reason: "tool_calls" })));
    frames.push(...enc.end());

    const events = parseEvents(frames);
    const blockStart = events.find((e) => e.type === "content_block_start");
    expect(blockStart).toMatchObject({
      content_block: { type: "tool_use", id: "call_x", name: "foo" },
    });
    const deltas = events.filter((e) => e.type === "content_block_delta");
    // Combined buffer + tail in one delta on open.
    expect(deltas[0]).toMatchObject({ delta: { partial_json: '{"a":1}' } });
  });

  it("defers when only id arrives without name", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    // First chunk: id only, no name.
    const frames1 = enc.feed(
      chunk({ delta: { tool_calls: [{ index: 0, id: "call_z", function: { arguments: "" } }] } }),
    );
    // No block_start yet.
    expect(frames1.filter((f) => f.includes("content_block_start")).length).toBe(0);
    // Now name arrives.
    const frames2 = enc.feed(
      chunk({ delta: { tool_calls: [{ index: 0, function: { name: "bar", arguments: "{}" } }] } }),
    );
    const events = parseEvents([...frames1, ...frames2]);
    expect(events.find((e) => e.type === "content_block_start")).toMatchObject({
      content_block: { id: "call_z", name: "bar" },
    });
  });
});

describe("AnthropicStreamEncoder — multi-tool-call stream", () => {
  it("opens and closes tool_use blocks for two tool calls sequentially", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    const frames: string[] = [];
    frames.push(
      ...enc.feed(
        chunk({
          delta: {
            tool_calls: [
              { index: 0, id: "c0", type: "function", function: { name: "a", arguments: "{}" } },
            ],
          },
        }),
      ),
    );
    frames.push(
      ...enc.feed(
        chunk({
          delta: {
            tool_calls: [
              {
                index: 1,
                id: "c1",
                type: "function",
                function: { name: "b", arguments: '{"x":1}' },
              },
            ],
          },
        }),
      ),
    );
    frames.push(...enc.feed(chunk({ delta: {}, finish_reason: "tool_calls" })));
    frames.push(...enc.end());

    const events = parseEvents(frames);
    const starts = events.filter((e) => e.type === "content_block_start");
    expect(starts.length).toBe(2);
    expect(starts[0]).toMatchObject({ index: 0, content_block: { name: "a" } });
    expect(starts[1]).toMatchObject({ index: 1, content_block: { name: "b" } });
    // Stops appear in order: stop(0) before start(1), then stop(1) at end.
    const stops = events.filter((e) => e.type === "content_block_stop");
    expect(stops).toEqual([
      { type: "content_block_stop", index: 0 },
      { type: "content_block_stop", index: 1 },
    ]);
  });
});

describe("AnthropicStreamEncoder — mixed text → tool_use → text", () => {
  it("emits stop/start transitions correctly across kind changes", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    const frames: string[] = [];
    frames.push(...enc.feed(chunk({ delta: { role: "assistant", content: "I'll check." } })));
    frames.push(
      ...enc.feed(
        chunk({
          delta: {
            tool_calls: [{ index: 0, id: "c0", function: { name: "lookup", arguments: "{}" } }],
          },
        }),
      ),
    );
    frames.push(...enc.feed(chunk({ delta: { content: "Done." } })));
    frames.push(...enc.feed(chunk({ delta: {}, finish_reason: "stop" })));
    frames.push(...enc.end());

    const events = parseEvents(frames);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "message_start",
      "content_block_start", // text
      "content_block_delta", // "I'll check."
      "content_block_stop", // close text
      "content_block_start", // tool_use
      "content_block_delta", // input_json_delta "{}"
      "content_block_stop", // close tool_use
      "content_block_start", // text again (index 2)
      "content_block_delta", // "Done."
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    // Verify text block indices increment.
    const starts = events.filter((e) => e.type === "content_block_start");
    expect(starts[0]).toMatchObject({ index: 0, content_block: { type: "text" } });
    expect(starts[1]).toMatchObject({ index: 1, content_block: { type: "tool_use" } });
    expect(starts[2]).toMatchObject({ index: 2, content_block: { type: "text" } });
  });
});

describe("AnthropicStreamEncoder — edge cases", () => {
  it("end() with no feed() still emits a valid event sequence", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    const events = parseEvents(enc.end());
    expect(events.map((e) => e.type)).toEqual(["message_start", "message_delta", "message_stop"]);
  });

  it("end() is idempotent", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    enc.end();
    expect(enc.end()).toEqual([]);
  });

  it("feed() after end() throws InternalInvariantError", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    enc.end();
    expect(() => enc.feed(chunk({ delta: { content: "x" } }))).toThrow(InternalInvariantError);
  });

  it("rejects non-object chunk", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    expect(() => enc.feed(null as unknown as OpenAIChatCompletionChunk)).toThrow(
      MalformedInputError,
    );
  });

  it("rejects chunk with non-array choices", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    const bad = {
      ...chunk({ delta: {} }),
      choices: "nope",
    } as unknown as OpenAIChatCompletionChunk;
    expect(() => enc.feed(bad)).toThrow(MalformedInputError);
  });

  it("rejects null choice within choices", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    const bad = chunk({ delta: {} });
    (bad.choices as unknown as unknown[])[0] = null;
    expect(() => enc.feed(bad)).toThrow(/choice/);
  });

  it("rejects tool_call delta missing index", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    expect(() =>
      enc.feed(
        chunk({
          delta: {
            tool_calls: [
              {
                id: "x",
              } as unknown as OpenAIChatCompletionChunk["choices"][number]["delta"]["tool_calls"] extends Array<
                infer T
              >
                ? T
                : never,
            ],
          },
        }),
      ),
    ).toThrow(MalformedInputError);
  });

  it("captures usage from a no-choices chunk (some providers emit a final usage frame)", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    enc.feed(chunk({ delta: { content: "Hi" }, finish_reason: "stop" }));
    enc.feed({
      id: "x",
      object: "chat.completion.chunk",
      created: 0,
      model: "gpt-4o",
      choices: [],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    });
    const events = parseEvents(enc.end());
    const messageDelta = events.find((e) => e.type === "message_delta");
    expect(messageDelta).toMatchObject({ usage: { output_tokens: 1 } });
  });

  it("falls back to model from first chunk when no override", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    const events = parseEvents([
      ...enc.feed({ ...chunk({ delta: { content: "x" } }), model: "ollama/qwen3" }),
      ...enc.end(),
    ]);
    expect(events[0]).toMatchObject({ message: { model: "ollama/qwen3" } });
  });

  it("uses modelOverride when provided", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m", modelOverride: "claude-sonnet-4-6" });
    const events = parseEvents([
      ...enc.feed({ ...chunk({ delta: { content: "x" } }), model: "ollama/qwen3" }),
      ...enc.end(),
    ]);
    expect(events[0]).toMatchObject({ message: { model: "claude-sonnet-4-6" } });
  });

  it("falls back to 'unknown' model when end() called without any feed", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    const events = parseEvents(enc.end());
    expect(events[0]).toMatchObject({ message: { model: "unknown" } });
  });

  it("falls back to 'unknown' model when first chunk has non-string model", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    const ch = chunk({ delta: { content: "hi" } });
    (ch as { model: unknown }).model = undefined;
    const events = parseEvents([...enc.feed(ch), ...enc.end()]);
    expect(events[0]).toMatchObject({ message: { model: "unknown" } });
  });

  it("deferred tool call without function.arguments still updates meta only", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    const frames: string[] = [];
    // First chunk: id only, no name, no function.arguments
    frames.push(...enc.feed(chunk({ delta: { tool_calls: [{ index: 0, id: "c" }] } })));
    // Second chunk: name arrives, still no arguments
    frames.push(
      ...enc.feed(chunk({ delta: { tool_calls: [{ index: 0, function: { name: "n" } }] } })),
    );
    frames.push(...enc.end());
    const events = parseEvents(frames);
    const start = events.find((e) => e.type === "content_block_start");
    expect(start).toMatchObject({ content_block: { type: "tool_use", id: "c", name: "n" } });
    // No input_json_delta emitted since args never arrived.
    expect(events.find((e) => e.type === "content_block_delta")).toBeUndefined();
  });

  it("tool call open chunk with only function present (no arguments key) does not crash", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    const frames: string[] = [];
    frames.push(
      ...enc.feed(
        chunk({
          delta: { tool_calls: [{ index: 0, id: "c", function: { name: "n" } }] },
        }),
      ),
    );
    frames.push(...enc.end());
    const events = parseEvents(frames);
    expect(events.find((e) => e.type === "content_block_start")).toMatchObject({
      content_block: { type: "tool_use", id: "c", name: "n", input: {} },
    });
  });

  it("subsequent tool call delta without function field is a no-op", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    enc.feed(
      chunk({
        delta: {
          tool_calls: [{ index: 0, id: "c", function: { name: "n", arguments: "{}" } }],
        },
      }),
    );
    const frames = enc.feed(chunk({ delta: { tool_calls: [{ index: 0 }] } }));
    // No new events from the empty follow-up.
    expect(frames).toEqual([]);
  });

  it("synthesizes a message id when none provided", () => {
    const enc = new AnthropicStreamEncoder();
    const events = parseEvents(enc.end());
    expect((events[0] as { message: { id: string } }).message.id).toMatch(/^msg_/);
  });

  it("uses provided idGenerator over messageId", () => {
    const enc = new AnthropicStreamEncoder({
      messageId: "shouldBeIgnored",
      idGenerator: () => "gen_id_42",
    });
    const events = parseEvents(enc.end());
    expect((events[0] as { message: { id: string } }).message.id).toBe("gen_id_42");
  });

  it("missing finish_reason results in end_turn default", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    enc.feed(chunk({ delta: { content: "x" } }));
    const events = parseEvents(enc.end());
    expect(events.find((e) => e.type === "message_delta")).toMatchObject({
      delta: { stop_reason: "end_turn" },
    });
  });

  it("throws if a tool_call delta arrives for an already-closed block", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    // Open tool_call 0
    enc.feed(
      chunk({
        delta: {
          tool_calls: [{ index: 0, id: "c0", function: { name: "a", arguments: "{}" } }],
        },
      }),
    );
    // Open tool_call 1 (closes 0)
    enc.feed(
      chunk({
        delta: {
          tool_calls: [{ index: 1, id: "c1", function: { name: "b", arguments: "{}" } }],
        },
      }),
    );
    // Adversarial: delta for 0 again with args.
    expect(() =>
      enc.feed(chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: "x" } }] } })),
    ).toThrow(InternalInvariantError);
  });

  it("zero-argument-delta on existing block is a no-op", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    enc.feed(
      chunk({
        delta: {
          tool_calls: [{ index: 0, id: "c0", function: { name: "a", arguments: '{"k":1}' } }],
        },
      }),
    );
    const before: string[] = [];
    const after = enc.feed(
      chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: "" } }] } }),
    );
    before.push(...after);
    // No new SSE frames produced for the empty-args follow-up.
    expect(before).toEqual([]);
  });

  it("handles delta with both content and tool_calls in the same chunk", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    const frames: string[] = [];
    frames.push(
      ...enc.feed(
        chunk({
          delta: {
            content: "Looking up.",
            tool_calls: [{ index: 0, id: "c0", function: { name: "x", arguments: "{}" } }],
          },
        }),
      ),
    );
    frames.push(...enc.feed(chunk({ delta: {}, finish_reason: "tool_calls" })));
    frames.push(...enc.end());

    const events = parseEvents(frames);
    // Expect text block first, then tool_use block.
    expect(events[1]).toMatchObject({
      type: "content_block_start",
      content_block: { type: "text" },
    });
    expect(events[3]).toMatchObject({ type: "content_block_stop", index: 0 });
    expect(events[4]).toMatchObject({
      type: "content_block_start",
      content_block: { type: "tool_use" },
    });
  });

  it("handles a chunk with delta=undefined gracefully", () => {
    const enc = new AnthropicStreamEncoder({ messageId: "m" });
    const ch = chunk({ delta: {} });
    (ch.choices[0] as { delta: unknown }).delta = undefined;
    const frames = enc.feed(ch);
    // Only message_start fires.
    expect(frames.length).toBe(1);
  });
});
