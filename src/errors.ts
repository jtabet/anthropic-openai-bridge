/**
 * Typed error classes used across the library.
 *
 * The library sits at a protocol boundary where consumers need to programmatically
 * distinguish "your input is malformed" from "you used an unsupported feature"
 * from "internal invariant violated." Each public function documents which of
 * these it may throw via JSDoc.
 *
 * All error classes set a stable `name` (used as the discriminant) and extend
 * the standard `Error`, so they cross `instanceof` boundaries cleanly across
 * realms when the library is bundled.
 */

export class BridgeError extends Error {
  public override readonly name: string = "BridgeError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the caller provides input that does not conform to the
 * expected Anthropic or OpenAI shape. Includes a path-style locator so
 * the caller knows which field failed validation.
 */
export class MalformedInputError extends BridgeError {
  public override readonly name = "MalformedInputError";
  public readonly path: string;

  constructor(message: string, path: string, options?: { cause?: unknown }) {
    super(`${message} (at ${path})`, options);
    this.path = path;
  }
}

/**
 * Thrown when the caller uses an Anthropic feature this library does not
 * (yet) translate. The decision to throw vs silently drop is per-feature:
 * `thinking` is dropped silently (documented in README) since dropping it
 * preserves the semantic intent; image content blocks throw because silent
 * drop would lose user-supplied context.
 */
export class UnsupportedFeatureError extends BridgeError {
  public override readonly name = "UnsupportedFeatureError";
  public readonly feature: string;

  constructor(feature: string, message?: string) {
    super(message ?? `Anthropic feature "${feature}" is not supported by this bridge.`);
    this.feature = feature;
  }
}

/**
 * Thrown when the library detects an internal invariant violation —
 * a "this should never happen" guard. If this fires in production it
 * indicates a bug in the library, not in the caller's input.
 */
export class InternalInvariantError extends BridgeError {
  public override readonly name = "InternalInvariantError";

  constructor(message: string) {
    super(`Internal invariant violated: ${message}`);
  }
}
