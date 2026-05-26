# Security policy

## Supported versions

The latest minor release line receives security fixes. Older lines may receive critical fixes at maintainer discretion.

| Version | Supported          |
|---------|--------------------|
| 0.1.x   | ✅                 |

## Reporting a vulnerability

**Do not file public issues for security problems.**

Use [GitHub Security Advisories](https://github.com/jtabet/anthropic-openai-bridge/security/advisories/new) to report privately, or email **dev@jeremietabet.com** with subject line beginning with `[security]`.

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (or a proof-of-concept)
- Affected versions
- Whether you would like to be credited in the public advisory

I will acknowledge within 72 hours and aim to ship a fix within 14 days for high-severity issues.

## Threat model

The library sits at a protocol boundary and translates input that is, in production, **user-controlled LLM traffic**. Threats considered:

- **Malformed input** that crashes the translator → mitigated by strict input validation returning typed `MalformedInputError`.
- **Injection via tool_call JSON arguments** → arguments are not evaluated; they're carried as opaque strings (request) or `JSON.parse`'d into plain data (response). No `eval`/`Function()`/dynamic `require` anywhere in `src/`.
- **Supply chain** → zero runtime dependencies. Peer-deps are types-only and optional. Lockfile committed; CI uses `--frozen-lockfile`. Published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) via GitHub Actions OIDC.
- **Prototype pollution** → input objects are read by property access only; no `Object.assign(input, ...)` with caller-controlled keys, no `JSON.parse` of input *keys*.
- **Resource exhaustion** → not in scope; consumers must bound request size at their HTTP layer.

## Out of scope

- Vulnerabilities in `@anthropic-ai/sdk`, `openai`, Node, or any consuming application.
- Misuse of the library to forward traffic to malicious endpoints — that's a deployment concern, not a library concern.
