# AGENTS.md

dd-trace-js is Datadog's tracing and observability library for Node.js.

These instructions apply repository-wide. More specific instructions may exist in nested directories and take
precedence within their scope. Read the relevant implementation and tests before editing; keep changes focused and
do not modify unrelated behavior.

## Setup and Commands

- Prerequisites: a Node.js version satisfying `package.json#engines` (`>=22` on `master`), yarn 1.x, and Docker
  with Docker Compose for service-backed tests.
- Use yarn only to install dependencies (`yarn add`, `yarn install`) and run `yarn services`.
- Use npm for scripts, tests, linting, builds, and all other commands: `npm run <script>`.
- The root `npm test` is intentionally disabled. Run a specific `*.spec.js` file or targeted `test:<area>` script.

## Repository Map

- `packages/dd-trace/` — tracer implementation and product features
- `packages/datadog-core/` — async context storage and shared utilities
- `packages/datadog-instrumentations/` — third-party library instrumentation
- `packages/datadog-plugin-*/` — integration plugins
- `integration-tests/` — end-to-end and process-level tests
- `benchmark/` — performance benchmarks
- `scripts/` — repository and release tooling
- `vendor/` — bundled dependencies

Packages generally contain `src/` and `test/`; unit tests use the `*.spec.js` suffix.

## Development Workflow

1. Search for existing utilities and patterns before introducing another implementation.
2. Read the relevant production code and existing tests to understand the real behavior.
3. Choose the smallest clean solution. Ask before implementing when meaningful architectural trade-offs exist.
4. Implement the change without unrelated refactors or new dependencies unless justified.
5. Add or update tests for behavior changes, including failure cases and relevant edge cases.
6. Run the narrowest relevant validation first, then broaden it when needed.
7. Report the commands run and their results; do not claim validation that was not performed.

Prefer composition and explicit contracts. Avoid new public APIs unless the use case requires a lasting contract.
Do not expose internals or bend production code solely to make a test possible. Fix upstream issues upstream rather
than maintaining a local workaround when practical.

## Testing

Run individual tests with:

```bash
./node_modules/.bin/mocha path/to/test.spec.js
./node_modules/.bin/mocha --timeout 60000 path/to/integration-test.spec.js
```

Use `node scripts/mocha-run-file.js path/to/test.spec.js` when a spec must be the process entrypoint. Use `--grep`
to narrow a test. Integration tests may require Docker, network access, and elevated sandbox permissions.

For plugin tests:

```bash
unset OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER
PLUGINS="<name>" npm run test:plugins
```

Use `SPEC` to narrow plugin specs. For service-backed plugins, find `<service>` in
`.github/workflows/apm-integrations.yml`, then run:

```bash
docker compose up -d <service>
SERVICES="<service>" PLUGINS="<name>" npm run test:plugins:ci
```

`aerospike`, `couchbase`, `grpc`, and `oracledb` are incompatible with ARM64.

- Use `node:assert/strict`; use `assertObjectContains` from `integration-tests/helpers/index.js` for partial objects.
- Prefer `assert.throws`/`assert.rejects` and pin the relevant error fields.
- Await independently started promises with `Promise.all` so one cannot reject while another is awaited.
- For boundaries, test the last accepted and first rejected values.
- Never rely on real time in unit tests; use sinon fake timers.
- Test real entry points and observable output, not prototype-created instances or test-only production hooks.
- A bug fix must cover the failure and untested sibling cases sharing the corrected path.
- Scope coverage to changed production paths. Sandbox integration tests do not contribute to nyc coverage.

See `CONTRIBUTING.md#testing` for detailed test conventions and service setup.

## Code Style

- Use `npm run lint` and `npm run lint:fix`; lines are limited to 120 characters.
- Use kebab-case filenames and end files with one newline.
- Prefer optional chaining, destructuring, `undefined` over `null`, and short expressive names over abbreviations.
- Comments should explain non-obvious intent, constraints, or trade-offs, not narrate the code.
- Prefer `#private` fields for class-local state. Avoid accessors and large refactors of existing `_underscore` fields.
- Never use `for-in`; use `for-of`, `for`, or `while` in production hot paths.
- Call the product **Test Optimization** in new names and prose; retain legacy `ci-visibility` spellings only in
  existing module paths and classes.

Group imports with blank lines and sort within each group:

1. Node.js core modules using the `node:` prefix
2. Third-party modules
3. Internal modules, furthest path first

