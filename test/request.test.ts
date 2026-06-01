import { describe, expect, it } from "vitest";
import { MalformedInputError, UnsupportedFeatureError } from "../src/errors.js";
import { anthropicToOpenAIRequest } from "../src/request.js";
import type { AnthropicImageBlock, AnthropicMessagesRequest } from "../src/types.js";

const base = (): AnthropicMessagesRequest => ({
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello" }],
});

describe("anthropicToOpenAIRequest — required fields", () => {
  it("rejects non-object input", () => {
    expect(() => anthropicToOpenAIRequest(null as unknown as AnthropicMessagesRequest)).toThrow(
      MalformedInputError,
    );
    expect(() => anthropicToOpenAIRequest("nope" as unknown as AnthropicMessagesRequest)).toThrow(
      /object/,
    );
  });

  it("requires model", () => {
    const req = base();
    (req as { model?: string }).model = "";
    expect(() => anthropicToOpenAIRequest(req)).toThrow(/model/);
  });

  it("requires positive max_tokens", () => {
    const req = base();
    req.max_tokens = 0;
    expect(() => anthropicToOpenAIRequest(req)).toThrow(/max_tokens/);
    req.max_tokens = Number.NaN;
    expect(() => anthropicToOpenAIRequest(req)).toThrow(/max_tokens/);
    req.max_tokens = -1;
    expect(() => anthropicToOpenAIRequest(req)).toThrow(/max_tokens/);
  });

  it("requires non-empty messages array", () => {
    const req = base();
    req.messages = [];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(/messages/);
    (req as { messages: unknown }).messages = "nope";
    expect(() => anthropicToOpenAIRequest(req)).toThrow(/messages/);
  });
});

