# AGENTS.md

## Prerequisites

- Node.js >= 18
- yarn 1.x
- Docker + docker-compose (for running service dependencies in tests)

## Setup

**Package manager policy:**

- Use **yarn only for installing dependencies and services**:
  - `yarn add`
  - `yarn install`
  - `yarn services`
- Use **npm for running scripts and other commands**: `npm run <script>`
- In this repo, **everything else** (tests, lint, build, etc.) should use **npm**, not yarn.
- `yarn services` is the only non-install yarn command: it sets up test service/plugin dependencies.

## Project Overview

dd-trace is the Datadog client library for Node.js.

**Key Directories:**

- `packages/dd-trace/` - Main library (APM, profiling, debugger, appsec, llmobs, CI visibility, etc)
- `packages/datadog-core/` - Async context storage, shared utilities
- `packages/datadog-instrumentations/` - Instrumentation implementations
- `packages/datadog-plugin-*/` - 100+ plugins for third-party integrations
- `integration-tests/` - E2E integration tests
- `benchmark/` - Performance benchmarks

**Packages:** under `packages/`, each package generally has `src/` and `test/`, and unit tests are `*.spec.js`.

## Testing Instructions

**IMPORTANT**: The root `npm test` is intentionally disabled. Always run a specific `*.spec.js` file, or a targeted `npm run test:<area>` script.

**Integration Tests**: Tests in `integration-tests/` require `required_permissions: ["all"]` when run in Cursor's AI environment.

### Running Individual Tests

**Unit tests:**

```bash
./node_modules/.bin/mocha path/to/test.spec.js
```

**Integration test file (usually needs higher timeout):**

```bash
./node_modules/.bin/mocha --timeout 60000 path/to/test.spec.js
```

**If a test expects “spec file is entrypoint” semantics:**

```bash
node scripts/mocha-run-file.js path/to/test.spec.js
```

You can inject mocha options via `MOCHA_RUN_FILE_CONFIG` (JSON), including `require` hooks.

**Common options:**

- `--grep "pattern"` to target tests
- `DD_TRACE_DEBUG=true` to enable debug logging

### Plugin Tests

**Use `PLUGINS` env var:**

```bash
PLUGINS="amqplib" npm run test:plugins
# pipe-delimited for multiple: PLUGINS="amqplib|bluebird"
```

To run a single test file directly:

```bash
./node_modules/.bin/mocha packages/datadog-plugin-<name>/test/index.spec.js
```

**Narrow within plugin tests (optional):**

- Use `SPEC` to filter which `*.spec.js` files run within the selected plugins.

**With external services** (check `.github/workflows/apm-integrations.yml` for `SERVICES`):

```bash
export SERVICES="rabbitmq" PLUGINS="amqplib"
docker compose up -d $SERVICES
yarn services && npm run test:plugins
```

**ARM64 incompatible:** `aerospike`, `couchbase`, `grpc`, `oracledb`

**OTEL env vars from instrumented shells:** Plugin tests use a local mock agent for span assertions. If your shell sets `OTEL_TRACES_EXPORTER=otlp` (Claude Code, Cursor, and other Datadog-telemetry-instrumented terminals do), the tracer routes spans through the OTLP exporter and bypasses the test agent — every span-asserting test silently times out. Unset before running:

```bash
unset OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER
PLUGINS="<name>" npm run test:plugins
```

### Test Coverage

```bash
./node_modules/.bin/nyc --include "packages/dd-trace/src/debugger/**/*.js" \
  ./node_modules/.bin/mocha \
  "packages/dd-trace/test/debugger/**/*.spec.js"
```

**Philosophy:**

- On a bug fix or new feature, scope `--include` to the changed paths and confirm those lines are covered before declaring the work done. Whole-package coverage passing is not the same as coverage on the lines you just touched.
- Integration tests (running in sandboxes) don't count towards nyc coverage metrics
- Don't add redundant unit tests solely to improve coverage numbers
- Focus on covering important production code paths with whichever test type makes sense

### Test Assertions

Use `node:assert/strict` for standard assertions. For partial deep object checks, use `assertObjectContains` from `integration-tests/helpers/index.js`.

- Favor `assert.deepStrictEqual` for the data shape under test; use `assert.strictEqual` for unrelated scalars. Don't manufacture wrapper objects (`{ a, b, c }`) to compress assertion count — they hide which assertion broke and allocate two literals per run for no gain.
- Use `assert.throws(fn, expected)` / `assert.rejects(fn, expected)` instead of `try { … ; assert.fail() } catch (error) { … }`. Pin the relevant error fields in the second argument (`{ code, message: /…/ }`).
- For two awaits that should both settle, use `Promise.all([a, b])`. `await a; await b` leaves `b` unawaited until `a` settles; if `b` rejects in that window Node raises an unhandled rejection.
- For limits / caps / thresholds / windows: pin the last accepted value AND the first rejected value (32-entry cap → cases for 32 and 33). Comfortable distances (10 / 50) miss off-by-one bugs.
- A bug fix ships with cases for the failure AND its siblings sharing the fixed code path. Read the existing spec first so you don't duplicate a permutation already there.

