/**
 * Server-Sent Events (SSE) framing helper for Anthropic stream events.
 *
 * Anthropic's wire format for the streaming Messages API uses both an
 * `event:` line (carrying the event type name) and a `data:` line (carrying
 * the JSON payload), terminated by a blank line. Some clients rely on the
 * `event:` line; the @anthropic-ai/sdk parser does. Always emit both.
 */

import type { AnthropicStreamEvent } from "./types.js";

/**
 * Frame an Anthropic stream event as the on-the-wire SSE string.
 *
 * Output format (each event is exactly):
 *
 * ```
 * event: <type>\n
 * data: <json>\n
 * \n
 * ```
 *
 * @example
 * ```ts
 * const line = frameEvent({ type: "message_stop" });
 * // "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
 * ```
 */
export function frameEvent(event: AnthropicStreamEvent): string {
  const data = JSON.stringify(event);
  return `event: ${event.type}\ndata: ${data}\n\n`;
}