describe("anthropicToOpenAIRequest — system prompt", () => {
  it("passes through a plain-string system", () => {
    const req = base();
    req.system = "You are helpful.";
    const out = anthropicToOpenAIRequest(req);
    expect(out.messages[0]).toEqual({ role: "system", content: "You are helpful." });
  });

  it("concatenates text-block array system with double newlines", () => {
    const req = base();
    req.system = [
      { type: "text", text: "Line one." },
      { type: "text", text: "Line two." },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect(out.messages[0]).toEqual({ role: "system", content: "Line one.\n\nLine two." });
  });

  it("skips the system message when system is an empty string", () => {
    const req = base();
    req.system = "";
    const out = anthropicToOpenAIRequest(req);
    expect(out.messages[0]?.role).toBe("user");
  });

  it("rejects malformed system shape", () => {
    const req = base();
    (req as { system?: unknown }).system = 42;
    expect(() => anthropicToOpenAIRequest(req)).toThrow(MalformedInputError);
  });

  it("rejects non-text blocks in system", () => {
    const req = base();
    (req as { system?: unknown }).system = [{ type: "image" }];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(MalformedInputError);
  });

  it("rejects null blocks in system array", () => {
    const req = base();
    (req as { system?: unknown }).system = [null];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(MalformedInputError);
  });
});

describe("anthropicToOpenAIRequest — message conversion", () => {
  it("passes through string user content", () => {
    const out = anthropicToOpenAIRequest(base());
    expect(out.messages[0]).toEqual({ role: "user", content: "Hello" });
  });

  it("passes through string assistant content", () => {
    const req = base();
    req.messages = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect(out.messages[1]).toEqual({ role: "assistant", content: "Hello!" });
  });

  it("concatenates multiple text blocks in a user message", () => {
    const req = base();
    req.messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Part 1." },
          { type: "text", text: "Part 2." },
        ],
      },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect(out.messages[0]).toEqual({ role: "user", content: "Part 1.\n\nPart 2." });
  });

  it("emits assistant text + tool_calls when both present", () => {
    const req = base();
    req.messages = [
      { role: "user", content: "What's the weather?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Paris" } },
        ],
      },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect(out.messages[1]).toEqual({
      role: "assistant",
      content: "Let me check.",
      tool_calls: [
        {
          id: "tu_1",
          type: "function",
          function: { name: "get_weather", arguments: JSON.stringify({ city: "Paris" }) },
        },
      ],
    });
  });

  it("emits assistant message with null content when only tool_use present", () => {
    const req = base();
    req.messages = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: {} }],
      },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect((out.messages[0] as { content: string | null }).content).toBeNull();
  });

  it("converts tool_result blocks to tool-role messages", () => {
    const req = base();
    req.messages = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "sunny, 22°C" },
          { type: "text", text: "Also, what's next?" },
        ],
      },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect(out.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tu_1",
      content: "sunny, 22°C",
    });
    expect(out.messages[1]).toEqual({ role: "user", content: "Also, what's next?" });
  });

  it("handles tool_result with array content (text blocks only)", () => {
    const req = base();
    req.messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: [
              { type: "text", text: "first" },
              { type: "text", text: "second" },
            ],
          },
        ],
      },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect(out.messages[0]).toEqual({
      role: "tool",
      tool_call_id: "tu_1",
      content: "first\n\nsecond",
    });
  });

  it("handles tool_result with omitted content as empty string", () => {
    const req = base();
    req.messages = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1" }],
      },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect((out.messages[0] as { content: string }).content).toBe("");
  });

  it("prefixes [error] to tool_result content when is_error=true", () => {
    const req = base();
    req.messages = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "boom", is_error: true }],
      },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect((out.messages[0] as { content: string }).content).toBe("[error] boom");
  });

  it("drops thinking blocks silently in user and assistant", () => {
    const req = base();
    req.messages = [
      {
        role: "user",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "visible" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden too" },
          { type: "text", text: "reply" },
        ],
      },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect(out.messages[0]).toEqual({ role: "user", content: "visible" });
    expect(out.messages[1]).toEqual({ role: "assistant", content: "reply" });
  });

  it("converts base64 image blocks in user messages to OpenAI vision parts", () => {
    const req = base();
    req.messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect(out.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
  });

  it("converts url image blocks in user messages", () => {
    const req = base();
    req.messages = [
      {
        role: "user",
        content: [{ type: "image", source: { type: "url", url: "https://example.com/x.png" } }],
      },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect(out.messages[0]).toEqual({
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://example.com/x.png" } }],
    });
  });

  it("rejects image block with a non-object source", () => {
    const req = base();
    req.messages = [
      {
        role: "user",
        content: [{ type: "image", source: null as unknown as AnthropicImageBlock["source"] }],
      },
    ];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(/source/);
  });

  it("rejects base64 image with missing media_type or data", () => {
    const req = base();
    req.messages = [
      {
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "", data: "x" } }],
      },
    ];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(/media_type/);

    req.messages = [
      {
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "" } }],
      },
    ];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(/data/);
  });

  it("rejects url image with an empty url", () => {
    const req = base();
    req.messages = [
      { role: "user", content: [{ type: "image", source: { type: "url", url: "" } }] },
    ];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(/url/);
  });

  it("rejects an unknown image source type", () => {
    const req = base();
    req.messages = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "raw" } as unknown as AnthropicImageBlock["source"],
          },
        ],
      },
    ];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(/source type/);
  });

  it("rejects image blocks in assistant messages", () => {
    const req = base();
    req.messages = [
      {
        role: "assistant",
        content: [{ type: "image", source: { type: "url", url: "https://example.com/x.png" } }],
      },
    ];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(UnsupportedFeatureError);
  });

  it("rejects image inside tool_result arrays", () => {
    const req = base();
    req.messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: [{ type: "image", source: { type: "url", url: "x" } }],
          } as unknown as AnthropicMessagesRequest["messages"][number]["content"][number],
        ],
      },
    ];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(UnsupportedFeatureError);
  });

  it("rejects tool_use in user messages", () => {
    const req = base();
    req.messages = [
      {
        role: "user",
        content: [{ type: "tool_use", id: "x", name: "y", input: {} }],
      },
    ];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(MalformedInputError);
  });

  it("rejects tool_result in assistant messages", () => {
    const req = base();
    req.messages = [
      {
        role: "assistant",
        content: [{ type: "tool_result", tool_use_id: "x", content: "y" }],
      },
    ];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(MalformedInputError);
  });

  it("rejects unknown role", () => {
    const req = base();
    (req.messages[0] as { role: string }).role = "developer";
    expect(() => anthropicToOpenAIRequest(req)).toThrow(MalformedInputError);
  });

  it("accepts system message in messages array with string content", () => {
    const req = base();
    req.messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect(out.messages[0]).toEqual({ role: "system", content: "You are helpful." });
    expect(out.messages[1]).toEqual({ role: "user", content: "Hi" });
  });

  it("accepts system message in messages array with text blocks", () => {
    const req = base();
    req.messages = [
      {
        role: "system",
        content: [
          { type: "text", text: "Line one." },
          { type: "text", text: "Line two." },
        ],
      },
      { role: "user", content: "Hi" },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect(out.messages[0]).toEqual({ role: "system", content: "Line one.\n\nLine two." });
    expect(out.messages[1]).toEqual({ role: "user", content: "Hi" });
  });

  it("rejects non-text blocks in system message array content", () => {
    const req = base();
    req.messages = [
      {
        role: "system",
        content: [{ type: "image", source: { type: "url", url: "https://example.com/x.png" } }],
      },
    ];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(MalformedInputError);
  });

  it("hoists a mid-conversation system message to the leading position", () => {
    // Regression: OpenAI rejects any `role: "system"` message that is not at
    // the start of the array. Claude Code (and similar Anthropic clients)
    // inject system reminders mid-conversation — those must be hoisted,
    // otherwise the upstream OpenAI API returns 400 "System message must be
    // at the beginning".
    const req = base();
    req.system = "You are helpful.";
    req.messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
      { role: "user", content: "How are you?" },
      { role: "system", content: "[Request interrupted by user]" },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect(out.messages[0]).toEqual({
      role: "system",
      content: "You are helpful.\n\n[Request interrupted by user]",
    });
    expect(out.messages[1]).toEqual({ role: "user", content: "Hello" });
    expect(out.messages[2]).toEqual({ role: "assistant", content: "Hi!" });
    expect(out.messages[3]).toEqual({ role: "user", content: "How are you?" });
    // No system message should appear after index 0.
    expect(out.messages.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("hoists a mid-conversation system message with text-block content", () => {
    const req = base();
    req.messages = [
      { role: "user", content: "Hi" },
      {
        role: "system",
        content: [
          { type: "text", text: "Reminder A." },
          { type: "text", text: "Reminder B." },
        ],
      },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect(out.messages[0]).toEqual({ role: "system", content: "Reminder A.\n\nReminder B." });
    expect(out.messages[1]).toEqual({ role: "user", content: "Hi" });
  });

  it("concatenates multiple system messages in the array, preserving order", () => {
    const req = base();
    req.messages = [
      { role: "system", content: "First." },
      { role: "user", content: "Hi" },
      { role: "system", content: "Second." },
      { role: "assistant", content: "Hello" },
      { role: "system", content: "Third." },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect(out.messages[0]).toEqual({
      role: "system",
      content: "First.\n\nSecond.\n\nThird.",
    });
    // Subsequent messages keep their original relative order.
    expect(out.messages.slice(1)).toEqual([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);
  });

  it("merges top-level system with hoisted system messages in order: top-level first", () => {
    const req = base();
    req.system = [
      { type: "text", text: "Top A." },
      { type: "text", text: "Top B." },
    ];
    req.messages = [
      { role: "user", content: "Hi" },
      { role: "system", content: "Array reminder." },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect(out.messages[0]).toEqual({
      role: "system",
      content: "Top A.\n\nTop B.\n\nArray reminder.",
    });
    expect(out.messages[1]).toEqual({ role: "user", content: "Hi" });
  });

  it("emits a hoisted system message even when top-level system is empty", () => {
    const req = base();
    req.system = "";
    req.messages = [
      { role: "user", content: "Hi" },
      { role: "system", content: "Injected reminder." },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect(out.messages[0]).toEqual({ role: "system", content: "Injected reminder." });
    expect(out.messages[1]).toEqual({ role: "user", content: "Hi" });
  });

  it("emits no system message when top-level is empty and all array system messages are empty", () => {
    const req = base();
    req.system = "";
    req.messages = [
      { role: "system", content: "" },
      { role: "user", content: "Hi" },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect(out.messages[0]?.role).toBe("user");
  });

  it("preserves the original messages[N] path when validating a hoisted system message", () => {
    // Error paths on hoisted system messages must still use the original
    // array index — otherwise the consumer loses information about *which*
    // message was malformed.
    const req = base();
    req.messages = [
      { role: "user", content: "Hi" },
      { role: "system", content: 42 as never },
    ];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(/messages\[1\]\.content/);
  });

  it("rejects a system content block with a missing type", () => {
    const req = base();
    req.messages = [
      {
        role: "system",
        content: [{ text: "oops" }],
      },
    ];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(MalformedInputError);
  });

  it("rejects a system text block whose text is not a string", () => {
    const req = base();
    req.messages = [
      {
        role: "system",
        content: [{ type: "text", text: 42 }],
      },
    ];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(MalformedInputError);
  });

  it("rejects null message", () => {
    const req = base();
    (req.messages as unknown as Array<unknown>)[0] = null;
    expect(() => anthropicToOpenAIRequest(req)).toThrow(MalformedInputError);
  });

  it("rejects non-array, non-string content", () => {
    const req = base();
    (req.messages[0] as { content: unknown }).content = 42;
    expect(() => anthropicToOpenAIRequest(req)).toThrow(MalformedInputError);
  });

  it("rejects content block without type", () => {
    const req = base();
    (req.messages[0] as { content: unknown }).content = [{ foo: "bar" }];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(MalformedInputError);
  });

  it("rejects text block without text", () => {
    const req = base();
    (req.messages[0] as { content: unknown }).content = [{ type: "text" }];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(MalformedInputError);
  });

  it("rejects text block without text in assistant", () => {
    const req = base();
    req.messages = [{ role: "assistant", content: [{ type: "text" } as never] }];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(MalformedInputError);
  });

  it("rejects unknown user block type", () => {
    const req = base();
    (req.messages[0] as { content: unknown }).content = [{ type: "wat" }];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(/unknown content block/);
  });

  it("rejects unknown assistant block type", () => {
    const req = base();
    req.messages = [{ role: "assistant", content: [{ type: "wat" } as never] }];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(/unknown content block/);
  });

  it("rejects null content block in user", () => {
    const req = base();
    (req.messages[0] as { content: unknown }).content = [null];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(MalformedInputError);
  });

  it("rejects null content block in assistant", () => {
    const req = base();
    req.messages = [{ role: "assistant", content: [null as never] }];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(MalformedInputError);
  });

  it("rejects tool_result with missing tool_use_id", () => {
    const req = base();
    req.messages = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "", content: "x" }],
      },
    ];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(/tool_use_id/);
  });

  it("rejects tool_result with non-string/array content", () => {
    const req = base();
    req.messages = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "x", content: 42 as never }],
      },
    ];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(MalformedInputError);
  });

  it("rejects tool_result array with unsupported inner type", () => {
    const req = base();
    req.messages = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "x",
            content: [{ type: "weird" } as never],
          },
        ],
      },
    ];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(MalformedInputError);
  });

  it("rejects tool_use missing id", () => {
    const req = base();
    req.messages = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "", name: "x", input: {} }],
      },
    ];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(/id/);
  });

  it("rejects tool_use missing name", () => {
    const req = base();
    req.messages = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "x", name: "", input: {} }],
      },
    ];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(/name/);
  });

  it("encodes tool_use input=undefined as empty-object string", () => {
    const req = base();
    req.messages = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "x", name: "y", input: undefined as unknown as object }],
      },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect(
      (out.messages[0] as { tool_calls: Array<{ function: { arguments: string } }> }).tool_calls[0]
        ?.function.arguments,
    ).toBe("{}");
  });
});

