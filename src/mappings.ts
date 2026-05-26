/**
 * Stateless mapping tables between Anthropic and OpenAI vocabularies.
 *
 * Kept as small pure functions (not just objects) so callers can pass in
 * unknown values from the wire and get a defined fallback rather than
 * `undefined`. Every mapping has an explicit default to avoid silent gaps
 * if the upstream APIs add new values.
 */

/**
 * Anthropic stop_reason values.
 * See https://docs.anthropic.com/en/api/messages#response-stop-reason
 */
export type AnthropicStopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

/**
 * OpenAI finish_reason values.
 * See https://platform.openai.com/docs/api-reference/chat/object#chat/object-choices
 */
export type OpenAIFinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "function_call";

/**
 * Map an OpenAI `finish_reason` to an Anthropic `stop_reason`.
 *
 * - `stop` (natural end) → `end_turn`
 * - `tool_calls` → `tool_use`
 * - `length` (max tokens hit) → `max_tokens`
 * - `content_filter` → `end_turn` (no Anthropic equivalent; safest default)
 * - `function_call` (legacy OpenAI) → `tool_use`
 * - anything else / null → `end_turn`
 */
export function finishReasonToStopReason(reason: string | null | undefined): AnthropicStopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
    case null:
    case undefined:
      return "end_turn";
    default:
      return "end_turn";
  }
}

/**
 * Anthropic tool_choice variants accepted by the Messages API.
 */
export type AnthropicToolChoice =
  | { type: "auto"; disable_parallel_tool_use?: boolean }
  | { type: "any"; disable_parallel_tool_use?: boolean }
  | { type: "tool"; name: string; disable_parallel_tool_use?: boolean }
  | { type: "none" };

/**
 * OpenAI tool_choice variants accepted by Chat Completions.
 */
export type OpenAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

/**
 * Map an Anthropic tool_choice to its OpenAI equivalent.
 *
 * Anthropic semantics:
 * - `auto`: model decides
 * - `any`: model MUST use a tool (any tool)
 * - `tool`: model MUST use the named tool
 * - `none`: model MUST NOT use tools
 *
 * `disable_parallel_tool_use` is silently dropped — OpenAI's per-call
 * `parallel_tool_calls: false` is a sibling field, mapped separately by
 * the request transformer if needed.
 */
export function mapToolChoice(
  choice: AnthropicToolChoice | undefined,
): OpenAIToolChoice | undefined {
  if (!choice) return undefined;
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "function", function: { name: choice.name } };
  }
}
