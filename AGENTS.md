# AGENTS.md

## Agent Quick Start

### Key Rules
- **Never run `yarn test` or `npm test` directly** - use individual test files with mocha/tap
- **Use Node.js 18.0.0 APIs only** - guard newer APIs with version checks using [`version.js`](./version.js)
- **No async/await in production code** - keep it in tests and worker threads only
- **Prefer `for-of` loops over `map`/`forEach`** - avoid functional array methods in production code to minimize closure overhead
- **Follow testing workflow**: individual test file → unit tests → integration tests
- **Don't reduce coverage** - cover important paths, avoid redundant unit tests when integration tests exist
- **Make changes backport-friendly** - guard breaking changes with `DD_MAJOR` version checks
- **Prefix Node.js core modules with `node:`** - e.g., `require('node:assert')`
- **Write new tests using mocha** - not tap
- **Use `node:assert` for test assertions**
- **Use kebab-case for file names**
- **Document APIs with JSDoc** - ensure proper types without TypeScript

### Common Commands

```bash
# Lint code
yarn lint

# Run single unit test
./node_modules/.bin/mocha -r "packages/dd-trace/test/setup/mocha.js" path/to/test.spec.js

# Run single integration test
./node_modules/.bin/mocha --timeout 60000 -r "packages/dd-trace/test/setup/core.js" integration-tests/path/to/test.spec.js
```

### Task → Directory Mappings
- **Core library features** (APM, profiling, security) → `packages/dd-trace/`
- **Third-party instrumentation** → `packages/datadog-instrumentations/`
- **Plugin code** → `packages/datadog-plugin-*/`
- **Integration tests** → `integration-tests/`

---

## Project Overview

This is `dd-trace`, the Datadog client library for Node.js. It's a single npm package with an internal directory structure organized into package-like directories:

- `packages/dd-trace` - Main library containing APM tracing, profiling, dynamic instrumentation, application security, LLM observability, CI visibility, and more
- `packages/datadog-core` - Core utilities
- `packages/datadog-instrumentations` - Instrumentation implementations
- `packages/datadog-plugin-*` - 100+ plugin directories for third-party library integrations (Express, GraphQL, PostgreSQL, Redis, etc.)

The latest major release of the library supports Node.js >= 18 and follows semantic versioning with multiple release lines.

### Key Features

The library provides multiple observability and security features:

- **APM Tracing** (`packages/dd-trace/src/`) - Distributed tracing for application performance monitoring
- **Profiling** (`packages/dd-trace/src/profiling/`) - CPU and heap profiling
- **Dynamic Instrumentation** (`packages/dd-trace/src/debugger/`) - Live debugging without code changes
- **Application Security** (`packages/dd-trace/src/appsec/`) - Runtime application self-protection (RASP) and threat detection
- **LLM Observability** (`packages/dd-trace/src/llmobs/`) - Monitoring for AI/LLM applications
- **CI Visibility** (`packages/dd-trace/src/ci-visibility/`) - Test execution and CI pipeline monitoring
- **Runtime Metrics** (`packages/dd-trace/src/runtime_metrics/`) - Memory, GC, and event loop metrics
- **Data Streams Monitoring** (`packages/dd-trace/src/datastreams/`) - End-to-end latency tracking for streaming data

## Testing Instructions

### Testing Workflow

When developing a feature or fixing a bug, follow this workflow:

**For `dd-trace` package tests:**
1. Start by targeting individual test files to verify things work (see "Running Individual Tests" below)
2. Once those pass, run all unit tests for the specific component: `yarn test:<component>` (e.g., `yarn test:debugger`, `yarn test:appsec`, `yarn test:llmobs`)
3. Once those pass, run all integration tests for that component: `yarn test:integration:<component>` (e.g., `yarn test:integration:debugger`)

**For plugin tests:**
Follow a similar workflow using individual test files, then component-specific test suites (see "Plugin Tests" section below).

### Running Individual Tests

**IMPORTANT**: Never run `yarn test` or `npm test` directly as it requires too much setup and takes too long. Instead:

