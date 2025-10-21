# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is `dd-trace-js`, the Datadog APM (Application Performance Monitoring) tracer library for Node.js. It instruments Node.js applications to capture trace data and send it to the Datadog Agent. The library supports Node.js >= 18 and is currently on the v5 release line.

## Key Architecture

### Package Structure

This is a monorepo using yarn workspaces with the following main packages:

- **`packages/dd-trace`**: Core tracer implementation. Entry point for the library.
  - `src/tracer.js`: Main DatadogTracer class extending OpenTracing Tracer
  - `src/config.js`: Configuration management with 64k+ lines of options
  - `src/plugins/index.js`: Central registry of all instrumentation plugins
  - `src/exporters/`: Exporters for sending data to the Agent (agent, log, span-stats)
  - `src/appsec/`: Application Security monitoring features
  - `src/ci-visibility/`: CI/CD test visibility features
  - `src/llmobs/`: LLM observability features
  - `src/profiling/`: CPU and heap profiling support
  - `src/lambda/`: AWS Lambda-specific functionality
  - `src/opentracing/`: OpenTracing API implementation
  - `src/opentelemetry/`: OpenTelemetry API integration

- **`packages/datadog-instrumentations`**: Low-level instrumentation hooks using import-in-the-middle (IITM)

- **`packages/datadog-plugin-*`**: Individual plugin implementations for third-party libraries (80+ plugins including express, graphql, aws-sdk, openai, anthropic, etc.)

- **`packages/datadog-core`**: Shared core utilities used across packages

- **`packages/datadog-shimmer`**: Monkey-patching utilities for instrumenting libraries

- **`packages/datadog-esbuild`**: ESBuild plugin for bundling support

### Plugin Architecture

Each plugin follows a consistent pattern:
1. Located in `packages/datadog-plugin-{name}/src/index.js`
2. Registered in `packages/dd-trace/src/plugins/index.js`
3. Has tests in `packages/datadog-plugin-{name}/test/`
4. TypeScript definitions in root `index.d.ts`

### Global State Management

The tracer uses a global singleton pattern via `global._ddtrace` (see `packages/dd-trace/index.js`). This ensures a single tracer instance per process.

## Development Commands

### Setup
```bash
yarn                          # Install dependencies
```

### Testing

**Plugin Tests** (requires Docker services):
```bash
# 1. Check .github/workflows/apm-integrations.yml for SERVICES and PLUGINS values
# 2. Start required services
docker compose up -d $SERVICES

# 3. Install test versions and check services
export PLUGINS="amqplib"      # Example: pipe-delimited for multiple: "amqplib|bluebird"
export SERVICES="rabbitmq"
yarn services

# 4. Run plugin tests
yarn test:plugins
```

**Unit Tests**:
```bash
yarn test:trace:core         # Core tracer tests (dd-trace package)
yarn test:core               # datadog-core package tests
yarn test:instrumentations   # datadog-instrumentations tests
yarn test:appsec            # AppSec tests
yarn test:llmobs:sdk        # LLM Observability SDK tests
yarn test:debugger          # Debugger tests
yarn test:lambda            # Lambda tests
yarn test:profiler          # Profiling tests
yarn test:shimmer           # Shimmer tests
```

**Integration Tests**:
```bash
yarn test:integration                    # All integration tests
yarn test:integration:cypress           # Specific integration test suite
yarn test:integration:jest
# See package.json for full list
```

**CI Coverage Tests** (with nyc):
```bash
yarn test:trace:core:ci
yarn test:plugins:ci        # Requires PLUGINS env var
```

### Linting and Type Checking
```bash
yarn lint                    # Run ESLint (also checks LICENSE-3rdparty.csv)
yarn lint:fix               # Auto-fix ESLint issues
yarn type:check             # TypeScript type checking
yarn type:test              # Test TypeScript definitions
```

### Benchmarks
```bash
yarn bench                  # Run microbenchmarks
```

### Running a Single Test
For Mocha-based tests (most tests):
```bash
mocha -r "packages/dd-trace/test/setup/mocha.js" path/to/test.spec.js
```

For Tap-based tests (profiler, core):
```bash
tap path/to/test.spec.js
```

### Services Management
```bash
docker compose up -d {service}    # Start a specific service (postgres, redis, mongo, etc.)
docker compose down               # Stop all services
```

Available services in `docker-compose.yml`: postgres, mysql, mssql, redis, mongo, elasticsearch, rabbitmq, aerospike, couchbase, oracledb, and many Azure emulators.

## Common Development Workflows

### Adding a New Plugin

1. Create plugin directory structure:
   ```bash
   mkdir -p packages/datadog-plugin-{name}/src
   mkdir -p packages/datadog-plugin-{name}/test
   ```

2. Copy a similar plugin as a starting point:
   ```bash
   cp packages/datadog-plugin-kafkajs/src/index.js packages/datadog-plugin-{name}/src/
   ```

3. Add plugin registration to:
   - `packages/dd-trace/src/plugins/index.js`
   - `index.d.ts` (TypeScript definitions)
   - `docs/test.ts` (TypeScript tests)
   - `docs/API.md` (API documentation)
   - `.github/workflows/apm-integrations.yml` (CI configuration)

4. Write tests following existing plugin test patterns

### Running Tests Offline
Set `OFFLINE=true` to use yarn's `--prefer-offline` flag for integration tests that install packages.

## Important Development Guidelines

### Code Style
- **Keep changes incremental**: Break large features into small, reviewable PRs
- **Test everything**: Prefer integration tests over unit tests; avoid testing mocks
- **Always consider backportability**: Avoid breaking changes; use feature flags when necessary
- **Avoid large refactors**: Introduce new patterns gradually

### Semantic Versioning
- `semver-patch`: Bug fixes and security fixes
- `semver-minor`: New features without breaking changes
- `semver-major`: Breaking changes (also add `dont-land-on-vN.x` labels)

### Testing Requirements
- All tests must pass before merging (all-green policy)
- Write benchmarks for code in hot paths
- Include both unit and integration tests for new features

### Architecture Considerations
- Native modules (aerospike, couchbase, grpc, oracledb) don't compile on ARM64
- ESM support requires special loader flags (`--loader` or `--import`)
- Lambda functionality is separate in `datadog-lambda-js` but depends on this library
- Bundling applications requires special considerations (see ESBuild plugin)

## CI/CD

GitHub Actions workflows in `.github/workflows/`:
- `apm-integrations.yml`: Plugin integration tests (main test suite)
- `platform.yml`: Platform-specific tests
- `appsec.yml`: Application Security tests
- `llmobs.yml`: LLM Observability tests
- `profiling.yml`: Profiling tests
- `all-green.yml`: Ensures all required checks pass

## Pull Request Template

When creating PRs, use the template in `.github/pull_request_template.md`. For plugin PRs, complete the Plugin Checklist covering unit tests, integration tests, benchmarks, TypeScript definitions, and CI configuration.

## Additional Resources

- [Contributing Guide](CONTRIBUTING.md): Detailed contribution guidelines
- [API Documentation](https://datadog.github.io/dd-trace-js): Generated API docs
- [Node.js Tracing Docs](https://docs.datadoghq.com/tracing/languages/nodejs/): Official product documentation
