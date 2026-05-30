/**
 * Translate an Anthropic Messages API request to an OpenAI Chat Completions
 * API request.
 *
 * Pure function. No I/O, no global state. The output object is freshly
 * allocated; the input is never mutated.
 */

import { MalformedInputError, UnsupportedFeatureError } from "./errors.js";
import { mapToolChoice } from "./mappings.js";
import type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  OpenAIAssistantMessage,
  OpenAIChatRequest,
  OpenAIContentPart,
  OpenAIImagePart,
  OpenAIMessage,
  OpenAITool,
  OpenAIToolMessage,
  OpenAIUserMessage,
} from "./types.js";

/**
 * Convert an Anthropic Messages API request to an OpenAI Chat Completions
 * request. Validates required fields and rejects unsupported features.
 *
 * @throws {MalformedInputError} when required fields are missing or malformed.
 * @throws {UnsupportedFeatureError} when the request contains a feature with no
 *   OpenAI representation — e.g. an image block in an assistant message or
 *   inside a tool_result (OpenAI accepts images only in user content).
 *
 * @example
 * ```ts
 * const openaiReq = anthropicToOpenAIRequest({
 *   model: "claude-sonnet-4-6",
 *   max_tokens: 1024,
 *   messages: [{ role: "user", content: "Hello" }],
 * });
 * ```
 */
export function anthropicToOpenAIRequest(input: AnthropicMessagesRequest): OpenAIChatRequest {
  validateRequest(input);

  const messages: OpenAIMessage[] = [];

  // System prompt becomes a synthetic first message. Anthropic allows either
  // a plain string or an array of text blocks; flatten to a single string by
  // concatenating block texts with double newlines.
  if (input.system !== undefined) {
    const systemText = flattenSystem(input.system);
    if (systemText.length > 0) {
      messages.push({ role: "system", content: systemText });
    }
  }

  for (let i = 0; i < input.messages.length; i++) {
    const msg = input.messages[i] as AnthropicMessage;
    const converted = convertMessage(msg, `messages[${i}]`);
    for (const c of converted) {
      messages.push(c);
    }
  }

  const output: OpenAIChatRequest = {
    model: input.model,
    messages,
    max_tokens: input.max_tokens,
  };

  if (input.temperature !== undefined) output.temperature = input.temperature;
  if (input.top_p !== undefined) output.top_p = input.top_p;
  if (input.stop_sequences !== undefined && input.stop_sequences.length > 0) {
    output.stop = input.stop_sequences;
  }
  if (input.stream !== undefined) output.stream = input.stream;
  if (input.metadata?.user_id !== undefined) output.user = input.metadata.user_id;

  if (input.tools !== undefined && input.tools.length > 0) {
    output.tools = input.tools.map((t, i) => convertTool(t, i));
  }

  const toolChoice = mapToolChoice(input.tool_choice);
  if (toolChoice !== undefined) {
    output.tool_choice = toolChoice;
  }

  // Anthropic carries `disable_parallel_tool_use` on the tool_choice object;
  // OpenAI exposes the inverse as a sibling request field.
  if (
    input.tool_choice !== undefined &&
    input.tool_choice.type !== "none" &&
    input.tool_choice.disable_parallel_tool_use === true
  ) {
    output.parallel_tool_calls = false;
  }

  // `thinking`, `top_k`: silently dropped — no OpenAI equivalent.

  return output;
}

function validateRequest(input: AnthropicMessagesRequest): void {
  if (input === null || typeof input !== "object") {
    throw new MalformedInputError("request must be an object", "request");
  }
  if (typeof input.model !== "string" || input.model.length === 0) {
    throw new MalformedInputError("model is required and must be a non-empty string", "model");
  }
  if (
    typeof input.max_tokens !== "number" ||
    !Number.isFinite(input.max_tokens) ||
    input.max_tokens <= 0
  ) {
    throw new MalformedInputError(
      "max_tokens is required and must be a positive number",
      "max_tokens",
    );
  }
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new MalformedInputError("messages must be a non-empty array", "messages");
  }
}

function flattenSystem(system: string | AnthropicTextBlock[]): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) {
    throw new MalformedInputError("system must be a string or an array of text blocks", "system");
  }
  const parts: string[] = [];
  for (let i = 0; i < system.length; i++) {
    const block = system[i] as AnthropicTextBlock;
    if (
      block === null ||
      typeof block !== "object" ||
      block.type !== "text" ||
      typeof block.text !== "string"
    ) {
      throw new MalformedInputError("system blocks must be text blocks", `system[${i}]`);
    }
    parts.push(block.text);
  }
  return parts.join("\n\n");
}