- Use `mocha` directly on test files with the appropriate setup file:
  - For unit tests: `./node_modules/.bin/mocha -r "packages/dd-trace/test/setup/mocha.js" path/to/test.spec.js`
  - For integration tests: `./node_modules/.bin/mocha --timeout 60000 -r "packages/dd-trace/test/setup/core.js" path/to/test.spec.js`
- Use `tap` directly for tap-based tests: `./node_modules/.bin/tap path/to/test.spec.js`
- To target specific tests:
  - For mocha: Use `--grep` flag: `./node_modules/.bin/mocha -r "..." path/to/test.spec.js --grep "test name pattern"`
  - For tap: Use `--grep` flag: `./node_modules/.bin/tap path/to/test.spec.js --grep "test name pattern"`

**Note**: This project uses a mix of tap and mocha for testing.
However, new tests should be written using mocha, not tap.
Tap tests in this project are written in mocha style with `describe` and `it` blocks.

Example:

```bash
# Run a single unit test file
./node_modules/.bin/mocha -r "packages/dd-trace/test/setup/mocha.js" packages/dd-trace/test/debugger/devtools_client/snapshot-pruner.spec.js

# Run a single integration test file
./node_modules/.bin/mocha --timeout 60000 -r "packages/dd-trace/test/setup/core.js" integration-tests/debugger/template.spec.js

# Run specific test within a file
./node_modules/.bin/mocha -r "packages/dd-trace/test/setup/mocha.js" packages/dd-trace/test/appsec/sdk/track_event.spec.js --grep "should track login success"

# Enable debug logging for debugging failing tests
DD_TRACE_DEBUG=true ./node_modules/.bin/mocha -r "packages/dd-trace/test/setup/mocha.js" packages/dd-trace/test/appsec/sdk/track_event.spec.js
```

### Plugin Tests

Plugin tests require external services running in Docker:

```bash
# Example for testing the amqplib plugin
export SERVICES="rabbitmq"
export PLUGINS="amqplib"

# Start required services
docker compose up -d $SERVICES

# Install plugin versions and check services
yarn services

# Run plugin tests
yarn test:plugins
```

To run a single plugin test file:

```bash
# Run a specific plugin test file
./node_modules/.bin/mocha -r "packages/dd-trace/test/setup/mocha.js" packages/datadog-plugin-amqplib/test/index.spec.js
```

Check `.github/workflows/apm-integrations.yml` for the correct `SERVICES` and `PLUGINS` values for each plugin.

You can test multiple plugins at once using pipe delimiters:

```bash
PLUGINS="amqplib|bluebird" yarn test:plugins
```

**Platform Limitations:** Some native modules don't compile on ARM64 devices (Apple silicon): `aerospike`, `couchbase`, `grpc`, `oracledb`. These plugin tests cannot be run locally on ARM64 devices.

### Test Coverage

Coverage is measured with nyc. To check coverage for your changes:

1. Run tests with nyc for the component you're working on:
   ```bash
   ./node_modules/.bin/nyc --include "packages/dd-trace/src/debugger/**/*.js" \
     ./node_modules/.bin/mocha -r "packages/dd-trace/test/setup/mocha.js" \
     "packages/dd-trace/test/debugger/**/*.spec.js"
   ```

2. The output will show a table like this:
   ```
   ----------|---------|----------|---------|---------|-------------------
   File      | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
   ----------|---------|----------|---------|---------|-------------------
   All files |   82.56 |    75.45 |   89.06 |   83.86 |                   
   config.js |     100 |      100 |     100 |     100 |                   
   ----------|---------|----------|---------|---------|-------------------
   ```
   - `% Stmts`: % of code statements executed
   - `% Branch`: % of code branches (if/else) taken
   - `% Funcs`: % of functions called
   - `% Lines`: % of lines executed
   - `Uncovered Line #s`: Specific line numbers not covered by tests

3. Check the percentage values to ensure important code paths are covered.

#### Coverage Philosophy

- Don't reduce coverage with new PRs
- Cover important production code paths unless tests become overly complex
- Integration tests in sandboxes don't count toward metrics, so don't add redundant unit tests just for coverage numbers

### Test Assertions

**Use the Node.js core `assert` library for assertions in tests.**