describe("anthropicToOpenAIRequest — tools and tool_choice", () => {
  it("converts tools and input_schema", () => {
    const req = base();
    req.tools = [
      {
        name: "get_weather",
        description: "Look up the weather",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      },
    ];
    const out = anthropicToOpenAIRequest(req);
    expect(out.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Look up the weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ]);
  });

  it("omits description when not provided", () => {
    const req = base();
    req.tools = [{ name: "x", input_schema: {} }];
    const out = anthropicToOpenAIRequest(req);
    expect(out.tools?.[0]?.function.description).toBeUndefined();
  });

  it("omits tools when array is empty", () => {
    const req = base();
    req.tools = [];
    const out = anthropicToOpenAIRequest(req);
    expect(out.tools).toBeUndefined();
  });

  it("rejects tool with missing name", () => {
    const req = base();
    req.tools = [{ name: "", input_schema: {} }];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(/name/);
  });

  it("rejects tool with non-object input_schema", () => {
    const req = base();
    req.tools = [{ name: "x", input_schema: null as unknown as Record<string, unknown> }];
    expect(() => anthropicToOpenAIRequest(req)).toThrow(/input_schema/);
  });

  it("maps tool_choice variants", () => {
    const req = base();
    req.tool_choice = { type: "any" };
    expect(anthropicToOpenAIRequest(req).tool_choice).toBe("required");

    req.tool_choice = { type: "tool", name: "get_weather" };
    expect(anthropicToOpenAIRequest(req).tool_choice).toEqual({
      type: "function",
      function: { name: "get_weather" },
    });
  });

  it("omits tool_choice when not provided", () => {
    const req = base();
    expect(anthropicToOpenAIRequest(req).tool_choice).toBeUndefined();
  });

  it("maps disable_parallel_tool_use to parallel_tool_calls:false on every choice type", () => {
    const req = base();
    req.tools = [{ name: "x", input_schema: {} }];

    req.tool_choice = { type: "auto", disable_parallel_tool_use: true };
    expect(anthropicToOpenAIRequest(req).parallel_tool_calls).toBe(false);

    req.tool_choice = { type: "any", disable_parallel_tool_use: true };
    expect(anthropicToOpenAIRequest(req).parallel_tool_calls).toBe(false);

    req.tool_choice = { type: "tool", name: "x", disable_parallel_tool_use: true };
    expect(anthropicToOpenAIRequest(req).parallel_tool_calls).toBe(false);
  });

  it("omits parallel_tool_calls when disable_parallel_tool_use is absent, false, or n/a", () => {
    const req = base();

    req.tool_choice = { type: "auto" };
    expect(anthropicToOpenAIRequest(req).parallel_tool_calls).toBeUndefined();

    req.tool_choice = { type: "auto", disable_parallel_tool_use: false };
    expect(anthropicToOpenAIRequest(req).parallel_tool_calls).toBeUndefined();

    req.tool_choice = { type: "none" };
    expect(anthropicToOpenAIRequest(req).parallel_tool_calls).toBeUndefined();

    delete req.tool_choice;
    expect(anthropicToOpenAIRequest(req).parallel_tool_calls).toBeUndefined();
  });
});

