---
"@jtabet/anthropic-openai-bridge": minor
---

Initial public release.

- `anthropicToOpenAIRequest()` — convert Anthropic Messages API requests to OpenAI Chat Completions requests
- `openAIToAnthropicResponse()` — convert non-streaming OpenAI responses back to Anthropic Message shape
- `AnthropicStreamEncoder` — stateful encoder that turns OpenAI streaming chunks into Anthropic SSE events
- Typed errors (`MalformedInputError`, `UnsupportedFeatureError`, `InternalInvariantError`)
- Strict input validation at the protocol boundary
- 100% line + branch coverage
- Zero runtime dependencies, ESM + CJS dual build, published with npm provenance
