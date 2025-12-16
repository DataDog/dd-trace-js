# AGENTS.md

## Prerequisites

- Node.js >= 18
- yarn 1.x
- Docker + docker-compose (for running service dependencies in tests)

## Setup

- Install npm dependencies: `yarn`

**Note:** This project uses yarn, not npm. Always use `yarn` commands instead of `npm` commands.

## Project Overview

dd-trace is the Datadog client library for Node.js.

**Directory structure:**
- `packages/dd-trace/` - Main library (APM tracing, profiling, debugger, appsec, llmobs, CI visibility)
- `packages/datadog-core/` - Async context storage and shared utilities
- `packages/datadog-instrumentations/` - Instrumentation implementations
- `packages/datadog-plugin-*/` - 100+ plugin directories for third-party integrations

## Testing Instructions

### Testing Workflow

When developing a feature or fixing a bug:

1. Start with individual test files to verify things work
2. Run component tests: `yarn test:<component>` (e.g., `yarn test:debugger`, `yarn test:appsec`)
3. Run integration tests: `yarn test:integration:<component>` (e.g., `yarn test:integration:debugger`)

### Running Individual Tests

**IMPORTANT**: Never run `yarn test` directly. Use `mocha` or `tap` directly on test files.

**Mocha unit tests:**
```bash
./node_modules/.bin/mocha -r "packages/dd-trace/test/setup/mocha.js" path/to/test.spec.js
```

**Tap unit tests:**
```bash
./node_modules/.bin/tap path/to/test.spec.js
```

**Integration tests:**
```bash
./node_modules/.bin/mocha --timeout 60000 -r "packages/dd-trace/test/setup/core.js" path/to/test.spec.js
```

**Target specific tests:**
- Add `--grep "test name pattern"` flag

**Enable debug logging:**
- Prefix with `DD_TRACE_DEBUG=true`

**Note**: New tests should be written using mocha, not tap. Existing tap tests use mocha-style `describe` and `it` blocks.

### Plugin Tests

**Test specific plugins using `PLUGINS` environment variable:**
```bash
export PLUGINS="amqplib"
yarn test:plugins

# Multiple plugins (pipe-delimited)
PLUGINS="amqplib|bluebird" yarn test:plugins

# Single plugin test file
./node_modules/.bin/mocha -r "packages/dd-trace/test/setup/mocha.js" packages/datadog-plugin-amqplib/test/index.spec.js
```

**Plugins requiring external services:**
Check `.github/workflows/apm-integrations.yml` for `SERVICES` requirements.

```bash
export SERVICES="rabbitmq"
export PLUGINS="amqplib"
docker compose up -d $SERVICES
yarn services
yarn test:plugins
```

**Platform Limitations:** Some native modules don't compile on ARM64 (Apple silicon): `aerospike`, `couchbase`, `grpc`, `oracledb`.

### Test Coverage

Run tests with nyc for coverage:
```bash
./node_modules/.bin/nyc --include "packages/dd-trace/src/debugger/**/*.js" \
  ./node_modules/.bin/mocha -r "packages/dd-trace/test/setup/mocha.js" \
  "packages/dd-trace/test/debugger/**/*.spec.js"
```

**Coverage Philosophy:**
- Integration tests (running in sandboxes) don't count towards nyc coverage metrics
- Don't add redundant unit tests solely to improve coverage numbers
- Focus on covering important production code paths with whichever test type makes sense

### Test Assertions

**Use Node.js core `assert` library:**
```js
const assert = require('node:assert/strict')
assert.equal(actual, expected)
assert.deepEqual(actualObject, expectedObject)
```

**For partial deep object assertions, use `assertObjectContains` from `integration-tests/helpers/index.js`:**
```js
const { assertObjectContains } = require('../helpers')
assertObjectContains(response, {
  status: 200,
  body: { user: { name: 'Alice' } }
})
```

Provides better error messages than individual `assert` calls. Works for both integration and unit tests.

## Code Style & Linting

### Linting
- Lint: `yarn lint`
- Lint + autofix: `yarn lint:fix`

### Documentation and Types

**Use TypeScript-compatible JSDoc for all APIs:**
- Enables type checking and IDE autocompletion without TypeScript
- Use TypeScript type syntax in JSDoc annotations: `@param {string}`, `@returns {Promise<void>}`, `@typedef`, etc.

### File Naming Conventions

**Use kebab-case for file names.**

### Import Ordering

1. Node.js core modules (sort: alpha)
2. Third-party modules (sort: alpha)
3. Internal imports (sort: 1; path proximity, 2; alpha)

**Note:** Each group separated by an empty line.

```js
const fs = require('node:fs')
const path = require('node:path')

const express = require('express')

const { myConf } = require('./config')
const log = require('../log')
```

Use object destructuring for utility modules when appropriate.

### ECMAScript and Node.js API Standards

**Target Node.js 18.0.0 compatibility:**
- Use modern JS features supported by Node.js (e.g., optional chaining `?.`, nullish coalescing `??`)
- Guard newer APIs with version checks using [`version.js`](./version.js):
  ```js
  const { NODE_MAJOR } = require('./version')
  if (NODE_MAJOR >= 20) { /* Use Node.js 20+ API */ }
  ```
- **Prefix Node.js core modules with `node:`** (e.g., `require('node:assert')`)

### Async/Await and Promises

