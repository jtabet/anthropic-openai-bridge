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
| Image content blocks               | ❌ Rejected  | Throws `UnsupportedFeatureError`. Planned for v0.2 |
| Citations / web search             | ❌ Rejected  | Not modeled in OpenAI Chat Completions |
| `disable_parallel_tool_use`        | ⚠️ Dropped   | Could map to OpenAI `parallel_tool_calls: false` in a future minor |

## Examples

- [`examples/express-shim.ts`](./examples/express-shim.ts) — add a `/v1/messages` route to an existing OpenAI-compatible proxy in ~30 LoC.
- [`examples/bun-serve-shim.ts`](./examples/bun-serve-shim.ts) — same idea, native Bun.

Both show how to:
1. Receive an Anthropic Messages request
2. Convert it
3. Forward to any OpenAI-compatible upstream (Ollama, vLLM, OpenRouter, Patchbay, …)
4. Translate the response (streaming or not) back to Anthropic format

## Design decisions

This section exists so contributors (and future-me) understand *why* the library looks the way it does. Format per decision: **Decision** / **Why** / **Trade-off** / **Revisit if**.

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
- **Why.** The library mirrors the wire format of two commercial APIs. The explicit patent grant in Apache-2.0 protects contributors and downstream users from any future patent claim around translation logic. MIT would have been the lazy choice.
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
- **Revisit if.** CJS becomes irrelevant. Not in 2026.

### Bun (not pnpm) as package manager during development

- **Decision.** Use `bun install` / `bun run` / `bun.lock` rather than pnpm + `pnpm-lock.yaml`.
- **Why.** This was originally planned as pnpm. In the dev environment, `npm` had a broken default prefix and couldn't install pnpm globally without sudo. Bun was already installed, has a strict lockfile (`bun.lock`), and matches the consumer project's stack. The published package is npm-registry-standard and works with any installer.
- **Trade-off.** Contributors must install bun. The README and CONTRIBUTING document this.
- **Revisit if.** A consumer-facing reason emerges to use a more universal manager during dev.

### Biome (not ESLint + Prettier)

- **Decision.** Single tool, single config, one binary.
- **Why.** Faster, one config file, no ESLint-vs-Prettier interop nonsense. Standard 2026 choice for new libraries.
- **Trade-off.** Smaller plugin ecosystem than ESLint. Unimportant here — no specialized plugins are needed.
- **Revisit if.** A specific Biome gap blocks a critical lint rule. None known.

### Vitest (not Jest)

- **Decision.** Native ESM, native TS, faster startup, matches Patchbay's stack.
- **Why.** Jest's ESM story is still rough; configuration drift dominates the value of any feature it has and Vitest doesn't.
- **Trade-off.** None worth mentioning.
- **Revisit if.** Vitest goes unmaintained. Not on the horizon.

### Changesets for releases

- **Decision.** PR-driven version bumps + changelog via `@changesets/cli`.
- **Why.** De facto standard for serious npm libs. Each PR adds a `.changeset/<slug>.md` describing the change and the bump level; CI then opens a "Version Packages" PR that, when merged, tags and publishes.
- **Trade-off.** Slight ceremony per PR.
- **Revisit if.** A drop-in alternative offers a noticeably better DX.

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

### Vision/image content blocks rejected (not dropped)

- **Decision.** Image content blocks throw `UnsupportedFeatureError`.
- **Why.** Unlike `thinking`, dropping an image would lose user-supplied context — silently degrading the request in a way the caller would have no way to detect. An explicit error is the safer default.
- **Trade-off.** Consumers wanting partial functionality must catch the error and choose what to do.
- **Revisit if.** Image-block translation lands in v0.2 (mapping to OpenAI vision parts is doable).

### Public surface only via `src/index.ts`

- **Decision.** Only re-exports from `src/index.ts` are public. An API snapshot test in `test/api.test.ts` fails if the surface changes.
- **Why.** Lets us refactor freely within `src/` without breaking consumers.
- **Trade-off.** Adding an export takes two commits (one to add, one to update the snapshot).
- **Revisit if.** This becomes annoying. Probably won't.

## Versioning & stability

Semantic versioning. A change is a **major** bump if it alters the wire output for a given input (i.e., translates the same Anthropic request into a different OpenAI request than before). New supported features are minor bumps. Bug fixes and stricter input validation are patches.

## Security

See [`SECURITY.md`](./SECURITY.md). Private vulnerability reporting via GitHub Security Advisories.

The library treats input as untrusted (in production it is literally user-controlled LLM traffic), validates at the boundary, and uses typed errors at every failure path. No `eval`, no `Function()`, no dynamic `require`, no runtime dependencies. Published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) via GitHub Actions OIDC.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). PRs land via Changesets; the most common contribution is adding a fixture or test case.

## License

[Apache-2.0](./LICENSE). See [`NOTICE`](./NOTICE) for attribution.

## Prior art

The streaming state machine in `src/stream.ts` is informed by [`maxnowack/anthropic-proxy`](https://github.com/maxnowack/anthropic-proxy) (MIT). The Anthropic SSE event vocabulary follows the [official spec](https://docs.anthropic.com/en/api/messages-streaming).
