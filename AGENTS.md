# AGENTS.md

## Non-negotiables (read before coding)

- **Dependencies / services (yarn only)**: `yarn install`, `yarn add <pkg>`, `yarn services`
- **Never use corepack** in this repo.
- **Never use `npm install` / `npm ci`** in this repo.
- **Everything else uses npm scripts**: `npm run <script>` (lint, tests, build, etc.)
- **Never run root `npm test`**: it is intentionally disabled. Run a specific `*.spec.js` file, or a targeted `npm run test:<area>`.
- **Production package code is hot-path code** (`packages/*/src/`):
  - Do not introduce `async/await` or Promises (exceptions: tests and worker threads).
  - Prefer fast paths and low allocations; use `for` / `for-of` / `while` loops; never use `for-in`.
- **Keep changes backportable**: avoid breaking changes; guard newer APIs via `version.js` when needed.

## Common workflows (copy/paste)

**Run a test file (unit / integration):**

```bash
./node_modules/.bin/mocha path/to/test.spec.js
./node_modules/.bin/mocha --timeout 60000 path/to/test.spec.js
```

**If a test expects “spec file is entrypoint” semantics:**

```bash
node scripts/mocha-run-file.js path/to/test.spec.js
```

**Run plugin tests (single plugin):**

```bash
PLUGINS="amqplib" npm run test:plugins
```

**Run plugin tests with external services:**

```bash
export SERVICES="rabbitmq" PLUGINS="amqplib"
docker compose up -d $SERVICES
yarn services
npm run test:plugins
```

**Lint:**

```bash
npm run lint
```

## Prerequisites

- Node.js >= 18
- yarn 1.x
- Docker + docker-compose (for running service dependencies in tests)
- Optimize for performance and security: tracer runs in application hot paths.

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

**IMPORTANT**: The root `npm test` is intentionally disabled (see **Non-negotiables** above). Always run a specific `*.spec.js` file, or a targeted
`npm run test:<area>` script.

**Integration Tests**: Tests in `integration-tests/` require `required_permissions: ["all"]` when run in Cursor's AI environment.

### Running Individual Tests

Commands are in **Common workflows (copy/paste)** above:

You can inject mocha options via `MOCHA_RUN_FILE_CONFIG` (JSON), including `require` hooks.

**Common options:**

- `--grep "pattern"` to target tests
- `DD_TRACE_DEBUG=true` to enable debug logging

### Plugin Tests

**Use `PLUGINS` env var:**

```bash
# pipe-delimited for multiple: PLUGINS="amqplib|bluebird"
PLUGINS="amqplib|bluebird" npm run test:plugins
```

To run a single test file directly:

```bash
./node_modules/.bin/mocha packages/datadog-plugin-<name>/test/index.spec.js
```

**Narrow within plugin tests (optional):**

- Use `SPEC` to filter which `*.spec.js` files run within the selected plugins.

**With external services** (check `.github/workflows/apm-integrations.yml` for `SERVICES`):

Only needed for plugins that require external services; otherwise skip the docker/yarn-services steps.

```bash
export SERVICES="rabbitmq" PLUGINS="amqplib"
docker compose up -d $SERVICES
yarn services && npm run test:plugins
```

**ARM64 incompatible:** `aerospike`, `couchbase`, `grpc`, `oracledb`

### Test Coverage (rare)

Use nyc when needed (example):

- `./node_modules/.bin/nyc --include "packages/dd-trace/src/debugger/**/*.js" ./node_modules/.bin/mocha "packages/dd-trace/test/debugger/**/*.spec.js"`

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
- Files must end with a single new line at the end
- Use destructuring for better code readability
- Line length is capped at 120 characters
- Avoid abbreviations. Use short expressive variable, method, and function names

### Linting & Naming

- Lint: `npm run lint` / `npm run lint:fix`
- Files: kebab-case

### JSDoc

- Use TypeScript-compatible syntax (`@param {string}`, `@returns {Promise<void>}`, `@typedef`)
- Never use `any` (be specific; use `unknown` only if the type is truly unknown)
- Prefer the most specific type you can infer/identify from context; reuse existing types/typedefs instead of defaulting to `unknown`
- Write the most specific types possible by reading the overall context
- All new methods/functions must receive a full JSDoc comment
- Always define argument JSDoc types via `@param` on new methods/functions
- Avoid adding inline JSDoc type comments inside method/function bodies (e.g. `/** @type {...} */ x`).
  - Prefer `@typedef` at file scope + small helper/type-guard functions, then type parameters/returns at the method/function boundary.
- Prefer type casting over adding runtime type-guard code when the checks are only needed for static typing (e.g., comparisons). Never add extra runtime work just to satisfy types.
- Only add types inside of a method/function if they cannot be inferred otherwise
- Only rewrite code for better types in case it was explicitly requested by the user
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
- `map()` may be used for a single, linear transformation; avoid chaining (`filter().map()...`) in hot paths
- **Never** use `for-in` (use `for-of`)
- Do NOT introduce `async/await` or Promises in production package code (`packages/*/src/`)
  - Allowed ONLY in: test files and worker threads (e.g., `packages/dd-trace/src/debugger/devtools_client/`)
  - Use callbacks or synchronous patterns instead
- Use one time data transformations (e.g., at file load time) over call site transformations later
- Add microbenchmarks (sirun) when adding a new plugin or instrumentation that run an example app with the instrumentation disabled, enabled and plugin disabled, and both enabled.
- Add microbenchmarks to hot code paths as well for performance optimizations

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
- **Descriptive code**: Self-documenting with variable names (preferred) or as verbs in function names (for more than 2 lines of code); comment when needed
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

If an issue is actually happening outside of dd-trace, prefer fixing it upstream (issue/PR + minimal repro) instead of adding a workaround here.

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

## Contributor / CI process (human)

For PR process, labels, and contributor guidance, see `CONTRIBUTING.md` and `.github/pull_request_template.md`.