**Avoid promises and async/await in production code to minimize overhead.**

- Do NOT use `async/await` or promises in code that's included in the published npm package
- This is critical for performance as the tracer runs in application hot paths
- Async/await IS allowed in:
  - Test files
  - Worker threads (e.g., debugger code in `packages/dd-trace/src/debugger/devtools_client/`)
- Use callbacks or synchronous patterns in production code instead

### Performance and Memory

**Production code must be optimized for performance and minimal memory allocations:**
- This tracer runs in application hot paths - every operation counts
- Minimize memory allocations in frequently-called code paths
- Avoid creating unnecessary objects, closures, or arrays
- Reuse objects and buffers where possible
- Be conscious of garbage collection pressure
- Benchmark performance-critical changes (see `benchmark/sirun/`)

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

**Use the `log` module (`packages/dd-trace/src/log/index.js`) for all logging in production code:**

```js
const log = require('../log')
log.debug('Debug message with value: %s', someValue)
```

**Important:**
- Use printf-style formatting (`%s`, `%d`, `%o`), never template strings (avoids string concatenation when logging is disabled)
- Use callback for expensive computations: `log.debug(() => \`Processed: ${expensive()}\`)`
- Pass error object as last argument: `log.error('Error: %s', msg, err)`

**Enable debug logging:**
```bash
DD_TRACE_DEBUG=true node your-app.js
DD_TRACE_LOG_LEVEL=info DD_TRACE_DEBUG=true node your-app.js
```

Log levels: `trace`, `debug`, `info`, `warn`, `error`

### Error Handling

**Tracer should never crash user applications:**
- Catch errors and log with `log.error()` or `log.warn()`
- Resume normal operation if possible, or disable the plugin/sub-system
- Avoid try/catch in hot paths (has overhead) - validate inputs early instead

## Development Workflow

### Search Before Creating
- Always search codebase before creating new code
- Check for existing utilities, helpers, or patterns
- Reuse existing code rather than reinventing solutions

### Keep Changes Small and Incremental
- Break large efforts into many PRs for better reviewability
- Land partial changes if they work in isolation
- Fewer places changed = less risk of merge conflicts

### Be Descriptive
- Write self-documenting code
- Leave comments where self-description fails
- Use verbs for function names to communicate intent

### Give Your Code Space
- Use empty lines to separate logical groupings
- Split long lines and complex objects/arrays
- Assign variables before using them in calls if it improves clarity

### Avoid Large Refactors
- Favor iterative approaches over wholesale rewrites
- Introduce new patterns gradually
- Don't change dozens of files to add one feature

### Test Everything
- Ensure unit tests test logic, not mocks
- Test failure handling, heavy load scenarios, and usability
- Add or update tests for code you change, even if not asked

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

1. **Add default value** in `packages/dd-trace/src/config_defaults.js`
2. **Map environment variable** in `packages/dd-trace/src/config.js` (`#applyEnvironment()` method)
3. **Add TypeScript definitions** in `index.d.ts`
4. **Add to telemetry name mapping** (if applicable) in `packages/dd-trace/src/telemetry/telemetry.js`
5. **Update** `packages/dd-trace/src/supported-configurations.json`
6. **Document** in `docs/API.md` (non-internal/experimental options only)
7. **Add tests** in `packages/dd-trace/test/config.spec.js`

**Naming Convention:** Size/time-based config options should have unit suffixes (e.g., `timeoutMs`, `maxBytes`, `intervalSeconds`).

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
mkdir -p packages/datadog-plugin-<plugin-name>/src
mkdir -p packages/datadog-plugin-<plugin-name>/test
cp packages/datadog-plugin-kafkajs/src/index.js packages/datadog-plugin-<plugin-name>/src/
```

Edit `index.js` and create tests in `test/index.spec.js`. Add entries to:
- `packages/dd-trace/src/plugins/index.js`
- `index.d.ts`
- `docs/test.ts`
- `docs/API.md`
- `.github/workflows/apm-integrations.yml`

## Project Structure

- `packages/dd-trace/` - Main library implementation
- `packages/datadog-core/` - Shared utilities
- `packages/datadog-instrumentations/` - Instrumentation implementations
- `packages/datadog-plugin-*/` - Plugin implementations for third-party library integrations
- `integration-tests/` - End-to-end integration tests
- `benchmark/` - Performance benchmarks
- `.github/workflows/` - CI configuration
- `vendor/` - Vendored dependencies

## Pull Requests and CI

### Commit Messages

Use semantic commit messages (conventional commit format):
- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks
- `ci:` - CI/CD changes

Use parentheses for component: `feat(appsec): add new WAF rule`

### PR Description

Check for templates in `.github/pull_request_template.md`.

### Semantic Versioning

Label all PRs:
- `semver-patch` - Bug fixes and security fixes only, no behavior changes
- `semver-minor` - New functionality, new config options, new instrumentation
- `semver-major` - Breaking changes to existing functionality

### CI Requirements

**All tests must pass before merging.** All-green policy - no exceptions.

## Vendoring Dependencies

Dependencies are vendored using rspack:
- `vendor/` directory contains `package.json` with dependencies to be vendored
- Run `yarn` in vendor directory to install and bundle
- Vendored packages output to `packages/node_modules/`
- Some dependencies excluded (e.g., `@opentelemetry/api`)