describe("anthropicToOpenAIRequest — passthrough fields", () => {
  it("passes through temperature, top_p, stream", () => {
    const req = base();
    req.temperature = 0.5;
    req.top_p = 0.9;
    req.stream = true;
    const out = anthropicToOpenAIRequest(req);
    expect(out.temperature).toBe(0.5);
    expect(out.top_p).toBe(0.9);
    expect(out.stream).toBe(true);
  });

  it("maps stop_sequences to stop, omitting empty array", () => {
    const req = base();
    req.stop_sequences = ["</end>"];
    expect(anthropicToOpenAIRequest(req).stop).toEqual(["</end>"]);
    req.stop_sequences = [];
    expect(anthropicToOpenAIRequest(req).stop).toBeUndefined();
  });

  it("maps metadata.user_id to user", () => {
    const req = base();
    req.metadata = { user_id: "user_42" };
    expect(anthropicToOpenAIRequest(req).user).toBe("user_42");
  });

  it("ignores metadata without user_id", () => {
    const req = base();
    req.metadata = {};
    expect(anthropicToOpenAIRequest(req).user).toBeUndefined();
  });

  it("preserves max_tokens", () => {
    const req = base();
    req.max_tokens = 2048;
    expect(anthropicToOpenAIRequest(req).max_tokens).toBe(2048);
  });
});