Import from `node:assert/strict` to ensure all assertions use strict equality (`===`) without type coercion. This allows you to use simpler method names like `assert.equal()` and `assert.deepEqual()` while getting strict comparison behavior automatically.

Example:
```js
const assert = require('node:assert/strict')

assert.equal(actual, expected)
assert.deepEqual(actualObject, expectedObject)
```

#### Partial Deep Object Assertions

**For asserting that an object contains certain properties (deeply), use `assertObjectContains` from `integration-tests/helpers/index.js`.**

This helper performs partial deep equality checking - it verifies that the actual object contains all the properties specified in the expected object, but the actual object may have additional properties. This is particularly useful when you only care about certain fields in a large object.

The helper uses Node.js's native `assert.partialDeepStrictEqual` when available (Node.js 22+), and provides a polyfill for older versions.

**Why use `assertObjectContains`?** It's preferred over individual `assert` calls for each property because it provides better error messages when tests fail, showing exactly which nested properties doesn't match in a clear, structured way.

Example:
```js
const { assertObjectContains } = require('../helpers')

// Assert an object contains specific properties (actual object can have more)
assertObjectContains(response, {
  status: 200,
  body: { user: { name: 'Alice' } }
})

// Works with arrays - checks that actual array contains expected items in order
assertObjectContains(testNames, ['test1', 'test2'])
```

**Important:** This helper is intended for both integration and unit tests.

## Code Style & Linting

### Linting

```bash
# Run linter (includes license checks and vulnerability scanning)
yarn lint

# Auto-fix issues
yarn lint:fix
```

### Documentation and Types

**Document all APIs with JSDoc to ensure proper types without using TypeScript.**

Since this is a JavaScript codebase, use JSDoc comments to provide type information for functions, parameters, and return values. This enables type checking and IDE autocompletion while maintaining the JavaScript codebase.

### File Naming Conventions

**Use kebab-case for file names.**

### Import Ordering

Organize imports in the following order (each group separated by an empty line):

1. Node.js core modules first (sorted alphabetically)
2. Third-party modules (sorted alphabetically)
3. Internal imports (sorted by path proximity first - closest first - then alphabetically)

Example:

```js
const fs = require('node:fs')
const path = require('node:path')

const express = require('express')
const lodash = require('lodash')

const { myConf } = require('./config')
const { foo } = require('./helper')
const log = require('../log')
const util = require('../../util')
```

Use object destructuring to only import the used functions where it makes sense, especially for utility modules like `fs` or `path`:

```js
const { readFile } = require('node:fs')
const { join } = require('node:path')
```

### ECMAScript and Node.js API Standards

**Always follow the ECMAScript standard and Node.js APIs supported by Node.js 18.0.0**

- Never use ECMAScript features or Node.js APIs only supported in newer Node.js versions unless explicitly required by the prompt
- If newer APIs are required, guard them with version checks using the [`version.js`](./version.js) module:
  ```js
  const { NODE_MAJOR } = require('./version')
  if (NODE_MAJOR >= 20) {
    // Use Node.js 20+ API
  }
  ```
- Use modern JS features that are supported (e.g., optional chaining `?.`, nullish coalescing `??`)
- Avoid older patterns when newer supported ones exist
- **When importing Node.js core modules, prefix them with `node:`** (e.g., `require('node:assert')`, `import from 'node:fs'`)

### Async/Await and Promises

**Avoid promises and async/await in production code to minimize overhead.**

- Do NOT use `async/await` or promises in code that's included in the published npm package
- This is critical for performance as the tracer runs in application hot paths
- Async/await IS allowed in:
  - Test files
  - Worker threads (e.g., debugger code in `packages/dd-trace/src/debugger/devtools_client/`)
- Use callbacks or synchronous patterns in production code instead

### Performance and Memory

**Production code must be optimized for performance and minimal memory allocations.**

- This tracer runs in application hot paths - every operation counts
- Minimize memory allocations in frequently-called code paths
- Avoid creating unnecessary objects, closures, or arrays
- Reuse objects and buffers where possible
- Be conscious of garbage collection pressure
- Benchmark performance-critical changes (see `benchmark/sirun/`)

