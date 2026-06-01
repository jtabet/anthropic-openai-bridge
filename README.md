# @jtabet/anthropic-openai-bridge

[![CI](https://github.com/jtabet/anthropic-openai-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/jtabet/anthropic-openai-bridge/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@jtabet/anthropic-openai-bridge.svg)](https://www.npmjs.com/package/@jtabet/anthropic-openai-bridge)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen.svg)](https://github.com/jtabet/anthropic-openai-bridge)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Provenance](https://img.shields.io/badge/npm-provenance-blueviolet.svg)](https://docs.npmjs.com/generating-provenance-statements)

Translate between the **Anthropic Messages API** (`POST /v1/messages`) and the **OpenAI Chat Completions API** (`POST /v1/chat/completions`). Pure functions, framework-agnostic, zero runtime dependencies. Lets you point Claude Code (or any Anthropic SDK client) at any OpenAI-compatible backend.

## What it is

A small TypeScript library that exposes three things:

1. `anthropicToOpenAIRequest()` — converts an Anthropic Messages request to an OpenAI Chat Completions request.
2. `openAIToAnthropicResponse()` — converts a non-streaming OpenAI response back to an Anthropic Message.
3. `AnthropicStreamEncoder` — stateful encoder that turns a stream of OpenAI `ChatCompletionChunk`s into the Anthropic SSE event sequence (`message_start` / `content_block_*` / `message_delta` / `message_stop`).

You wire them into your own HTTP route. The library has no idea what Express, Hono, or Bun.serve are.

## What it is *not*

- **Not a server.** If you want a drop-in proxy binary, look at [LiteLLM](https://github.com/BerriAI/litellm), [claude-code-proxy](https://github.com/fuergaosi233/claude-code-proxy), [anthropic-proxy](https://github.com/maxnowack/anthropic-proxy), or [@tokligence/gateway](https://www.npmjs.com/package/@tokligence/gateway).
- **Not a multi-provider router.** It does one thing: format translation.
- **Not opinionated about auth, billing, or caching.** Those belong in your service.
- **Not the reverse direction (OpenAI → Anthropic).** Planned for a later minor release.

## Install

```bash
# bun
bun add @jtabet/anthropic-openai-bridge

# npm
npm install @jtabet/anthropic-openai-bridge

# pnpm
pnpm add @jtabet/anthropic-openai-bridge
```

Peer dependencies (`@anthropic-ai/sdk` and `openai`) are **types-only and optional** — install them only if you want type-narrowed objects on your side.

## Quick start

### Request conversion

```ts
import { anthropicToOpenAIRequest } from "@jtabet/anthropic-openai-bridge";

const openaiReq = anthropicToOpenAIRequest({
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  system: "You are concise.",
  messages: [{ role: "user", content: "Hello!" }],
});
// → { model: "claude-sonnet-4-6", max_tokens: 1024,
//     messages: [{role:"system",content:"You are concise."},
//                {role:"user",content:"Hello!"}] }
```

### Non-streaming response conversion

```ts
import { openAIToAnthropicResponse } from "@jtabet/anthropic-openai-bridge";

const anthropicResp = openAIToAnthropicResponse(openaiResponse);
// → { id, type: "message", role: "assistant", content: [...],
//     stop_reason: "end_turn" | "tool_use" | ..., usage: {...} }
```

### Streaming

```ts
import { AnthropicStreamEncoder } from "@jtabet/anthropic-openai-bridge";

const enc = new AnthropicStreamEncoder({ modelOverride: "claude-sonnet-4-6" });

for await (const chunk of openaiChatCompletionStream) {
  for (const sseFrame of enc.feed(chunk)) {
    res.write(sseFrame);
  }
}
for (const sseFrame of enc.end()) {
  res.write(sseFrame);
}
res.end();
```

See [`examples/`](./examples) for full Express and Bun shims (~30 LoC each).

## Feature matrix

| Anthropic feature                  | Status      | Notes |
|------------------------------------|-------------|-------|
| System prompt (string)             | ✅ Supported |       |
| System prompt (text-block array)   | ✅ Supported | Concatenated with `\n\n` |
| `role: "system"` messages in array | ✅ Supported | Hoisted to the leading system message, concatenated with `\n\n`. OpenAI's Chat Completions API requires every system message to sit at index 0; the bridge enforces that invariant even when clients (e.g. Claude Code) inject system reminders mid-conversation. |
| Text content blocks                | ✅ Supported |       |
| `tool_use` / `tool_result` blocks  | ✅ Supported |       |
| `tool_choice` (auto/any/tool/none) | ✅ Supported | `any` → OpenAI `required` |
| `tools[].input_schema`             | ✅ Supported | Passed through verbatim as `function.parameters` |
| Streaming SSE                      | ✅ Supported | Full event-ordering spec |
| `stop_sequences`                   | ✅ Supported | → OpenAI `stop` |
| `metadata.user_id`                 | ✅ Supported | → OpenAI `user` |
| `is_error` on `tool_result`        | ✅ Supported | Content prefixed with `[error]` |
| `thinking` blocks                  | ⚠️ Dropped   | No OpenAI analogue — silently discarded |
| `top_k`                            | ⚠️ Dropped   | No OpenAI analogue |
| Image content blocks (user)        | ✅ Supported | `base64` & `url` sources → OpenAI `image_url` vision parts |
| Image blocks (assistant/tool_result)| ❌ Rejected  | Throws `UnsupportedFeatureError` — OpenAI accepts images only in user content |
| Citations / web search             | ❌ Rejected  | Not modeled in OpenAI Chat Completions |
| `disable_parallel_tool_use`        | ✅ Supported | → OpenAI `parallel_tool_calls: false` |

## Examples

- [`examples/express-shim.ts`](./examples/express-shim.ts) — add a `/v1/messages` route to an existing OpenAI-compatible proxy in ~30 LoC.
- [`examples/bun-serve-shim.ts`](./examples/bun-serve-shim.ts) — same idea, native Bun.

Both show how to:
1. Receive an Anthropic Messages request
2. Convert it
3. Forward to any OpenAI-compatible upstream (Ollama, vLLM, OpenRouter, …)
4. Translate the response (streaming or not) back to Anthropic format

## Design decisions

This section exists so contributors and future maintainers understand *why* the library looks the way it does. Format per decision: **Decision** / **Why** / **Trade-off** / **Revisit if**.

### Pure functions over an HTTP server

- **Decision.** Ship pure transformer functions + a stateful streaming encoder class. No HTTP server, no framework adapter, no router.
- **Why.** Every existing alternative (LiteLLM, claude-code-proxy, anthropic-proxy, @tokligence/gateway) is a standalone server, which forces consumers to either run an extra process or fork and strip the server layer. A library lets each consumer keep its own auth, routing, metrics, encryption, and tracing.
- **Trade-off.** Users must wire up an HTTP route themselves. Mitigated by `examples/`.
- **Revisit if.** A second package (e.g. `@jtabet/anthropic-openai-bridge-express`) becomes useful — but the core stays pure.

### Anthropic → OpenAI only in v0.1.0

- **Decision.** Only translate Anthropic Messages requests into OpenAI Chat Completions, and the response shape back. The reverse direction is not implemented.
- **Why.** The driving use case is "let Claude Code talk to an OpenAI-compatible backend." Shipping bidirectional from day one doubles the test surface and the streaming state machines for no concrete consumer.
- **Trade-off.** Anyone wanting to expose Anthropic models behind an OpenAI-compatible API can't use this package yet.
- **Revisit if.** A real consumer needs the reverse direction.

### Apache-2.0 license

- **Decision.** Apache-2.0, not MIT or BSD.
- **Why.** The library mirrors the wire format of two commercial APIs. The explicit patent grant in Apache-2.0 protects contributors and downstream users from any future patent claim around translation logic.
- **Trade-off.** Marginally more text in `LICENSE` and a required `NOTICE` file.
- **Revisit if.** Apache-2.0 friction blocks adoption in a high-value consumer (unlikely — most large orgs prefer Apache over MIT).

### Zero runtime dependencies, peer-deps for types

- **Decision.** `dependencies: {}`. `peerDependencies` lists `@anthropic-ai/sdk` and `openai`, marked `optional: true`.
- **Why.** Eliminates supply-chain risk. Consumers pin SDK versions to their own tolerance. Optional peers mean users who don't need typed objects on their side don't need to install the SDKs.
- **Trade-off.** Type definitions are duplicated in `src/types.ts` rather than re-exported from the SDKs.
- **Revisit if.** The SDKs publish a stable, decoupled `types-only` package we can depend on without runtime risk.

### Own type definitions in `src/types.ts`

- **Decision.** Define the wire-format types we read and emit ourselves; do not import from `@anthropic-ai/sdk` or `openai` SDKs.
- **Why.** The SDK types evolve. The wire format does not (much). Decoupling makes the bridge's semver independent of the SDK's, and documents in one place exactly which fields the library inspects.
- **Trade-off.** Some duplication of types that already exist in the SDKs.
- **Revisit if.** The SDK publishes a stable subset of "wire format only" types we can rely on.

### ESM + CJS dual build via tsup

- **Decision.** Build both ESM (`dist/index.js`) and CJS (`dist/index.cjs`), with matching `.d.ts` / `.d.cts`.
- **Why.** ESM-only locks out CJS consumers, still common in Node servers and some Next.js API routes. Dual build adds zero authoring cost via tsup.
- **Trade-off.** Two output files instead of one. Negligible.
- **Revisit if.** CJS becomes irrelevant for the Node and Next.js consumers this targets.

### Bun (not pnpm) as package manager during development

- **Decision.** Use `bun install` / `bun run` / `bun.lock` rather than pnpm + `pnpm-lock.yaml`.
- **Why.** Bun has a strict lockfile (`bun.lock`) and a fast install/run path. The published package is npm-registry-standard and works with any installer, so this choice never leaks to consumers.
- **Trade-off.** Contributors must install bun. The README and CONTRIBUTING document this.
- **Revisit if.** A consumer-facing reason emerges to use a more universal manager during dev.

### Biome (not ESLint + Prettier)

- **Decision.** Single tool, single config, one binary.
- **Why.** Faster, one config file, no ESLint-vs-Prettier interop nonsense. Standard 2026 choice for new libraries.
- **Trade-off.** Smaller plugin ecosystem than ESLint. Unimportant here — no specialized plugins are needed.
- **Revisit if.** A specific Biome gap blocks a critical lint rule. None known.

### Vitest (not Jest)

- **Decision.** Native ESM, native TS, faster startup.
- **Why.** Jest's ESM story is still rough; configuration drift dominates the value of any feature it has and Vitest doesn't.
- **Trade-off.** None worth mentioning.
- **Revisit if.** Vitest goes unmaintained.

### Tag-driven releases (no Changesets)

- **Decision.** Releases fire on a `v*` git tag. The workflow runs verify, then `npm publish` with provenance via Trusted Publishing. No release PR.
- **Why.** This is a small, single-maintainer library with infrequent releases. Changesets' "Version Packages PR" flow earns its keep when many contributors queue changes between releases; here it was pure ceremony. Tagging is one command, mental model is "tag = release."
- **Trade-off.** No automatic version-bump validation and no auto-generated changelog (GitHub Release notes are generated from PR titles via `softprops/action-gh-release`, which is good enough for now). You bump `package.json` by hand.
- **Revisit if.** The project gains regular contributors or releases get frequent enough that a batched release PR would actually batch something.

### 100% line + branch coverage gate

- **Decision.** Vitest fails CI if coverage of `src/` drops below 100% on lines, branches, statements, or functions.
- **Why.** The library sits at a protocol boundary where a bug corrupts every request that flows through. The library is small enough that 100% coverage is cheap; the cost of a translation bug is high because it appears as inscrutable upstream errors to whoever owns the consumer.
- **Trade-off.** A defensive branch with no test trips CI even when it's "obviously fine." Forces explicit thinking about every branch.
- **Revisit if.** The coverage gate stops catching real bugs and starts costing real time. Lower to 95% then.

### Streaming state machine isolated from the transformers

- **Decision.** `AnthropicStreamEncoder` is a class with explicit state; the request and response transformers are pure functions.
- **Why.** Streaming has fundamentally different semantics — incremental, stateful, order-sensitive — than one-shot translation. Mixing them would make both harder to reason about.
- **Trade-off.** Two slightly different APIs for callers to learn.
- **Revisit if.** A unified, generator-based API becomes idiomatic in 2026+ TypeScript.

### Typed error classes (not `throw new Error(string)`)

- **Decision.** Three error classes — `MalformedInputError`, `UnsupportedFeatureError`, `InternalInvariantError` — each with a stable `name` discriminant.
- **Why.** Consumers need to programmatically distinguish "your input is malformed" from "you used an unsupported feature" from "internal invariant violated." Bare `Error` forces string matching.
- **Trade-off.** A couple dozen extra LoC.
- **Revisit if.** Need a richer error taxonomy. The current three cover every observed case.

### `thinking` blocks dropped (not translated)

- **Decision.** Anthropic `thinking` content blocks are silently dropped on the request side. The `thinking` request field is also dropped.
- **Why.** OpenAI has no equivalent. Faking it would be wrong; throwing would prevent any Claude-Code-with-extended-thinking traffic from flowing.
- **Trade-off.** Loss of reasoning context if the model relies on it.
- **Revisit if.** OpenAI ships a comparable feature, or when a consumer needs a lossy compatibility mode that surfaces thinking as plain text.

### Vision/image content blocks translated in user turns; rejected elsewhere

- **Decision.** Image blocks in **user** messages translate to OpenAI `image_url` vision parts (`base64` → a `data:` URL, `url` → passthrough). Image blocks in **assistant** messages or inside a `tool_result` still throw `UnsupportedFeatureError`.
- **Why.** OpenAI accepts images only in user content, so user-turn images have a faithful mapping. There is no slot for an image in an assistant or tool message — silently dropping one would lose context the caller can't detect, so an explicit error stays the safer default there. A user turn that contains an image is emitted as an ordered parts array; image-free turns stay a plain concatenated string, so existing translations are byte-identical.
- **Trade-off.** Two code paths for user content (string vs. parts array). Consumers using assistant/tool_result images must still catch the error.
- **Revisit if.** OpenAI introduces an image representation for assistant or tool messages.

### `role: "system"` messages hoisted to the leading system message

- **Decision.** Every `role: "system"` message found anywhere in the `messages` array is extracted and merged with the top-level `system` field into a single leading OpenAI system message. Parts are concatenated in original order with `\n\n` separators (top-level first, then array-resident system messages in their array order).
- **Why.** OpenAI's Chat Completions API has a hard constraint: all system messages must sit at index 0 (and be consecutive). Forwarding a system message at any other index produces `400 "System message must be at the beginning"`. Anthropic itself doesn't document `role: "system"` in the messages array, but the official SDK's `MessageParam` type also doesn't include it — yet some Anthropic-compatible clients (notably Claude Code) inject system reminders mid-conversation for things like `[Request interrupted by user]`, environment stamps, and post-tool context. Rejecting those would break the most common real-world consumer. Hoisting preserves the content's reach to the model while satisfying the upstream constraint.
- **Trade-off.** Loss of in-conversation temporal positioning for system content. The model sees all system content collapsed at the start rather than at the point the client intended. In practice this rarely matters because the semantic intent (a reminder, a date stamp, a re-injection) is the same regardless of where in the array it sits. Consumers wanting strict positional fidelity can intercept system messages on the Anthropic side before they reach the bridge.
- **Revisit if.** OpenAI relaxes the leading-only requirement (it has not, as of 2026), or Anthropic ships a typed top-level mechanism for mid-conversation system reminders that lets us model them more faithfully on the OpenAI side.

### Public surface only via `src/index.ts`

- **Decision.** Only re-exports from `src/index.ts` are public. An API snapshot test in `test/api.test.ts` fails if the surface changes.
- **Why.** Lets us refactor freely within `src/` without breaking consumers.
- **Trade-off.** Adding an export takes two commits (one to add, one to update the snapshot).
- **Revisit if.** The two-commit overhead becomes a real friction point.

## Versioning & stability

Semantic versioning. A change is a **major** bump if it alters the wire output for a given input (i.e., translates the same Anthropic request into a different OpenAI request than before). New supported features are minor bumps. Bug fixes and stricter input validation are patches.

## Publishing a release (maintainers)

Releases are tag-driven. To publish a new version:

```bash
# 1. Update version in package.json (use semver: patch / minor / major)
npm version patch       # or minor / major; creates the git tag too

# 2. Push commit + tag
git push --follow-tags
```

The `release.yml` workflow fires on the `v*` tag, runs the full verify pipeline, then publishes to npm with provenance via Trusted Publishing (OIDC). A GitHub Release is created automatically with notes generated from PR titles since the last tag.

If you need to publish from the GitHub UI instead (e.g. after fixing a misconfigured workflow), run the *Release* workflow manually via `Actions → Release → Run workflow`. The tag-match check ensures `package.json` and the tag agree before publish.

## Security

See [`SECURITY.md`](./SECURITY.md). Private vulnerability reporting via GitHub Security Advisories.

The library treats input as untrusted (in production it is literally user-controlled LLM traffic), validates at the boundary, and uses typed errors at every failure path. No `eval`, no `Function()`, no dynamic `require`, no runtime dependencies. Published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) via GitHub Actions OIDC.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). The most common contribution is adding a fixture or test case.

## License

[Apache-2.0](./LICENSE). See [`NOTICE`](./NOTICE) for attribution.

## Prior art

The streaming state machine in `src/stream.ts` is informed by [`maxnowack/anthropic-proxy`](https://github.com/maxnowack/anthropic-proxy) (MIT). The Anthropic SSE event vocabulary follows the [official spec](https://docs.anthropic.com/en/api/messages-streaming).
