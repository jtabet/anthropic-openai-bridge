# Contributing

Thanks for your interest. This is a small, single-purpose library; the contribution bar is high on **correctness** and low on **scope creep**.

## Ground rules

- **Match the existing shape.** Pure functions, framework-agnostic, zero runtime dependencies. If a PR adds a runtime dependency it will not land.
- **One concern per PR.** Bug fixes and features go in separate PRs.
- **Tests required.** New code must keep coverage at 100% on `src/` (enforced by CI).
- **Match the existing style.** Run `bun run lint:fix` before committing.

## Dev setup

```bash
git clone https://github.com/jtabet/anthropic-openai-bridge.git
cd anthropic-openai-bridge
bun install
```

(npm and pnpm work too. CI uses bun.)

## Common commands

```bash
bun run typecheck         # tsc --noEmit
bun run lint              # biome check
bun run lint:fix          # auto-fix
bun run test              # vitest run
bun run test:coverage     # with coverage (run under node, see below)
bun run build             # tsup → dist/
bun run verify            # lint + typecheck + coverage + build (CI-equivalent)
```

### Coverage note

Vitest v8 coverage requires Node's v8 inspector and does not run under bun's runtime. The `test:coverage` script invokes vitest under node. Plain `bun run test` works fine for non-coverage runs.

## Workflow

1. **Fork & branch.** Branch from `main`.
2. **Make your change.** Keep commits focused; squash if needed before pushing.
3. **Open a PR.** CI must be green: lint, typecheck, full test suite, 100% coverage, build, CodeQL.
4. **Wait for review.** Small targeted PRs land fast.

Releases are tag-driven and cut by the maintainer (see README → "Publishing a release"). No changeset file required per PR.

## Adding a test fixture

The most common contribution is a fixture covering a real-world request/response pair the library didn't quite handle.

1. Capture the offending input (sanitize secrets first).
2. Add a new `it(...)` to the relevant `test/*.test.ts`. Prefer the existing file over creating a new one.
3. Assert the output. If you need to extend coverage to a new code path, make sure 100% is preserved.

## Coding standards (the short list)

- **TypeScript strict mode**, no `any` in `src/` (Biome enforces).
- **Errors are typed classes.** Never `throw new Error(string)` in `src/`.
- **No I/O, no global state** in `src/` (except the deterministic-by-default id counter in `stream.ts`).
- **Input validation at the boundary.** Public functions validate input shape and throw `MalformedInputError` with a path-style locator on bad input.
- **Public surface only via `src/index.ts`.** Adding an export needs a matching update to `test/api.test.ts`.

## Code of conduct

Be respectful and constructive. See [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

## License

Contributions are licensed under [Apache-2.0](./LICENSE), the same as the project.
