/**
 * Convert an OpenAI Chat Completions streaming response (a sequence of
 * `ChatCompletionChunk` objects) into the Anthropic Messages SSE event
 * stream.
 *
 * Anthropic event ordering (strict; see
 * https://docs.anthropic.com/en/api/messages-streaming):
 *
 *   message_start
 *   ( content_block_start
 *     content_block_delta*
 *     content_block_stop )*
 *   message_delta              ← stop_reason + final usage
 *   message_stop
 *
 * The encoder is stateful; one instance handles exactly one logical
 * response stream. Reuse across responses is a bug.
 */

import { InternalInvariantError, MalformedInputError } from "./errors.js";
import { type AnthropicStopReason, finishReasonToStopReason } from "./mappings.js";
import { frameEvent } from "./sse.js";
import type {
  AnthropicStreamEvent,
  OpenAIChatCompletionChunk,
  OpenAIToolCallDelta,
} from "./types.js";

/**
 * Options for the AnthropicStreamEncoder.
 */
export type AnthropicStreamEncoderOptions = {
  /**
   * Pre-allocate the Anthropic message id used in `message_start`. If
   * omitted, an id is synthesized from a counter + timestamp. Supply this
   * (or `idGenerator`) for deterministic test fixtures.
   */
  messageId?: string;
  /**
   * Optional id generator for the message_start event. Called once per
   * encoder instance. Overrides `messageId` if both are provided.
   */
  idGenerator?: () => string;
  /**
   * Anthropic model name to advertise in `message_start.message.model`.
   * If omitted, the model from the first OpenAI chunk is used as-is.
   * Useful when the upstream OpenAI model name differs from the Anthropic
   * route the caller asked for.
   */
  modelOverride?: string;
};

type ActiveBlock =
  | { kind: "text"; index: number }
  | { kind: "tool_use"; index: number; toolCallIndex: number };

/**
 * Stateful encoder that converts OpenAI ChatCompletionChunk objects into
 * Anthropic SSE event strings.
 *
 * Lifecycle:
 *
 *   const enc = new AnthropicStreamEncoder();
 *   for await (const chunk of openaiStream) {
 *     for (const line of enc.feed(chunk)) res.write(line);
 *   }
 *   for (const line of enc.end()) res.write(line);
 *   res.end();
 *
 * `feed` is idempotent only in the sense that feeding the same chunk twice
 * is *not* supported and will likely produce duplicate events. `end` may be
 * called at most once and emits the closing events.
 *
 * @throws {MalformedInputError} if a chunk does not conform to the expected
 *   OpenAI shape (only the fields the encoder reads are validated).
 */
export class AnthropicStreamEncoder {
  private started = false;
  private ended = false;
  private messageId: string;
  private model: string | null = null;
  private modelOverride: string | undefined;
  private nextIndex = 0;
  private activeBlock: ActiveBlock | null = null;
  /** Map: OpenAI delta tool_call index → our content_block index */
  private toolCallToBlockIndex = new Map<number, number>();
  /** Map: OpenAI delta tool_call index → accumulated argument bytes emitted so far */
  private toolCallArgsAccumulated = new Map<number, string>();
  /**
   * Map: OpenAI delta tool_call index → partial id/name seen so far (used
   * when id and name arrive across separate chunks; OpenAI's canonical
   * stream always packs them together on the first chunk, but defensive).
   */
  private pendingToolCallMeta = new Map<number, { id?: string; name?: string }>();
  private stopReason: AnthropicStopReason | null = null;
  private completionTokens = 0;

  constructor(opts: AnthropicStreamEncoderOptions = {}) {
    if (opts.idGenerator) {
      this.messageId = opts.idGenerator();
    } else if (opts.messageId !== undefined) {
      this.messageId = opts.messageId;
    } else {
      // Counter-based; not crypto-strong, deliberately. Never derived from
      // user input. Time component to keep IDs roughly monotonic across
      // process restarts.
      this.messageId = `msg_${Date.now().toString(36)}${(idCounter++).toString(36)}`;
    }
    this.modelOverride = opts.modelOverride;
  }