### Time-Based Testing

**Never rely on actual time passing in unit tests.** Use sinon's fake timers to mock time and make tests deterministic and fast.

## Code Style & Linting

### Style

- Prefer optional chaining
- Prefer `#private` class fields when state doesn't cross the class boundary; when it does, expose it as a plain property (`this.foo`). Internal cross-module reads and npm-exposed values both fall here — the distinction is documentation, not access pattern.
- Avoid `get foo()` / `set foo()` accessors. They hide a function call behind property syntax and usually signal an undesigned boundary. Reach for one only for lazy first-read computation or a value that must recompute per access; both are rare. For behavior, use a plain method, not a setter / getter.
- Avoid large refactors of existing `_underscore` fields unless you can prove they are not accessed externally (excluding tests).
- Files shall end with a single new line at the end
- Use destructuring for better code readability
- Line length is capped at 120 characters
- Avoid abbreviations. Use short expressive variable, method, and function names
- Comments only for non-obvious intent, trade-offs, or constraints the code can't carry. Don't narrate what the diff already shows.

### Linting & Naming

- Lint: `npm run lint` / `npm run lint:fix`
- Files: kebab-case
- Naming: the product is **Test Optimization**, not "CI Visibility". Name new dirs, benchmarks, docs and prose `test-optimization`; only keep the legacy `ci-visibility` / `CiVisibility` spelling where it is a pre-existing module path or class (e.g. `AgentlessCiVisibilityEncoder`).

### JSDoc

- Use TypeScript-compatible syntax (`@param {string}`, `@returns {Promise<void>}`, `@typedef`)
- Never use `any` (be specific; use `unknown` only if the type is truly unknown)
- Prefer the most specific type you can infer/identify from context; reuse existing types/typedefs instead of defaulting to `unknown`
- Write the most specific types possible by reading the overall context
- Always define argument types via `@param` on the method/function JSDoc
- Avoid adding inline JSDoc type comments inside method bodies (e.g. `/** @type {...} */ x`).
  - Prefer `@typedef` at file scope + small helper/type-guard functions, then type parameters/returns at the method boundary.
- Prefer type casting over adding runtime type-guard code when the checks are only needed for static typing (e.g., comparisons). Never add extra runtime work just to satisfy types.
- Only add types inside of a method if they cannot be inferred otherwise
- Only rewrite code for better types in case it was explicitly requested by the user
- All new methods should receive a full JSDoc comment
- Reuse existing types, if possible (check appropriate sources)
- Only define the type for a property on a class once

### Import Ordering

Separate groups with empty line, sort alphabetically within each:

1. Node.js core modules (with `node:` prefix)
2. Third-party modules
3. Internal imports (by path proximity, then alpha)

### ECMAScript and Node.js API Standards

**Target Node.js 18.0.0 compatibility.**

- Use modern JS features supported by Node.js (e.g., optional chaining `?.`, nullish coalescing `??`)
- Use `undefined` over `null`, if not required otherwise
- Guard newer APIs with version checks using [`version.js`](./version.js)

### Event handlers

- Avoid adding new listeners, if possible
- Use monitor symbols like `events.errorMonitor` when available
- Use `.once()` methods instead of `.on()`, if the event is only needed once
- If new `beforeExit` events on `process` are needed, add them to `globalThis[Symbol.for('dd-trace')].beforeExitHandlers`

### Performance and Memory

**CRITICAL: Tracer runs in application hot paths - every operation counts.**

- Use fast paths to skip unnecessary steps; use the most performant APIs
- Use V8 knowledge about fast and slow APIs
- Avoid unnecessary allocations/objects/closures; reuse objects/buffers when possible
- Prefer `for-of` / `for` / `while` loops over `forEach`/`map`/`filter` in production code
- `map` may be used if there is just a single transformation for all entries
- **Never** use `for-in` (use `for-of`)
- Do NOT use `async/await` or promises in production code (npm package)
  - Allowed ONLY in: test files, worker threads (e.g., `packages/dd-trace/src/debugger/devtools_client/`)
  - Use callbacks or synchronous patterns instead