#### Array Iteration

**Prefer `for-of`, `for`, and `while` loops over functional array methods like `map()`, `forEach()`, `filter()`, etc.**

Functional array methods create function closures on each invocation, which adds overhead and garbage collection pressure. Use imperative loops instead:

```js
// ❌ Avoid - creates closure and temporary array
items.forEach(item => {
  process(item)
})

// ✅ Prefer - no closure overhead
for (const item of items) {
  process(item)
}

// ❌ Avoid - creates closures and multiple intermediate arrays
const result = items
  .filter(item => item.active)
  .map(item => item.value)

// ✅ Prefer - single loop, no intermediate arrays
const result = []
for (const item of items) {
  if (item.active) {
    result.push(item.value)
  }
}
```

**When functional methods are acceptable:**
- Test files (performance is less critical)
- Non-hot-path code where readability significantly benefits
- One-time initialization code

**Loop selection guide:**
- `for-of` - Most readable for simple iteration over arrays/iterables
- `for` with index - When you need the index or better performance in very hot paths
- `while` - When you need custom iteration logic
- `Array.from()`, `[...spread]` - Acceptable for converting iterables, but be mindful of allocations

### Debugging and Logging

**Use the `log` module for all logging in production code.**

The log module is located at `packages/dd-trace/src/log/index.js`. Import it relative to your file location.

To add debug logs in your code:

```js
const log = require('../log')

log.debug('Debug message with value: %s', someValue)
log.debug('Multiple values: %s, %d', stringValue, numberValue)
log.info('Info message')
log.warn('Warning with data: %o', objectValue)
log.error('Error reading file %s', filepath, err)
```

**Important:** Never use template strings for log messages. Use printf-style formatting (`%s`, `%d`, `%o`, etc.) instead. This avoids unnecessary string concatenation when logging is disabled

For expensive computations in the log message itself, use a callback function:

```js
// Callback is only executed if debug logging is enabled
log.debug(() => `Processed data: ${expensive.computation()}`)
```

When logging errors, pass the error object as the last argument after the format string:

```js
log.error('Error processing request', err)
// or with additional context:
log.error('Error reading file %s', filename, err)
```

To enable debug logging when running tests or the application:

```bash
DD_TRACE_DEBUG=true node your-app.js
DD_TRACE_DEBUG=true ./node_modules/.bin/mocha test.spec.js
```

You can also control the log level with `DD_TRACE_LOG_LEVEL`:

```bash
DD_TRACE_LOG_LEVEL=info DD_TRACE_DEBUG=true node your-app.js
```

Available log levels: `trace`, `debug`, `info`, `warn`, `error`

### Error Handling

The tracer should never crash user applications. Instead catch errors and log with `log.error()` (or `log.warn()` if applicable). Resume normal operation if possible, or disable the plugin/sub-system if not.

**Performance note:** Avoid try/catch in hot paths unless necessary - it has overhead. Validate inputs early instead.

## Development Workflow

### Search Before Creating

- Always search the codebase first before creating new code to avoid duplicates
- Check for existing utilities, helpers, or patterns that solve similar problems
- Reuse existing code when possible rather than reinventing solutions

### Keep Changes Small and Incremental

- Break large efforts into many PRs over time for better reviewability
- Land partial changes if they're not wired up yet, as long as tests prove they work in isolation
- Fewer places changed = less risk of merge conflicts

### Be Descriptive

- Write self-documenting code
- Leave comments where self-description fails
- Use verbs for function names to communicate intent
- If a function can't be described with a simple verb, it's probably too complex

### Give Your Code Space

- Use empty lines to separate logical groupings
- Split long lines into multiple lines
- Split complex objects/arrays over several lines
- Assign variables before using them in calls if it improves clarity

### Avoid Large Refactors

- Favor iterative approaches over wholesale rewrites
- Introduce new patterns gradually
- Phase out old systems incrementally
- Don't change dozens of files to add one feature

### Test Everything

- Favor integration tests over unit tests
- Ensure unit tests test logic, not mocks
- Test failure handling, heavy load scenarios, and usability
- Add or update tests for code you change, even if not asked

