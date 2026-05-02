# dd-trace-js Code Review Checklist


## Architecture & Design

**BLOCKER when a shortcut bypasses the intended system design.**

- Route through designed interfaces — don't call internal APIs directly when a public interface exists (Diagnostics Channel, `runStores`/`bindStore`, propagator interfaces).
- Don't mix cross-cutting concerns. Systems that are intentionally separate (e.g., baggage and span context) must stay separate.
- Use proper store lifecycle (`runStores`/`bindStore`) instead of `WeakRef`.
- Don't add helpers that only call another function with no transformation. Inline them.
- Only export symbols that are used outside of the file.
- Functions called in only one place should be inlined for clarity, if they are do not provide a good abstraction by themselves.
- Plugin hook setup that is repetitive should be made implicit via `addHooks`.

---

## Performance & Memory

**BLOCKER or CONCERN in hot paths; CONCERN elsewhere.**

- dd-trace runs in application hot paths — every allocation and lookup counts.
- Flag unbounded collections: streams, maps, or listeners that can grow without limit.
- Flag unnecessary allocations or object creation.
- A Map keyed by user-operation objects (requests, contexts) must have a guaranteed cleanup path, or use `WeakMap` instead. Timer-based cleanup is risky — it can cause sawtooth memory growth.
- Prefer lazy initialisation: don't create expensive objects or run expensive computations until they are needed.
- Benchmarks are required to proof performance improvement claims

---

## Configuration System

**BLOCKER when registration is missing.**

- New environment variables must be defined in `packages/dd-trace/src/config/index.js` inside `#applyEnvironment()`.
- Every new env var must have an entry in `supported-configurations.json` with a `configurationNames` field.
- Every new env var must be registered for telemetry.
- `supported-configurations.json` must not be corrupted (watch for rebase artifacts).
- Don't add a new boolean toggle that mirrors an existing option. If a feature is enabled by a parent config, it should not need its own sub-toggle.

---

## Async & Correctness

**BLOCKER for unhandled rejections; CONCERN for logic issues.**

- Sequential `await` calls where rejection of the first would leave the second as an unhandled rejection must be rewritten as `Promise.all([...])`.
- Don't rely on NaN being falsy — be explicit. TypeScript rejects it and it obscures intent.
- Don't introduce a fallback that silently changes existing behaviour (e.g., `undefined` → `null`).
- Check whether a Node.js built-in API already solves the problem before writing a custom workaround.

---

## Test Quality

**BLOCKER for missing bug-fix tests or broken test isolation; CONCERN for flakiness risks.**

- Every bug fix must have a test that would have caught the bug.
- Plugin tests are integration tests — don't mock tracer internals. Reconfigure via the public API instead.
- Cleanup/reset logic must be in `afterEach`, not after an assertion. If the assertion throws, the reset never runs.
- Don't spy on implementation details — test behaviour only.
- Each `it` block must be independently runnable with `it.only`. If it depends on side effects from a previous `it`, move the shared setup into `beforeEach` and teardown into `afterEach`.
- Don't add an existence check (`assert(x.foo)`) immediately before asserting the value (`assert.strictEqual(x.foo, 'bar')`). Assert the value directly.
- Combine multiple `assert.strictEqual` calls on the same object into a single `assert.deepStrictEqual` or `assertObjectContains` call.
- Check for copy-paste mistakes: duplicate assertions on the same property.

---

## Code Style & Readability

**NIT unless it affects correctness.**

- Use `#private` class fields instead of `_underscore` prefixes for class-internal state.
- Pre-construct objects with all possible fields (some `undefined`) to keep V8 object shapes stable. Don't conditionally add properties after construction.
- Use static class properties, not static getters (static getters are a holdover from before static properties were supported).
- Non-class symbols must not have a leading capital letter.
- `require()` calls must be at the top of the file. Only the instantiation (not the require) should be inside try/catch if the require itself cannot fail.
- Keep try/catch blocks narrow — wrap only the code that can actually throw.
- Avoid bitwise or type-coercion tricks that require knowing operator precedence or implicit coercion rules. Write explicit, readable code.
- Remove commented-out code before merging.

---

## Observability & Logging

**CONCERN when silent failures are possible; NIT for improvements.**

- Don't remove existing log or debug output without a replacement. Diagnostic information helps production debugging.
- Any code path where a feature could silently fail should have a log statement.
- `catch` blocks that swallow errors should log them.
- Log at the point of failure, not only at the call site.

---

## Documentation & PR Hygiene

**CONCERN or NIT.**

- Unrelated changes belong in a separate PR.
- A new CI workflow must be justified — prefer adding to an existing workflow.
- Retry logic must be scoped: only commands that can be flaky (e.g., registry installs) should be retried.
- New public API surface area requires a semver-minor label and may require a corresponding PR in dd-trace-api-js.
- AGENTS.md: prefer inline code over fenced code blocks (token efficiency). Avoid vague language; use concrete examples.
- AGENTS.md must not contain inaccurate or contradictory claims, and should not include contributing-guide content that belongs in CONTRIBUTING.md.
- Moving a file to a new directory must not change a user-facing `require()` path.