function convertMessage(msg: AnthropicMessage, path: string): OpenAIMessage[] {
  if (msg === null || typeof msg !== "object") {
    throw new MalformedInputError("message must be an object", path);
  }
  if (msg.role !== "user" && msg.role !== "assistant") {
    throw new MalformedInputError(
      `unsupported role "${(msg as { role: unknown }).role}" (expected "user" or "assistant")`,
      `${path}.role`,
    );
  }

  // String content: trivial passthrough.
  if (typeof msg.content === "string") {
    if (msg.role === "user") {
      return [{ role: "user", content: msg.content } satisfies OpenAIUserMessage];
    }
    return [{ role: "assistant", content: msg.content } satisfies OpenAIAssistantMessage];
  }

  if (!Array.isArray(msg.content)) {
    throw new MalformedInputError(
      "message.content must be a string or an array of content blocks",
      `${path}.content`,
    );
  }

  return msg.role === "user"
    ? convertUserBlocks(msg.content, `${path}.content`)
    : convertAssistantBlocks(msg.content, `${path}.content`);
}

function convertUserBlocks(blocks: AnthropicContentBlock[], path: string): OpenAIMessage[] {
  // A user turn may contain text, image, and tool_result blocks. Tool results
  // map to separate OpenAI `role:'tool'` messages; text and image blocks merge
  // into a single user message preceding them. The Messages API does not
  // constrain the order strictly, but emitting tool messages first (per their
  // original order) and then the user message keeps the OpenAI shape clean.
  //
  // When the turn contains at least one image, the user message content is an
  // ordered parts array (OpenAI vision format); otherwise it stays a plain
  // concatenated string so image-free requests translate exactly as before.
  const textParts: string[] = [];
  const parts: OpenAIContentPart[] = [];
  const toolMessages: OpenAIToolMessage[] = [];
  let hasImage = false;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] as AnthropicContentBlock;
    const subPath = `${path}[${i}]`;
    if (
      block === null ||
      typeof block !== "object" ||
      typeof (block as { type?: unknown }).type !== "string"
    ) {
      throw new MalformedInputError("content block must have a string type", subPath);
    }

    switch (block.type) {
      case "text":
        if (typeof block.text !== "string") {
          throw new MalformedInputError("text block requires a string `text`", `${subPath}.text`);
        }
        textParts.push(block.text);
        parts.push({ type: "text", text: block.text });
        break;

      case "image":
        parts.push(convertImageBlock(block, subPath));
        hasImage = true;
        break;

      case "tool_result":
        toolMessages.push(convertToolResult(block, subPath));
        break;

      case "thinking":
        // Silently dropped — see README design decisions.
        break;

      case "tool_use":
        throw new MalformedInputError(
          "tool_use blocks must appear in assistant messages, not user messages",
          subPath,
        );

      default:
        throw new MalformedInputError(
          `unknown content block type "${(block as { type: string }).type}"`,
          subPath,
        );
    }
  }

  const out: OpenAIMessage[] = [...toolMessages];
  if (hasImage) {
    out.push({ role: "user", content: parts } satisfies OpenAIUserMessage);
  } else if (textParts.length > 0) {
    out.push({ role: "user", content: textParts.join("\n\n") } satisfies OpenAIUserMessage);
  }
  return out;
}

function convertImageBlock(block: AnthropicImageBlock, path: string): OpenAIImagePart {
  const source = (block as { source?: unknown }).source;
  if (source === null || typeof source !== "object") {
    throw new MalformedInputError("image block requires a `source` object", `${path}.source`);
  }
  const src = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };

  if (src.type === "base64") {
    if (typeof src.media_type !== "string" || src.media_type.length === 0) {
      throw new MalformedInputError(
        "base64 image source requires a string `media_type`",
        `${path}.source.media_type`,
      );
    }
    if (typeof src.data !== "string" || src.data.length === 0) {
      throw new MalformedInputError(
        "base64 image source requires a string `data`",
        `${path}.source.data`,
      );
    }
    return {
      type: "image_url",
      image_url: { url: `data:${src.media_type};base64,${src.data}` },
    };
  }

  if (src.type === "url") {
    if (typeof src.url !== "string" || src.url.length === 0) {
      throw new MalformedInputError(
        "url image source requires a string `url`",
        `${path}.source.url`,
      );
    }
    return { type: "image_url", image_url: { url: src.url } };
  }

  throw new MalformedInputError(
    `unsupported image source type "${String(src.type)}"`,
    `${path}.source.type`,
  );
}