  /**
   * Feed a single OpenAI ChatCompletionChunk. Returns SSE event strings
   * ready to write to the wire.
   */
  feed(chunk: OpenAIChatCompletionChunk): string[] {
    if (this.ended) {
      throw new InternalInvariantError("feed() called after end()");
    }
    if (chunk === null || typeof chunk !== "object") {
      throw new MalformedInputError("chunk must be an object", "chunk");
    }
    if (!Array.isArray(chunk.choices)) {
      throw new MalformedInputError("chunk.choices must be an array", "chunk.choices");
    }

    const out: string[] = [];

    // First chunk: emit message_start.
    if (!this.started) {
      this.started = true;
      this.model =
        this.modelOverride ?? (typeof chunk.model === "string" ? chunk.model : "unknown");
      out.push(
        frameEvent({
          type: "message_start",
          message: {
            id: this.messageId,
            type: "message",
            role: "assistant",
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
    }

    if (chunk.choices.length === 0) {
      // No-op chunk (some providers emit these to ship usage at the end).
      this.captureUsage(chunk);
      return out;
    }

    // biome-ignore lint/style/noNonNullAssertion: length checked above
    const choice = chunk.choices[0]!;
    if (choice === null || typeof choice !== "object") {
      throw new MalformedInputError("choice must be an object", "chunk.choices[0]");
    }

    const delta = choice.delta;
    if (delta && typeof delta === "object") {
      // Text content delta.
      if (typeof delta.content === "string" && delta.content.length > 0) {
        this.ensureTextBlock(out);
        // biome-ignore lint/style/noNonNullAssertion: just opened by ensureTextBlock
        const block = this.activeBlock!;
        out.push(
          frameEvent({
            type: "content_block_delta",
            index: block.index,
            delta: { type: "text_delta", text: delta.content },
          }),
        );
      }

      // Tool-call deltas.
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          this.handleToolCallDelta(tc, out);
        }
      }
    }

    // finish_reason on this chunk (still followed by .end() to close out).
    if (typeof choice.finish_reason === "string") {
      this.stopReason = finishReasonToStopReason(choice.finish_reason);
    }

    this.captureUsage(chunk);
    return out;
  }

  /**
   * Close the stream. Emits any pending content_block_stop, then the
   * message_delta and message_stop events. Idempotent: a second call
   * returns an empty array.
   */
  end(): string[] {
    if (this.ended) return [];
    this.ended = true;

    const out: string[] = [];

    // If feed() was never called, synthesize an empty message_start so the
    // wire output is always a valid Anthropic stream.
    if (!this.started) {
      this.started = true;
      this.model = this.modelOverride ?? "unknown";
      out.push(
        frameEvent({
          type: "message_start",
          message: {
            id: this.messageId,
            type: "message",
            role: "assistant",
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
    }

    if (this.activeBlock !== null) {
      out.push(frameEvent({ type: "content_block_stop", index: this.activeBlock.index }));
      this.activeBlock = null;
    }

    out.push(
      frameEvent({
        type: "message_delta",
        delta: {
          stop_reason: this.stopReason ?? "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: this.completionTokens },
      }),
    );
    out.push(frameEvent({ type: "message_stop" }));
    return out;
  }

  private ensureTextBlock(out: string[]): void {
    if (this.activeBlock !== null && this.activeBlock.kind === "text") return;
    if (this.activeBlock !== null) {
      out.push(frameEvent({ type: "content_block_stop", index: this.activeBlock.index }));
    }
    const index = this.nextIndex++;
    out.push(
      frameEvent({
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      }),
    );
    this.activeBlock = { kind: "text", index };
  }

  private handleToolCallDelta(tc: OpenAIToolCallDelta, out: string[]): void {
    if (tc === null || typeof tc !== "object" || typeof tc.index !== "number") {
      throw new MalformedInputError("tool_call delta requires a numeric index", "tool_call");
    }
    const openaiIndex = tc.index;
    let blockIndex = this.toolCallToBlockIndex.get(openaiIndex);

    if (blockIndex === undefined) {
      // First time seeing this tool_call index → accumulate id, name, and
      // any argument bytes until we have BOTH id and name. OpenAI's
      // canonical stream provides id + name together on the first chunk,
      // so the deferred path is defensive.
      const meta = this.pendingToolCallMeta.get(openaiIndex) ?? {};
      if (typeof tc.id === "string" && tc.id.length > 0) meta.id = tc.id;
      if (typeof tc.function?.name === "string" && tc.function.name.length > 0) {
        meta.name = tc.function.name;
      }
      this.pendingToolCallMeta.set(openaiIndex, meta);

      if (meta.id === undefined || meta.name === undefined) {
        // Defer block creation. Buffer any argument bytes we've seen so far
        // so we can emit them once the block opens.
        const argsSoFar = this.toolCallArgsAccumulated.get(openaiIndex) ?? "";
        const argsHere = typeof tc.function?.arguments === "string" ? tc.function.arguments : "";
        this.toolCallArgsAccumulated.set(openaiIndex, argsSoFar + argsHere);
        return;
      }

      const id = meta.id;
      const name = meta.name;

      // Close any previously active block.
      if (this.activeBlock !== null) {
        out.push(frameEvent({ type: "content_block_stop", index: this.activeBlock.index }));
        this.activeBlock = null;
      }

      blockIndex = this.nextIndex++;
      this.toolCallToBlockIndex.set(openaiIndex, blockIndex);
      out.push(
        frameEvent({
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "tool_use", id, name, input: {} },
        }),
      );
      this.activeBlock = {
        kind: "tool_use",
        index: blockIndex,
        toolCallIndex: openaiIndex,
      };

      // Flush any pre-buffered argument bytes.
      const buffered = this.toolCallArgsAccumulated.get(openaiIndex) ?? "";
      const argsHere = typeof tc.function?.arguments === "string" ? tc.function.arguments : "";
      const combined = buffered + argsHere;
      if (combined.length > 0) {
        out.push(
          frameEvent({
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: combined },
          }),
        );
        this.toolCallArgsAccumulated.set(openaiIndex, combined);
      }
      return;
    }

    // Existing tool_use block: emit any new argument bytes as input_json_delta.
    const argsHere = typeof tc.function?.arguments === "string" ? tc.function.arguments : "";
    if (argsHere.length === 0) return;

    // Invariant: blockIndex came from toolCallToBlockIndex, which is only
    // set when we open the block AND assign this.activeBlock. activeBlock is
    // never nulled out within feed(); only end() does that, and end() flips
    // `ended` so feed() bails before reaching here. So when we get here,
    // activeBlock is non-null. If it doesn't match blockIndex, an
    // adversarial provider has interleaved tool_call deltas after closing
    // the block — Anthropic's spec forbids re-opening, so throw.
    // biome-ignore lint/style/noNonNullAssertion: invariant documented above
    if (this.activeBlock!.index !== blockIndex) {
      throw new InternalInvariantError(
        `tool_call delta for index ${openaiIndex} arrived after the block was closed; providers must keep tool_call deltas grouped`,
      );
    }

    out.push(
      frameEvent({
        type: "content_block_delta",
        index: blockIndex,
        delta: { type: "input_json_delta", partial_json: argsHere },
      }),
    );
    const prev = this.toolCallArgsAccumulated.get(openaiIndex) ?? "";
    this.toolCallArgsAccumulated.set(openaiIndex, prev + argsHere);
  }

  private captureUsage(chunk: OpenAIChatCompletionChunk): void {
    if (!chunk.usage) return;
    // Anthropic's message_delta surfaces only output_tokens. input_tokens
    // is reported on message_start (where we currently set 0 — no upstream
    // value at start time). Drop prompt_tokens here.
    this.completionTokens = chunk.usage.completion_tokens;
  }
}

/**
 * Module-private monotonic counter for id synthesis. Tests inject their own
 * generator and never read this.
 */
let idCounter = 0;

/**
 * Test-only helper: reset the internal id counter. Not exported from the
 * public surface in `src/index.ts`.
 */
export function __resetIdCounterForTests(): void {
  idCounter = 0;
}

/**
 * Type re-export for callers writing their own driver loops.
 */
export type { AnthropicStreamEvent };
