import { describe, expect, it } from "vitest";
import { MalformedInputError } from "../src/errors.js";
import { openAIToAnthropicResponse } from "../src/response.js";
import type { OpenAIChatCompletion } from "../src/types.js";

const base = (): OpenAIChatCompletion => ({
  id: "chatcmpl_1",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-4o",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello!" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
});

describe("openAIToAnthropicResponse — happy paths", () => {
  it("maps a plain text response", () => {
    const out = openAIToAnthropicResponse(base());
    expect(out).toEqual({
      id: "chatcmpl_1",
      type: "message",
      role: "assistant",
      model: "gpt-4o",
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 3 },
    });
  });

  it("maps a tool_calls response", () => {
    const resp = base();
    resp.choices[0]!.message = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Paris"}' },
        },
      ],
    };
    resp.choices[0]!.finish_reason = "tool_calls";
    const out = openAIToAnthropicResponse(resp);
    expect(out.content).toEqual([
      { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
    ]);
    expect(out.stop_reason).toBe("tool_use");
  });

  it("maps mixed text + tool_calls", () => {
    const resp = base();
    resp.choices[0]!.message = {
      role: "assistant",
      content: "I'll check that.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "lookup", arguments: "{}" },
        },
      ],
    };
    resp.choices[0]!.finish_reason = "tool_calls";
    const out = openAIToAnthropicResponse(resp);
    expect(out.content[0]).toEqual({ type: "text", text: "I'll check that." });
    expect(out.content[1]).toEqual({ type: "tool_use", id: "call_1", name: "lookup", input: {} });
  });

  it("maps finish_reason variants", () => {
    const cases: Array<[string | null, string]> = [
      ["stop", "end_turn"],
      ["length", "max_tokens"],
      ["tool_calls", "tool_use"],
      ["content_filter", "end_turn"],
      [null, "end_turn"],
    ];
    for (const [finish, expected] of cases) {
      const resp = base();
      resp.choices[0]!.finish_reason = finish;
      expect(openAIToAnthropicResponse(resp).stop_reason).toBe(expected);
    }
  });

  it("handles empty tool_call arguments as empty object input", () => {
    const resp = base();
    resp.choices[0]!.message = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "noop", arguments: "" },
        },
      ],
    };
    const out = openAIToAnthropicResponse(resp);
    expect(out.content).toEqual([{ type: "tool_use", id: "call_1", name: "noop", input: {} }]);
  });

  it("emits an empty text block when content and tool_calls are absent", () => {
    const resp = base();
    resp.choices[0]!.message = { role: "assistant", content: null };
    const out = openAIToAnthropicResponse(resp);
    expect(out.content).toEqual([{ type: "text", text: "" }]);
  });

  it("treats empty-string content same as null (no text block emitted unless other content)", () => {
    const resp = base();
    resp.choices[0]!.message = {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }],
    };
    const out = openAIToAnthropicResponse(resp);
    expect(out.content).toEqual([{ type: "tool_use", id: "c1", name: "x", input: {} }]);
  });

  it("defaults usage to zeros when missing", () => {
    const resp = base();
    delete (resp as { usage?: unknown }).usage;
    const out = openAIToAnthropicResponse(resp);
    expect(out.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe("openAIToAnthropicResponse — validation", () => {
  it("rejects non-object input", () => {
    expect(() => openAIToAnthropicResponse(null as unknown as OpenAIChatCompletion)).toThrow(
      MalformedInputError,
    );
  });

  it("requires id", () => {
    const resp = base();
    (resp as { id: string }).id = "";
    expect(() => openAIToAnthropicResponse(resp)).toThrow(/id/);
  });

  it("requires model", () => {
    const resp = base();
    (resp as { model: unknown }).model = 42;
    expect(() => openAIToAnthropicResponse(resp)).toThrow(/model/);
  });

  it("requires non-empty choices array", () => {
    const resp = base();
    resp.choices = [];
    expect(() => openAIToAnthropicResponse(resp)).toThrow(/choices/);
    (resp as { choices: unknown }).choices = "nope";
    expect(() => openAIToAnthropicResponse(resp)).toThrow(/choices/);
  });

  it("rejects null choice", () => {
    const resp = base();
    (resp.choices as unknown as unknown[])[0] = null;
    expect(() => openAIToAnthropicResponse(resp)).toThrow(/choice must be an object/);
  });

  it("rejects null message", () => {
    const resp = base();
    (resp.choices[0] as { message: unknown }).message = null;
    expect(() => openAIToAnthropicResponse(resp)).toThrow(/message must be an object/);
  });

  it("rejects tool_call without id", () => {
    const resp = base();
    resp.choices[0]!.message = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "", type: "function", function: { name: "x", arguments: "{}" } }],
    };
    expect(() => openAIToAnthropicResponse(resp)).toThrow(/tool_call.id/);
  });

  it("rejects tool_call without function object", () => {
    const resp = base();
    resp.choices[0]!.message = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: null as unknown as { name: string; arguments: string },
        },
      ],
    };
    expect(() => openAIToAnthropicResponse(resp)).toThrow(/tool_call.function must be an object/);
  });

  it("rejects tool_call without function.name", () => {
    const resp = base();
    resp.choices[0]!.message = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "", arguments: "{}" } }],
    };
    expect(() => openAIToAnthropicResponse(resp)).toThrow(/function.name/);
  });

  it("rejects tool_call with invalid JSON arguments", () => {
    const resp = base();
    resp.choices[0]!.message = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{not json" } }],
    };
    expect(() => openAIToAnthropicResponse(resp)).toThrow(/valid JSON/);
  });
});