- Don't use `Object.keys(obj).length` as an emptiness probe — it allocates the keys array. Track presence with a boolean at the assignment site, probe a known key (`obj.knownField !== undefined`), or return `undefined` when there's nothing to report.
- Fold gate + payload into one pass when the gate's question and the work share a computation. Stringify once and gate on `result.length` beats `Object.keys(dd).length === 0` then later `JSON.stringify(dd)`.
- Cache compiled regexes and parsed values at module load; never compile per-call.
- Prefer one-time data transformations (e.g., at file load time) over call-site transformations later.
- Order short-circuit chains by `frequency × cheapness`: the cheap common case first, the expensive rare case last. A `value === null` check outside an enclosing `typeof === 'object'` arm pays the null comparison on every primitive — move it inside.

**Verifying perf-motivated changes.** A rewrite justified by speed (`for` replacing `.map()`, hand-inlined helper, `new Array(n)` + indexed assignment over `.map()`) needs a one-file microbenchmark before it lands. Warm up for ~1 s, time ≥5 trials of each implementation, then re-run in a fresh shell to confirm the numbers reproduce. Decide: **equal** (within ~±2 %) → keep the more readable one; **marginal** (~5 %) → justify the trade-off in the commit body; **real** (≥10 %, reproducible) → keep, and put the numbers in the commit body. Throw the benchmark file away once the decision lands, or graduate it to `benchmark/sirun/` if it has lasting value.

### Debugging and Logging

Use `log` (`packages/dd-trace/src/log/index.js`) with printf-style formatting (not template strings). Use the callback form for expensive formatting.

Enable: `DD_TRACE_DEBUG=true DD_TRACE_LOG_LEVEL=info node app.js`
Levels: `trace`, `debug`, `info`, `warn`, `error`

### Error Handling

**Never crash user apps:** Catch/log errors (`log.error()`/`log.warn()`), resume or disable plugin/subsystem
Avoid try/catch in hot paths - validate inputs early

## Development Workflow

### Core Principles

- **Search first**: Check for existing utilities/patterns before creating new code
- **Avoid diverging implementations**: If behavior already exists elsewhere, reuse it or extract a shared helper instead of reimplementing it in a second place.
- **Minimal public surface**: Don't add new programmatic public APIs without an explicit case — removing them later is painful. If an internal caller needs reach, add a narrow internal method on the producer, not a public one.
- **Small PRs**: Break large efforts into incremental, reviewable changes
- **Descriptive code**: Self-documenting with verbs in function names; comment when needed
- **Readable formatting**: Empty lines for grouping, split complex objects, extract variables
- **Avoid large refactors**: Iterative changes, gradual pattern introduction
- **Production code doesn't bend for tests**: Don't add a method, getter, export, or `_underscore` field purely to make a test work. If the public surface can't reach the behavior, the architecture needs the change, not test scaffolding.
- **Test changes**: Test logic (not mocks), failure cases, edge cases - always update tests. Write blackbox tests instead of testing internal exports directly

### Architecture Decisions

When a change introduces a class hierarchy, a new module boundary, a shared helper layer, or duplication across two or more types, score it against six dimensions before committing. Bar: 8/10 on at least five.

1. **Drift prevention** — behaviour duplicated across types lives in one place; a new precondition or branch touches one site, not N.
2. **Module coupling** — cross-module reach goes through a public API the team has committed to, never by reaching into another class's internals. Adding to the surface of an npm-exported class (`Span`, `Tracer`, OTel-bridge spans) is a forever commitment, so design the boundary so cross-module access doesn't need internal reach (callback in, diagnostic channel, restructured module boundary). If none of those fit, the architecture isn't done.
3. **Explicit contracts** — invariants enforced by constructor signatures, typed params, abstract methods, `#private` fields; not by convention.
4. **Testability at boundaries** — each boundary with multiple consumers or a spec/protocol contract has tests that pin its contract directly.
5. **Extensibility** — adding a third type or method requires the smallest possible change.
6. **Hot-path fitness** — per-call overhead at the architecture's edges, not its interior. The hot call path looks the same it would without the architecture.

Composition is the default; inheritance only when ≤2 sibling types share a complete interface contract. Score the *baseline* alongside the proposal (`baseline → proposal` per dimension) so a 7 → 7 refactor doesn't dress up as progress. Score *test exports* the same way as class hierarchies — exposing internal state so a spec can reach in almost always fails dimension 2.

### Implementation and Testing Workflow

**When making any code or type change, the following MUST be followed:**

1. **Understand** - Read relevant code and tests to understand the current implementation
2. **Optimize** - Identify the cleanest architectural approach to solve the request
3. **Ask (when there are meaningful trade-offs)** - Make a proposal with the two best solutions and explain trade-offs
4. **Implement** - Make the necessary code changes
5. **Update Tests** - Modify or add tests to cover the changes
6. **Run Tests** - Execute the relevant test files to verify everything works
7. **Verify** - Confirm all tests pass before marking the task as complete

### Always Consider Backportability