### Always Consider Backportability

**We always backport `master` to older versions to avoid release lines drifting apart and to prevent merge conflicts.**

- Keep breaking changes to a minimum
- Don't use language/runtime features that are too new
- **Breaking changes must be guarded by version checks**: Check the major version of the dd-trace package (using [`version.js`](./version.js)) so changes can land in `master` and be safely backported to older versions
  ```js
  const { DD_MAJOR } = require('./version')
  if (DD_MAJOR >= 6) {
    // New behavior for v6+
  } else {
    // Old behavior for v5 and earlier
  }
  ```

## Adding New Configuration Options

To add a new configuration option:

1. **Add the default value** in `packages/dd-trace/src/config_defaults.js`:
   ```js
   module.exports = {
     // ...
     'myFeature.enabled': false,
     'myFeature.timeoutMs': 5000,
     // ...
   }
   ```

2. **Map the environment variable** in `packages/dd-trace/src/config.js`:
   - Add the environment variable to the destructuring in the `#applyEnvironment()` method
   - Map it to the config property using the appropriate parsing logic

3. **Add TypeScript definitions** in `index.d.ts`:
   ```typescript
   export interface TracerOptions {
     myFeature?: {
       enabled?: boolean
       timeoutMs?: number
     }
   }
   ```

4. **Add to telemetry name mapping** (if applicable) in `packages/dd-trace/src/telemetry/telemetry.js`

5. **Update supported configurations** in `packages/dd-trace/src/supported-configurations.json`

6. **Document the option** in `docs/API.md` (only for non-internal/experimental options)

7. **Add tests** for the new configuration option in `packages/dd-trace/test/config.spec.js`

**Naming Convention:** Size/time-based config options should have unit suffixes (e.g., `timeoutMs` for milliseconds, `maxBytes` for bytes, `intervalSeconds` for seconds).

## Adding New Instrumentation

**New instrumentations should be added to `packages/datadog-instrumentations/`.** The instrumentation system uses diagnostic channels for internal communication between the instrumentation layer and the tracer.

Many integrations also have corresponding plugins in `packages/datadog-plugin-*/` that work together with the instrumentation layer to provide the complete integration functionality.

### What Are Plugins?

Plugins are modular code components in the `packages/datadog-plugin-*/` directories.

Plugins serve as a general code structure tool and contain logic for integrating with specific third-party libraries and frameworks. They:

- Subscribe to diagnostic channels to receive instrumentation events
- Handle APM tracing logic (creating spans, extracting metadata, error tracking)
- Manage feature-specific logic (e.g., code origin tracking, custom instrumentation)
- Can extend base plugin classes (`Plugin`, `TracingPlugin`, `CompositePlugin`)

#### Plugin Base Classes

- **`Plugin`** - Base class providing diagnostic channel subscription (`addSub`), storage binding (`addBind`), and enable/disable lifecycle management. Use for non-tracing functionality or custom logic.
- **`TracingPlugin`** - Extends `Plugin` with APM tracing conveniences: `startSpan()` helper, automatic trace event subscriptions (`start`, `end`, `error`, `finish`), `activeSpan` getter, and service/operation naming helpers. Use for plugins that create trace spans.
- **`CompositePlugin`** - Extends `Plugin` to compose multiple sub-plugins. It instantiates child plugins defined in the static `plugins` getter and propagates configuration to them. Use when a single integration needs multiple feature plugins (e.g., `express` has both tracing and code origin plugins).

Plugins communicate with the instrumentation layer and with each other primarily through diagnostic channels, though they can also directly import from other plugins when needed (e.g., `express` extends `router`).

#### How Plugins Are Loaded

Plugins are loaded lazily - only when the application actually `require()`s the corresponding library:

1. When a third-party module is required, the instrumentation system hooks into it
2. After successful instrumentation, it publishes to the `dd-trace:instrumentation:load` channel with the module name
3. The PluginManager subscribes to this channel and loads the corresponding plugin
4. The plugin is initialized with the tracer instance and configuration

