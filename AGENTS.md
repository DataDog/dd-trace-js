# AGENTS.md

## Prerequisites

- Node.js >= 18
- yarn 1.x
- Docker + docker-compose (for running service dependencies in tests)

## Setup

**Package manager policy:**

- Use **yarn only for installing dependencies and services**:
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

### Test Coverage

```bash
./node_modules/.bin/nyc --include "packages/dd-trace/src/debugger/**/*.js" \
  ./node_modules/.bin/mocha \
  "packages/dd-trace/test/debugger/**/*.spec.js"
```

**Philosophy:**

- Integration tests (running in sandboxes) don't count towards nyc coverage metrics
- Don't add redundant unit tests solely to improve coverage numbers
- Focus on covering important production code paths with whichever test type makes sense

### Test Assertions

Use `node:assert/strict` for standard assertions. For partial deep object checks, use `assertObjectContains` from `integration-tests/helpers/index.js`.

Favor fewer `assert.deepStrictEqual`/`assertObjectContains` calls over many `assert.strictEqual` calls. Combine existing calls, when touching test files.

Never use the `doesNotThrow()` assertion. Instead, execute the method directly.

### Time-Based Testing

**Never rely on actual time passing in unit tests.** Use sinon's fake timers to mock time and make tests deterministic and fast.

## Code Style & Linting

### Style

- Prefer optional chaining
- Prefer `#private` class fields for new/internal-only code (no cross-module access needed).
- If other modules need access, prefer a small explicit method API over accessing internal fields.
- Avoid large refactors of existing `_underscore` fields unless you can prove they are not accessed externally (excluding tests).
- Files shall end with a single new line at the end
- Use destructuring for better code readability
- Line length is capped at 120 characters

### Linting & Naming

- Lint: `npm run lint` / `npm run lint:fix`
- Files: kebab-case

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
- **Small PRs**: Break large efforts into incremental, reviewable changes
- **Descriptive code**: Self-documenting with verbs in function names; comment when needed
- **Readable formatting**: Empty lines for grouping, split complex objects, extract variables
- **Avoid large refactors**: Iterative changes, gradual pattern introduction
- **Test changes**: Test logic (not mocks), failure cases, edge cases - always update tests. Write blackbox tests instead of testing internal exports directly

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

## Pull Requests and CI

### Commit Messages

Conventional format: `type(scope): description`
Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`
Example: `feat(appsec): add new WAF rule`

### PR Requirements

- Use template from `.github/pull_request_template.md`
- Label: `semver-patch` (fixes only), `semver-minor` (new features), `semver-major` (breaking)
- **All tests must pass - all-green policy, no exceptions**

## Vendoring Dependencies

Using rspack: Run `yarn` in `vendor/` to install/bundle dependencies → `packages/node_modules/`
(Some deps excluded, e.g., `@opentelemetry/api`)
