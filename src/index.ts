/**
 * Public surface of `@jtabet/anthropic-openai-bridge`.
 *
 * Anything not re-exported here is internal and may change between patch
 * releases. An API snapshot test (`test/api.test.ts`) pins this surface to
 * prevent accidental expansion.
 */

export {
  BridgeError,
  InternalInvariantError,
  MalformedInputError,
  UnsupportedFeatureError,
} from "./errors.js";
export type {
  AnthropicStopReason,
  AnthropicToolChoice,
  OpenAIFinishReason,
  OpenAIToolChoice,
} from "./mappings.js";
export { anthropicToOpenAIRequest } from "./request.js";
export { openAIToAnthropicResponse } from "./response.js";
export { frameEvent } from "./sse.js";
export {
  AnthropicStreamEncoder,
  type AnthropicStreamEncoderOptions,
} from "./stream.js";
export type {
  AnthropicContentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicMessageResponse,
  AnthropicMessagesRequest,
  AnthropicResponseContentBlock,
  AnthropicStreamEvent,
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicTool,
  AnthropicToolChoiceField,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  AnthropicUsage,
  OpenAIAssistantMessage,
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk,
  OpenAIChatRequest,
  OpenAIMessage,
  OpenAISystemMessage,
  OpenAITool,
  OpenAIToolCallDelta,
  OpenAIToolChoiceField,
  OpenAIToolMessage,
  OpenAIUserMessage,
} from "./types.js";