**We always backport `master` to older versions.**

- Keep breaking changes to a minimum
- Don't use language/runtime features that are too new
- **Guard breaking changes with version checks** using [`version.js`](./version.js) (e.g., `DD_MAJOR`)

### Public TypeScript Types

The repo carries two public TypeScript surfaces:

- `index.d.ts` — current major (master = v6).
- `index.d.v5.ts` — frozen v5 surface. Swapped over `index.d.ts` by `scripts/release/swap-v5-types.js` during a v5 release.

When adding a new public type, add it to both files unless the API is v6-only. v6-only changes — drops, renames, or APIs that don't exist in v5 — go in `index.d.ts` alone. The two files diverge by exactly the v6 cleanups; everything else mirrors.

## Adding New Configuration Options

1. **Add default value** in `packages/dd-trace/src/config/defaults.js`
2. **Map environment variable** in `packages/dd-trace/src/config/index.js` (`#applyEnvironment()` method)
3. **Add TypeScript definitions** in `index.d.ts`
4. **Add to telemetry name mapping** (if applicable) in `packages/dd-trace/src/telemetry/telemetry.js`
5. **Update** `packages/dd-trace/src/config/supported-configurations.json`
6. **Document** in `docs/API.md` (non-internal/experimental options only)
7. **Add tests** in `packages/dd-trace/test/config/index.spec.js`

**Naming Convention:** Size/time-based config options should have unit suffixes (e.g., `timeoutMs`, `maxBytes`, `intervalSeconds`).

## Upstream changes

In case an issue is actually happening outside of dd-trace, suggest to fix it upstream instead of creating a work-around.

## Adding New Instrumentation

**New instrumentations go in `packages/datadog-instrumentations/`.** The instrumentation system uses diagnostic channels for communication.

Many integrations have corresponding plugins in `packages/datadog-plugin-*/` that work with the instrumentation layer.
For registration patterns, see `packages/dd-trace/src/plugins/index.js`.
For instrumentation hook helpers, see `packages/datadog-instrumentations/src/helpers/instrument.js`.

### Creating a New Plugin

```bash
mkdir -p packages/datadog-plugin-<name>/{src,test}
cp packages/datadog-plugin-kafkajs/src/index.js packages/datadog-plugin-<name>/src/
```

Edit `src/index.js`, create `test/index.spec.js`, then register in:
`packages/dd-trace/src/plugins/index.js`, `index.d.ts`, `docs/test.ts`, `docs/API.md`, `.github/workflows/apm-integrations.yml`

Validate basic plugin structure with:

```bash
./node_modules/.bin/mocha packages/dd-trace/test/plugins/plugin-structure.spec.js
```

## Pull Requests and CI

### Commit Messages

Conventional format: `type(scope): description`
Types: `feat`, `fix`, `perf`, `refactor`, `test`, `bench`, `docs`, `chore`, `ci`
Reserve `feat`/`fix`/`perf` for production code shipped in the npm package. A fix or new capability in
tests, benchmarks, CI, or tooling uses the area type even so — a test-suite fix is `test(...)`, a benchmark
fix `bench(...)`, a CI fix `ci(...)`; never `fix(...)`/`feat(...)`.
Example: `feat(appsec): add new WAF rule`

### PR Requirements

- Use template from `.github/pull_request_template.md`
- Label: `semver-patch` (fixes only), `semver-minor` (new features), `semver-major` (breaking)
- **All tests must pass - all-green policy, no exceptions**

### Flaky tests

A non-deterministic failure (timeout, test-ordering, port race, a stub asserted once but called twice) that surfaces
while you work on an unrelated change is fixed in its **own** PR, not folded into the current one. Stabilize the test
or skip it with a tracked reason — never weaken or delete an assertion to make it pass. A deterministic failure
(assertion mismatch, missing fixture/cassette, stale path, version incompatibility) is **not** flaky; fix it inline.

Every fix — flake or deterministic — resolves the **cause**, not the symptom. A loosened assertion, a filtered-out
input, or a bumped timeout that hides the root problem is rejected. Concretely: if a spy fires twice because a stray
request reaches the server, stop the stray request — do not filter the spy. If the cause is upstream of this repo,
name it and escalate rather than patching around it.

Every fix — flake or deterministic — resolves the **cause**, not the symptom. A loosened assertion, a filtered-out
input, or a bumped timeout that hides the root problem is rejected. Concretely: if a spy fires twice because a stray
request reaches the server, stop the stray request — do not filter the spy. If the cause is upstream of this repo,
name it and escalate rather than patching around it.

## Vendoring Dependencies

Using rspack: Run `yarn` in `vendor/` to install/bundle dependencies → `packages/node_modules/`
(Some deps excluded, e.g., `@opentelemetry/api`)
