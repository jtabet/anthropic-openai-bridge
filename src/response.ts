/**
 * Translate a non-streaming OpenAI Chat Completion response to an Anthropic
 * Message response.
 *
 * Pure function. Streaming responses are handled by `AnthropicStreamEncoder`
 * in `./stream.ts`.
 */

import { MalformedInputError } from "./errors.js";
import { finishReasonToStopReason } from "./mappings.js";
import type {
  AnthropicMessageResponse,
  AnthropicResponseContentBlock,
  OpenAIChatCompletion,
} from "./types.js";

/**
 * Convert an OpenAI ChatCompletion (the non-streaming response shape) to an
 * Anthropic Message response.
 *
 * Only the first choice is used; OpenAI's `n>1` is not exposed by the
 * Anthropic API surface.
 *
 * @throws {MalformedInputError} when the response is missing required fields.
 *
 * @example
 * ```ts
 * const anthropicMsg = openAIToAnthropicResponse(openaiResp);
 * ```
 */
export function openAIToAnthropicResponse(resp: OpenAIChatCompletion): AnthropicMessageResponse {
  if (resp === null || typeof resp !== "object") {
    throw new MalformedInputError("response must be an object", "response");
  }
  if (typeof resp.id !== "string" || resp.id.length === 0) {
    throw new MalformedInputError("response.id must be a non-empty string", "id");
  }
  if (typeof resp.model !== "string") {
    throw new MalformedInputError("response.model must be a string", "model");
  }
  if (!Array.isArray(resp.choices) || resp.choices.length === 0) {
    throw new MalformedInputError("response.choices must be a non-empty array", "choices");
  }

  // biome-ignore lint/style/noNonNullAssertion: length checked above
  const choice = resp.choices[0]!;
  if (choice === null || typeof choice !== "object") {
    throw new MalformedInputError("choice must be an object", "choices[0]");
  }
  if (choice.message === null || typeof choice.message !== "object") {
    throw new MalformedInputError("choice.message must be an object", "choices[0].message");
  }

  const content: AnthropicResponseContentBlock[] = [];

  // Assistant text → text block. Coerce empty/null content to "" handled by
  // omitting the block; preserves intent that an empty assistant message
  // with only tool calls emits only tool_use blocks.
  if (typeof choice.message.content === "string" && choice.message.content.length > 0) {
    content.push({ type: "text", text: choice.message.content });
  }

  // tool_calls → tool_use blocks.
  if (Array.isArray(choice.message.tool_calls)) {
    for (let i = 0; i < choice.message.tool_calls.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: index proved by length loop
      const tc = choice.message.tool_calls[i]!;
      if (typeof tc.id !== "string" || tc.id.length === 0) {
        throw new MalformedInputError(
          "tool_call.id must be a non-empty string",
          `choices[0].message.tool_calls[${i}].id`,
        );
      }
      if (tc.function === null || typeof tc.function !== "object") {
        throw new MalformedInputError(
          "tool_call.function must be an object",
          `choices[0].message.tool_calls[${i}].function`,
        );
      }
      if (typeof tc.function.name !== "string" || tc.function.name.length === 0) {
        throw new MalformedInputError(
          "tool_call.function.name must be a non-empty string",
          `choices[0].message.tool_calls[${i}].function.name`,
        );
      }
      let parsed: unknown = {};
      if (typeof tc.function.arguments === "string" && tc.function.arguments.length > 0) {
        try {
          parsed = JSON.parse(tc.function.arguments);
        } catch (cause) {
          throw new MalformedInputError(
            "tool_call.function.arguments must be valid JSON",
            `choices[0].message.tool_calls[${i}].function.arguments`,
            { cause },
          );
        }
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: parsed,
      });
    }
  }

  // If the assistant emitted nothing at all, ensure we still have a valid
  // (empty text) content block so downstream parsers don't choke on `[]`.
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  const usage = resp.usage;
  const inputTokens = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const outputTokens = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : 0;

  return {
    id: resp.id,
    type: "message",
    role: "assistant",
    model: resp.model,
    content,
    stop_reason: finishReasonToStopReason(choice.finish_reason),
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}
