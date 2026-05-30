/**
 * Minimal structural types for the Anthropic Messages API and OpenAI Chat
 * Completions API surfaces this library translates between.
 *
 * Why duplicate types instead of re-exporting from `@anthropic-ai/sdk` /
 * `openai`?
 *
 *  1. **Stability.** SDK types evolve; structural copies let the bridge pin
 *     a known wire format independently of SDK semver.
 *  2. **Zero runtime coupling.** Peer-deps are types-only and *optional*;
 *     consumers may use this library without installing either SDK.
 *  3. **Documentation.** The fields the bridge actually inspects are listed
 *     here in one place, so a contributor knows exactly what is read or
 *     emitted on the wire.
 *
 * These types are deliberately a *subset* of the official surfaces — fields
 * the library does not read or write are omitted. Unknown fields on input
 * objects pass through unchanged where appropriate.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic Messages API — request side
// ─────────────────────────────────────────────────────────────────────────────

export type AnthropicTextBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};

export type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

export type AnthropicToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content?: string | Array<AnthropicTextBlock | AnthropicImageBlock>;
  is_error?: boolean;
};

export type AnthropicImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
};

export type AnthropicThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature?: string;
};

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicImageBlock
  | AnthropicThinkingBlock;

export type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

export type AnthropicTool = {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
};

export type AnthropicToolChoiceField =
  | { type: "auto"; disable_parallel_tool_use?: boolean }
  | { type: "any"; disable_parallel_tool_use?: boolean }
  | { type: "tool"; name: string; disable_parallel_tool_use?: boolean }
  | { type: "none" };

export type AnthropicMessagesRequest = {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicTextBlock[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoiceField;
  stream?: boolean;
  metadata?: { user_id?: string };
  thinking?: { type: "enabled"; budget_tokens: number } | { type: "disabled" };
};

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic Messages API — response side
// ─────────────────────────────────────────────────────────────────────────────

export type AnthropicResponseContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock;

export type AnthropicUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

export type AnthropicMessageResponse = {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicResponseContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
};

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic streaming events (SSE)
// ─────────────────────────────────────────────────────────────────────────────

export type AnthropicMessageStartEvent = {
  type: "message_start";
  message: AnthropicMessageResponse;
};

export type AnthropicContentBlockStartEvent = {
  type: "content_block_start";
  index: number;
  content_block:
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
};

export type AnthropicContentBlockDeltaEvent = {
  type: "content_block_delta";
  index: number;
  delta: { type: "text_delta"; text: string } | { type: "input_json_delta"; partial_json: string };
};

export type AnthropicContentBlockStopEvent = {
  type: "content_block_stop";
  index: number;
};

export type AnthropicMessageDeltaEvent = {
  type: "message_delta";
  delta: {
    stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | null;
    stop_sequence: string | null;
  };
  usage: { output_tokens: number };
};

export type AnthropicMessageStopEvent = {
  type: "message_stop";
};

export type AnthropicStreamEvent =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent;

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Chat Completions — request side
// ─────────────────────────────────────────────────────────────────────────────

export type OpenAISystemMessage = { role: "system"; content: string };

export type OpenAITextPart = { type: "text"; text: string };
export type OpenAIImagePart = { type: "image_url"; image_url: { url: string } };
export type OpenAIContentPart = OpenAITextPart | OpenAIImagePart;

// User content is a plain string when the turn is text-only, or an ordered
// array of parts (OpenAI vision format) when it contains at least one image.
export type OpenAIUserMessage = { role: "user"; content: string | OpenAIContentPart[] };
export type OpenAIAssistantMessage = {
  role: "assistant";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};
export type OpenAIToolMessage = {
  role: "tool";
  tool_call_id: string;
  content: string;
};

export type OpenAIMessage =
  | OpenAISystemMessage
  | OpenAIUserMessage
  | OpenAIAssistantMessage
  | OpenAIToolMessage;

export type OpenAITool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type OpenAIToolChoiceField =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

export type OpenAIChatRequest = {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: OpenAITool[];
  tool_choice?: OpenAIToolChoiceField;
  parallel_tool_calls?: boolean;
  stream?: boolean;
  user?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Chat Completions — non-streaming response side
// ─────────────────────────────────────────────────────────────────────────────

export type OpenAIChatCompletion = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Chat Completions — streaming chunk
// ─────────────────────────────────────────────────────────────────────────────

export type OpenAIToolCallDelta = {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
};

export type OpenAIChatCompletionChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string | null;
      tool_calls?: OpenAIToolCallDelta[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};
