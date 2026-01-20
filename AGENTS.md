# AGENTS.md

## Prerequisites

- Node.js >= 18
- yarn 1.x
- Docker + docker-compose (for running service dependencies in tests)

## Setup

- Install dependencies: `yarn install`

**This project uses yarn, not npm. Always use `yarn` commands instead of `npm` commands.**

## Project Overview

dd-trace is the Datadog client library for Node.js.

**Key Directories:**

- `packages/dd-trace/` - Main library (APM, profiling, debugger, appsec, llmobs, CI visibility, etc)
- `packages/datadog-core/` - Async context storage, shared utilities
- `packages/datadog-instrumentations/` - Instrumentation implementations
- `packages/datadog-plugin-*/` - 100+ plugins for third-party integrations
- `integration-tests/` - E2E integration tests
- `benchmark/` - Performance benchmarks

**Package Structure:**

Each package under `packages/` follows a consistent structure:

- `src/` - Source code for the package
- `test/` - Unit tests for the package
- Unit test files always follow the `*.spec.js` naming convention
- Test directories may also contain helper files

## Testing Instructions

### Running Individual Tests

**IMPORTANT**: Never run the root `npm test`. Run specific related test files directly or run targeted related `npm run test:<area>` scripts.

**Unit tests:**

```bash
./node_modules/.bin/mocha path/to/test.spec.js
```

**Integration tests:**

```bash
./node_modules/.bin/mocha --timeout 60000 path/to/test.spec.js
```

**If a test expects “spec file is entrypoint” semantics (tap-like):**

```bash
node scripts/mocha-run-file.js path/to/test.spec.js
```

You can inject mocha options via `MOCHA_RUN_FILE_CONFIG` (JSON), including `require` hooks.

**Target specific tests:**

- Add `--grep "test name pattern"` flag

**Enable debug logging:**

- Prefix with `DD_TRACE_DEBUG=true`

### Plugin Tests

**Use `PLUGINS` env var:**

```bash
PLUGINS="amqplib" npm run test:plugins
PLUGINS="amqplib|bluebird" npm run test:plugins  # pipe-delimited for multiple
./node_modules/.bin/mocha packages/datadog-plugin-amqplib/test/index.spec.js
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

Use `node:assert/strict` for standard assertions. For partial deep object checks, use `assertObjectContains` from `integration-tests/helpers/index.js`:

```js
const assert = require('node:assert/strict')

const { assertObjectContains } = require('../helpers')

assert.equal(actual, expected)
assertObjectContains(response, { status: 200, body: { user: { name: 'Alice' } } })
```

Favor fewer `assert.deepStrictEqual`/`assertObjectContains` calls over many `assert.strictEqual` calls. Combine with existing `assert.strictEqual` calls, if possible.

Never use the `doesNotThrow()` assertion. Instead, execute the method directly.

### Time-Based Testing

**Never rely on actual time passing in unit tests.** Use sinon's fake timers to mock time and make tests deterministic and fast.

## Code Style & Linting

### Linting & Naming

- Lint: `npm run lint` / `npm run lint:fix`
- Files: kebab-case

### JSDoc

- Use TypeScript-compatible syntax (`@param {string}`, `@returns {Promise<void>}`, `@typedef`)
- Never use `any` (be specific or use `unknown` if type is truly unknown)
- Write the most specific types possible by reading the overall context
- Always define types for method arguments as method params
- Never define argument types inside of a method
- Only define types inside of a method, if it can not be inferred otherwise
- Only rewrite code for better types in case it was explicitly requested by the user

### Import Ordering

Separate groups with empty line, sort alphabetically within each:

1. Node.js core modules (with `node:` prefix)
2. Third-party modules
3. Internal imports (by path proximity, then alpha)

Use destructuring for utility modules when appropriate.

```js
const fs = require('node:fs')
const path = require('node:path')

const express = require('express')