For new methods, add TypeScript-compatible JSDoc with specific parameter and return types. Reuse existing typedefs,
never use `any`, and do not add runtime work solely to satisfy static typing. Do not rewrite unrelated code only to
improve its types.

## Production Safety and Performance

The tracer runs in user applications and hot paths:

- Never crash a user application. Catch and log errors, then resume safely or disable the affected subsystem.
- Use `packages/dd-trace/src/log/index.js` with printf-style formatting; use callback formatting for expensive data.
- Do not add promises or `async`/`await` to shipped production code. They are allowed in tests and worker threads.
- Avoid unnecessary allocations, closures, listeners, parsing, and per-call compilation. Cache reusable work.
- Avoid try/catch in hot paths when inputs can be validated early.
- Use `.once()` for one-shot events. Register process `beforeExit` work in
  `globalThis[Symbol.for('dd-trace')].beforeExitHandlers`.
- A performance-motivated complexity increase requires a focused, reproducible microbenchmark. Keep the more
  readable implementation when results are effectively equal.

## Backportability and Runtime Support

Changes from `master` are backported to older release lines. Minimize breaking changes and remain compatible with
Node.js 18 APIs unless guarded. Use `version.js` for package-version gates. Never hardcode a Node.js major in runtime
support checks; derive the range from `package.json` fields `engines.node` and `nodeMaxMajor`, and honor
`DD_INJECT_FORCE` in specs that need a live tracer.

Update every supported public TypeScript surface for new public APIs unless the change is explicitly version-specific.

## Cross-Cutting Configuration Changes

When adding configuration:

1. Add the default in `packages/dd-trace/src/config/defaults.js`.
2. Map the environment variable in `packages/dd-trace/src/config/index.js`.
3. Update public TypeScript definitions in both supported surfaces when applicable.
4. Add the telemetry name mapping in `packages/dd-trace/src/telemetry/telemetry.js` when applicable.
5. Update `packages/dd-trace/src/config/supported-configurations.json`.
6. Document non-internal, non-experimental options in `docs/API.md`.
7. Test the option in `packages/dd-trace/test/config/index.spec.js`.

Use unit suffixes for size and time options, such as `timeoutMs`, `maxBytes`, and `intervalSeconds`.

## Debugging Failures

Treat a failure on your change as caused by the change until you can name evidence proving otherwise. “Flaky”,
“pre-existing”, and “unrelated” require evidence such as the same failure on the unchanged target branch, a
tracked known flake, or a passing rerun plus a credible nondeterminism mechanism. Otherwise the cause remains unknown.

Fix causes, not symptoms: do not loosen assertions, filter inputs, or increase timeouts to hide failures. Search for
sibling occurrences of deterministic problems and fix the shared cause. For a hung job, inspect the last meaningful
error and leaked handles before treating it as slow. Genuine unrelated flakes belong in a separate tracked change;
never weaken or delete assertions to make them pass.

## Pull Requests and CI

- Commit format: `type(scope): description`.
- Types: `feat`, `fix`, `perf`, `refactor`, `test`, `bench`, `docs`, `chore`, `ci`.
- Reserve `feat`, `fix`, and `perf` for shipped production code; use the area type for tests, benchmarks, CI, or tools.
- Use `.github/pull_request_template.md` and the appropriate `semver-patch`, `semver-minor`, or `semver-major` label.
- All required tests must pass; the repository follows an all-green policy.

## Specialized Workflows

Load the relevant repository skill when the task matches:

- [Third-party instrumentation or plugins](.agents/skills/apm-integrations/SKILL.md)
- Shared abstractions, duplicated behavior across types, module boundaries, class hierarchies, or public APIs:
  [`architecture-review`](.agents/skills/architecture-review/SKILL.md)
- [Suspected flaky or unrelated test failures](.agents/skills/flaky-test-fixer/SKILL.md)
- [LLMObs integrations](.agents/skills/llmobs-integration/SKILL.md)
- [LLMObs tests and VCR cassettes](.agents/skills/llmobs-testing/SKILL.md)
- [Serverless platform integrations](.agents/skills/serverless-integrations/SKILL.md)

New instrumentations belong in `packages/datadog-instrumentations/` and communicate with plugins through diagnostic
channels. Validate new plugin structure with
`./node_modules/.bin/mocha packages/dd-trace/test/plugins/plugin-structure.spec.js`.

For vendored rspack dependencies, run yarn from `vendor/`; generated bundles are written under
`packages/node_modules/`.