function convertAssistantBlocks(blocks: AnthropicContentBlock[], path: string): OpenAIMessage[] {
  const textParts: string[] = [];
  const toolCalls: NonNullable<OpenAIAssistantMessage["tool_calls"]> = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] as AnthropicContentBlock;
    const subPath = `${path}[${i}]`;
    if (
      block === null ||
      typeof block !== "object" ||
      typeof (block as { type?: unknown }).type !== "string"
    ) {
      throw new MalformedInputError("content block must have a string type", subPath);
    }

    switch (block.type) {
      case "text":
        if (typeof block.text !== "string") {
          throw new MalformedInputError("text block requires a string `text`", `${subPath}.text`);
        }
        textParts.push(block.text);
        break;

      case "tool_use":
        toolCalls.push(convertToolUse(block, subPath));
        break;

      case "thinking":
        // Silently dropped.
        break;

      case "image":
        throw new UnsupportedFeatureError(
          "image",
          `Image content blocks in assistant messages are not supported (at ${subPath}).`,
        );

      case "tool_result":
        throw new MalformedInputError(
          "tool_result blocks must appear in user messages, not assistant messages",
          subPath,
        );

      default:
        throw new MalformedInputError(
          `unknown content block type "${(block as { type: string }).type}"`,
          subPath,
        );
    }
  }

  const assistant: OpenAIAssistantMessage = {
    role: "assistant",
    content: textParts.length > 0 ? textParts.join("\n\n") : null,
  };
  if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
  return [assistant];
}

function convertToolUse(
  block: AnthropicToolUseBlock,
  path: string,
): NonNullable<OpenAIAssistantMessage["tool_calls"]>[number] {
  if (typeof block.id !== "string" || block.id.length === 0) {
    throw new MalformedInputError("tool_use requires a string `id`", `${path}.id`);
  }
  if (typeof block.name !== "string" || block.name.length === 0) {
    throw new MalformedInputError("tool_use requires a string `name`", `${path}.name`);
  }
  // input is an arbitrary JSON value. OpenAI requires it as a JSON string.
  // JSON.stringify on `undefined` returns undefined; coerce to empty object.
  const args = block.input === undefined ? "{}" : JSON.stringify(block.input);
  return {
    id: block.id,
    type: "function",
    function: { name: block.name, arguments: args },
  };
}

function convertToolResult(block: AnthropicToolResultBlock, path: string): OpenAIToolMessage {
  if (typeof block.tool_use_id !== "string" || block.tool_use_id.length === 0) {
    throw new MalformedInputError(
      "tool_result requires a string `tool_use_id`",
      `${path}.tool_use_id`,
    );
  }
  let content: string;
  if (block.content === undefined) {
    content = "";
  } else if (typeof block.content === "string") {
    content = block.content;
  } else if (Array.isArray(block.content)) {
    const parts: string[] = [];
    for (let i = 0; i < block.content.length; i++) {
      const inner = block.content[i] as AnthropicTextBlock | { type: string };
      if (inner.type === "text" && typeof (inner as AnthropicTextBlock).text === "string") {
        parts.push((inner as AnthropicTextBlock).text);
      } else if (inner.type === "image") {
        throw new UnsupportedFeatureError(
          "image",
          `Image blocks inside tool_result are not supported (at ${path}.content[${i}]).`,
        );
      } else {
        throw new MalformedInputError(
          `unsupported tool_result inner block type "${inner.type}"`,
          `${path}.content[${i}]`,
        );
      }
    }
    content = parts.join("\n\n");
  } else {
    throw new MalformedInputError(
      "tool_result.content must be a string or an array of text blocks",
      `${path}.content`,
    );
  }

  // is_error: prefix the content so the model can see the error signal. OpenAI
  // tool messages have no equivalent flag.
  if (block.is_error === true) {
    content = `[error] ${content}`;
  }

  return { role: "tool", tool_call_id: block.tool_use_id, content };
}

function convertTool(
  tool: { name?: unknown; description?: unknown; input_schema?: unknown },
  index: number,
): OpenAITool {
  if (typeof tool.name !== "string" || tool.name.length === 0) {
    throw new MalformedInputError("tool requires a string `name`", `tools[${index}].name`);
  }
  if (tool.input_schema === null || typeof tool.input_schema !== "object") {
    throw new MalformedInputError(
      "tool requires an object `input_schema`",
      `tools[${index}].input_schema`,
    );
  }
  const out: OpenAITool = {
    type: "function",
    function: {
      name: tool.name,
      parameters: tool.input_schema as Record<string, unknown>,
    },
  };
  if (typeof tool.description === "string") {
    out.function.description = tool.description;
  }
  return out;
}