const { myConf } = require('./config')
const log = require('../log')
```

### ECMAScript and Node.js API Standards

**Target Node.js 18.0.0 compatibility:**

- Use modern JS features supported by Node.js (e.g., optional chaining `?.`, nullish coalescing `??`)
- Use `undefined` over `null`, if not required otherwise
- Guard newer APIs with version checks using [`version.js`](./version.js):

  ```js
  const { NODE_MAJOR } = require('./version')
  if (NODE_MAJOR >= 20) { /* Use Node.js 20+ API */ }
  ```

### Event handlers

- Avoid adding new listeners, if possible
- Use monitor symbols like `events.errorMonitor` when available
- Use `.once()` methods instead of `.on()`, if the event is only needed once
- If new `beforeExit` events on `process` are needed, add them to `globalThis[Symbol.for('dd-trace')].beforeExitHandlers`

### Performance and Memory

**CRITICAL: Tracer runs in application hot paths - every operation counts.**

- Use fast paths to skip unnecessary steps
- Use most performant APIs
- Understand the use case to write ideal CPU and memory performant code

**Async/Await:**

- Do NOT use `async/await` or promises in production code (npm package)
- Allowed ONLY in: test files, worker threads (e.g., `packages/dd-trace/src/debugger/devtools_client/`)
- Use callbacks or synchronous patterns instead

**Memory:**

- Minimize allocations in frequently-called paths
- Avoid unnecessary objects, closures, arrays
- Reuse objects and buffers
- Minimize GC pressure

#### Array Iteration

**Prefer `for-of`, `for`, `while` loops over functional methods (`map()`, `forEach()`, `filter()`):**

- Avoid `items.forEach(item => process(item))` → use `for (const item of items) { process(item) }`
- Avoid chaining `items.filter(...).map(...)` → use single loop with conditional push
- Functional methods create closures and intermediate arrays

**Functional methods acceptable in:**

- Test files
- Non-hot-path code where readability benefits
- One-time initialization code

**Loop selection:**

- `for-of` - Simple iteration
- `for` with index - Need index or better performance in hot paths
- `while` - Custom iteration logic

### Debugging and Logging

Use `log` module (`packages/dd-trace/src/log/index.js`) with printf-style formatting (not template strings):

```js
const log = require('../log')
log.debug('Value: %s', someValue)  // printf-style
log.debug(() => `Expensive: ${expensive()}`)  // callback for expensive ops
log.error('Error: %s', msg, err)  // error as last arg
```

Enable: `DD_TRACE_DEBUG=true DD_TRACE_LOG_LEVEL=info node app.js`
Levels: `trace`, `debug`, `info`, `warn`, `error`

### Error Handling

**Never crash user apps:** Catch/log errors (`log.error()`/`log.warn()`), resume or disable plugin/subsystem
Avoid try/catch in hot paths - validate inputs early

## Development Workflow

### Core Principles

- **Search first**: Check for existing utilities/patterns before creating new code
- **Small PRs**: Break large efforts into incremental, reviewable changes
- **Descriptive code**: Self-documenting with verbs in function names; comment when needed
- **Readable formatting**: Empty lines for grouping, split complex objects, extract variables
- **Avoid large refactors**: Iterative changes, gradual pattern introduction
- **Test changes**: Test logic (not mocks), failure cases, edge cases - always update tests. Write blackbox tests instead of testing internal exports directly

### Implementation and Testing Workflow

**When making any code or type change, the following MUST be followed:**

1. **Understand** - Read relevant code and tests to understand the current implementation
2. **Optimize** - Identify the cleanest architectural approach to solve the request
3. **Ask** - Make a proposal with the two best solutions to the user and let them choose. Explain trade-offs
4. **Implement** - Make the necessary code changes
5. **Update Tests** - Modify or add tests to cover the changes
6. **Run Tests** - Execute the relevant test files to verify everything works
7. **Verify** - Confirm all tests pass before marking the task as complete

### Always Consider Backportability

**We always backport `master` to older versions.**

- Keep breaking changes to a minimum
- Don't use language/runtime features that are too new
- **Guard breaking changes with version checks** using [`version.js`](./version.js):

  ```js
  const { DD_MAJOR } = require('./version')
  if (DD_MAJOR >= 6) {
    // New behavior for v6+
  } else {
    // Old behavior for v5 and earlier
  }
  ```

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

### What Are Plugins?

Plugins are modular code components in `packages/datadog-plugin-*/` directories that:

- Subscribe to diagnostic channels to receive instrumentation events
- Handle APM tracing logic (spans, metadata, error tracking)
- Manage feature-specific logic (e.g., code origin tracking, LLM observability)

**Plugin Base Classes:**

- **`Plugin`** - Base class with diagnostic channel subscription, storage binding, enable/disable lifecycle. Use for non-tracing functionality.
- **`TracingPlugin`** - Extends `Plugin` with APM tracing helpers (`startSpan()`, automatic trace events, `activeSpan` getter). Use for plugins creating trace spans.
- **`CompositePlugin`** - Extends `Plugin` to compose multiple sub-plugins. Use when one integration needs multiple feature plugins (e.g., `express` combines tracing and code origin plugins).

**Plugin Loading:**

- Plugins load lazily when application `require()`s the corresponding library
- Disable with `DD_TRACE_DISABLED_PLUGINS` or `DD_TRACE_<PLUGIN>_ENABLED=false`
- Test framework plugins only load when Test Optimization mode (`isCiVisibility`) is enabled

**When to Create a New Plugin:**

1. Adding support for a new third-party library/framework
2. Adding a new product feature that integrates with existing libraries (use `CompositePlugin`)

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
