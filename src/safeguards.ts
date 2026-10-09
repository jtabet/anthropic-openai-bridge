/**
 * Auto-mode safety-classifier passthrough (the `safeguards` contract).
 *
 * Claude Code v2.1.278+ requests *server-side* auto-mode classifier review:
 * the `/v1/messages` request body carries a `safeguards` array (paired with
 * the `dangerous-tool-use-2026-09-03` beta) and the response must carry back
 * a `safeguard_results` array — non-streaming as a top-level field, streaming
 * inside the delta of the final `message_delta` event.
 *
 * The observed wire shape (pinned by capture; NOT published by any official
 * reference — a future Claude Code release can move it):
 *
 *   request:
 *     "safeguards": [
 *       {
 *         "type": "dangerous_tool_use",
 *         "classifier_context": { "v": 1, "permission_mode": "auto" }
 *       }
 *     ]
 *
 *   response:
 *     "safeguard_results": [
 *       {
 *         "type": "dangerous_tool_use",
 *         "status": {
 *           "type": "available",
 *           "tool_uses": {
 *             "toolu_01...": { "type": "evaluated", "outcome": "not_flagged" }
 *           }
 *         }
 *       }
 *     ]
 *
 * Scope boundary: this library is a *translator*, not a policy engine. It
 * has no ability to evaluate tool-call safety, so it never authors
 * `safeguard_results`. What it provides:
 *
 *   - `extractSafeguards()` — pull the request field out (validated loosely)
 *     so a bridge consumer can observe it and decide policy (forward it to a
 *     native Anthropic upstream, evaluate it with its own classifier, or
 *     let Claude Code fall back to client-side classification by simply not
 *     answering).
 *   - `openAIToAnthropicResponse(resp, { safeguardResults })` — attach a
 *     caller-authored array to the non-streaming response verbatim.
 *   - `AnthropicStreamEncoderOptions.safeguardResults` — attach a
 *     caller-authored array to the final `message_delta` delta.
 *
 * Dropping the request field (the pre-0.4 behavior) is a valid degraded
 * mode: Claude Code reads the absence of a verdict as "server-side checks
 * not enabled" and falls back to its own classifier requests gracefully.
 * What does NOT degrade gracefully is sending a *mangled* response — so
 * this module only ever passes caller-authored arrays through unmodified.
 */

import { MalformedInputError } from "./errors.js";
import type { AnthropicSafeguardResult } from "./types.js";

/**
 * Extract the `safeguards` request field from a raw Anthropic Messages
 * request body (as received on the wire — the field is not part of
 * `AnthropicMessagesRequest`, precisely because it is pass-through-only).
 *
 * Returns undefined when absent. Throws `MalformedInputError` only when the
 * field is present but not an array of objects — anything else passes
 * through unvalidated beyond that, because the schema is unpublished and
 * strictness here would 400 valid future shapes.
 */
export function extractSafeguards(body: unknown): AnthropicSafeguardResult[] | undefined {
  if (body === null || typeof body !== "object") {
    return undefined;
  }
  const field = (body as { safeguards?: unknown }).safeguards;
  if (field === undefined) return undefined;
  if (!Array.isArray(field)) {
    throw new MalformedInputError("safeguards must be an array of check objects", "safeguards");
  }
  for (let i = 0; i < field.length; i++) {
    const entry = field[i];
    if (entry === null || typeof entry !== "object") {
      throw new MalformedInputError("safeguards entries must be objects", `safeguards[${i}]`);
    }
  }
  return field as AnthropicSafeguardResult[];
}

/**
 * Options bag for response-side safeguard attachment. Both translators
 * accept it; both attach the caller's array verbatim (no deep copy, no
 * validation beyond the type — the bridge never authors verdicts).
 */
export type SafeguardResultsOptions = {
  /**
   * Caller-authored `safeguard_results` to attach to the response. The
   * bridge never generates these; see the module docblock for the observed
   * wire shape. Empty/undefined omits the field entirely (the degraded mode
   * Claude Code handles gracefully).
   */
  safeguardResults?: AnthropicSafeguardResult[];
};