This means a plugin for `express` won't load unless the application actually uses Express. Plugins can be disabled via:
- `DD_TRACE_DISABLED_PLUGINS` - comma-separated list of plugin IDs to disable
- `DD_TRACE_<PLUGIN>_ENABLED=false` - disable a specific plugin (e.g., `DD_TRACE_EXPRESS_ENABLED=false`)

Some plugins (like test framework plugins: `jest`, `mocha`, `vitest`, `cucumber`, `playwright`) only load when Test Optimization mode (`isCiVisibility`) is enabled.

#### When to Create a New Plugin

Create a new plugin when:

1. **Adding support for a new third-party library or framework** - e.g., a new HTTP framework, database client, or messaging system
2. **Adding a new product feature that integrates with existing libraries** - e.g., code origin tracking, LLM observability, or other cross-cutting features

For case 2, you would typically create individual feature plugins and compose them with existing tracing plugins using `CompositePlugin`. For example:
- `express` uses `CompositePlugin` to combine `ExpressTracingPlugin` and `ExpressCodeOriginForSpansPlugin`
- `openai` uses `CompositePlugin` to combine `OpenAiTracingPlugin` and `OpenAiLLMObsPlugin`

### Creating a New Plugin

To create a new plugin:

1. Create directory structure:
   ```bash
   mkdir -p packages/datadog-plugin-<pluginname>/src
   mkdir -p packages/datadog-plugin-<pluginname>/test
   ```

2. Copy a starting point:
   ```bash
   cp packages/datadog-plugin-kafkajs/src/index.js packages/datadog-plugin-<pluginname>/src/
   ```

3. Edit `index.js` for your plugin

4. Create tests in `packages/datadog-plugin-<pluginname>/test/index.spec.js`

5. Add entries to these files:
   - `packages/dd-trace/src/plugins/index.js`
   - `index.d.ts`
   - `docs/test.ts`
   - `docs/API.md`
   - `.github/workflows/apm-integrations.yml`

See existing integrations for structure and patterns to follow.

## Project Structure

Key directories:

- `packages/dd-trace/` - Main library implementation
- `packages/datadog-core/` - Shared utilities
- `packages/datadog-instrumentations/` - Instrumentation implementations
- `packages/datadog-plugin-*/` - Plugin implementations for third-party library integrations
- `integration-tests/` - End-to-end integration tests
- `benchmark/` - Performance benchmarks
- `.github/workflows/` - CI configuration
- `vendor/` - Vendored dependencies

---

## Pull Requests and CI

### Commit Messages

Use semantic commit messages following the conventional commit format:

- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks
- `ci:` - CI/CD changes

Use parentheses to denote the component if applicable:

- `feat(appsec): add new WAF rule`
- `fix(debugger): resolve memory leak`
- `test(llmobs): add integration tests`

### PR Description

When authoring PR descriptions, check for templates in `.github/pull_request_template.md`.

### Semantic Versioning

Label all PRs with semver labels:

- `semver-patch` - Bug fixes and security fixes only, no behavior changes
- `semver-minor` - New functionality, new config options, new instrumentation. Existing APIs and data unchanged.
- `semver-major` - Breaking changes to existing functionality

### CI Requirements

**All tests must pass before merging.** We follow an all-green policy - no exceptions.

---

## Appendix

### Setup Commands

Install dependencies:

```bash
yarn
```

Requirements:
- Node.js >= 18 (use nvm or similar version manager)
- yarn 1.x (install with `npm install -g yarn`)
- Docker and docker-compose (for running service dependencies in tests)

### Benchmarks

**Note: Agents should NOT run benchmarks unless explicitly instructed to in the prompt.**

Observability products run in hot paths. Benchmarks are typically run in CI but can be executed locally:

```bash
yarn bench
```

Microbenchmarks live in `benchmark/sirun/`. Each directory tracks regressions and improvements over time.

### Vendoring Dependencies

Dependencies are vendored using rspack to maintain control and reduce external dependencies:

- The `vendor/` directory contains a separate `package.json` with dependencies to be vendored
- Run `yarn` in the vendor directory to install and bundle dependencies
- Vendored packages are output to `packages/node_modules/`
- Some dependencies are excluded from vendoring (e.g., `@opentelemetry/api` which is shared with user code)
