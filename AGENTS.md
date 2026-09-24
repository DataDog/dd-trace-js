# AGENTS.md

dd-trace-js is Datadog's tracing and observability library for Node.js.

These instructions apply repository-wide. More specific instructions may exist in nested directories and take
precedence within their scope.

## Setup and Commands

- Use a Node.js version satisfying `package.json#engines`; service-backed tests require Docker with Docker Compose.
- Use yarn 1.x only to install dependencies (`yarn add`, `yarn install`) and run `yarn services`.
- Use npm for scripts, tests, linting, builds, and all other commands: `npm run <script>`.
- Never run the root `npm test`; it is intentionally disabled. Use a targeted `test:<area>` script or spec below.

## Development Workflow

1. Read the relevant implementation and tests; search for existing utilities before adding another implementation.
2. Choose the smallest clean solution. Ask before implementing when meaningful architectural trade-offs exist.
3. Keep changes focused. Justify new dependencies and refactors outside the requested behavior.
4. Cover behavior changes, failure cases, and relevant edge cases. Run narrow validation first, then broaden as needed.
5. Report the commands run and their results; do not claim validation that was not performed.

Prefer composition and explicit contracts. Avoid new public APIs unless the use case requires a lasting contract.
Do not expose internals or bend production code solely to make a test possible. Fix upstream issues upstream rather
than maintaining a local workaround when practical.

## Testing

Run individual specs from the repository root:

```bash
./node_modules/.bin/mocha path/to/test.spec.js
./node_modules/.bin/mocha --timeout 60000 path/to/integration-test.spec.js
```

Use `node scripts/mocha-run-file.js path/to/test.spec.js` when the spec must be the process entrypoint.
Preserve required Node flags from the suite script, such as `--expose-gc`.
Use the Mocha CLI `--grep` option to select test names.
Integration tests may require Docker, network access, and elevated sandbox permissions.

Set `PLUGINS` explicitly. Clear inherited `SPEC` unless intentionally narrowing by filename prefix.
Unset inherited `SERVICES` when the plugin requires no service.
Clear exporter variables in the shell running each plugin command:

```bash
unset OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER
PLUGINS="<name>" npm run test:plugins:ci
```

The `:ci` script runs `yarn services` to install versioned dependencies and check services before testing.
After setup, use `PLUGINS="<name>" npm run test:plugins` to rerun without repeating dependency installation.
For service-backed plugins, find the required containers and `SERVICES` filter in
`.github/workflows/apm-integrations.yml`. Match the containers to service names in `docker-compose.yml`, then run:

```bash
docker compose up -d <compose-services>
SERVICES="<workflow-service-filter>" PLUGINS="<name>" npm run test:plugins:ci
```

`aerospike`, `couchbase`, `grpc`, and `oracledb` are incompatible with ARM64.

- Use `node:assert/strict`; use `assertObjectContains` from `integration-tests/helpers/index.js` for partial objects.
- Prefer `assert.throws`/`assert.rejects` and pin the relevant error fields.
- Await independently started promises with `Promise.all` so one cannot reject while another is awaited.
- For boundaries, test the last accepted and first rejected values.
- Never rely on real time in unit tests; use sinon fake timers.
- Test real entry points and observable output, not prototype-created instances or test-only production hooks.
- A bug fix must cover the failure and untested sibling cases sharing the corrected path.
- When a fix removes a path, assert its public absence or surviving behavior; do not recreate obsolete state to test it.
- Scope coverage to changed production paths.

See `CONTRIBUTING.md#testing` for detailed test conventions and service setup.

When adding or modifying Test Optimization or test framework tests, follow
[the testing workflow](.agents/skills/test-optimization-testing/SKILL.md).
Every added or modified test must pass or be explicitly skipped under v5.

## Code Style

- Use `npm run lint` and `npm run lint:fix`; lines are limited to 120 characters.
- Use kebab-case filenames and end files with one newline.
- Prefer optional chaining, destructuring, `undefined` over `null`, and short expressive names over abbreviations.
- Comments should explain non-obvious intent, constraints, or trade-offs, not narrate the code.
- Prefer `#private` fields for class-local state. Avoid accessors and large refactors of existing `_underscore` fields.
- Never use `for-in`; use `for-of`, `for`, or `while` in production hot paths.
- Use **Test Optimization** in repository-owned names/prose; preserve external names, ids, and cross-SDK terms.

Group imports with blank lines: Node.js core modules with `node:`, third-party modules, then internal modules.
Sort within groups, with internal modules ordered furthest path first. Preserve tracer-first loading where required.

For new or changed methods with a non-obvious contract, add TypeScript-compatible JSDoc with specific parameter types.
Omit inferable return types and do not repeat inherited or interface contracts on conventional overrides. Reuse existing
typedefs, never use `any`, and do not add runtime work solely for static typing.
Do not rewrite unrelated code for its types.

## Production Safety and Performance

The tracer runs in user applications and hot paths:

- Tracer, instrumentation, and logging failures must not escape into or terminate customer applications. Invalid
  configuration may disable a subsystem during initialization; partial initialization or recovery is not required
  without a public contract. Preserve the application's own thrown, rejected, or callback error outcome.
- Use `packages/dd-trace/src/log/index.js` with printf-style formatting; use callback formatting for expensive data.
- Do not add promise machinery to synchronous library paths or inactive and hot paths. Inherently asynchronous APIs,
  control-plane code, and worker threads may follow their upstream asynchronous contract; keep inactive paths cheap.
- Avoid unnecessary allocations, closures, listeners, parsing, and per-call compilation. Cache reusable work.
- Avoid try/catch in hot paths when inputs can be validated early.
- Use `.once()` for one terminal event on a conforming Node.js `EventEmitter`. Multiple terminal names need a shared
  completion guard and cleanup. Do not defend against a non-conforming emitter without supported-source proof. Put
  process `beforeExit` work in
  `globalThis[Symbol.for('dd-trace')].beforeExitHandlers`.
- A performance-motivated complexity increase needs reproducible measurement. Prefer readable code within ~±2%,
  and keep ≥5% reproducible wins with the numbers. Add a lasting benchmark only for a stable workload
  that warrants a regression guard; otherwise record the temporary workload, runtime, baseline, candidate, and results.

## Backportability and Runtime Support

Changes from `master` are backported to older release lines. Minimize breaking changes and remain compatible with
Node.js 18 APIs unless guarded. Use `version.js` for package-version gates. Never hardcode a Node.js major in runtime
support checks; derive the range from `package.json` fields `engines.node` and `nodeMaxMajor`, and honor
`DD_INJECT_FORCE` in specs that need a live tracer.

Update every supported public TypeScript surface for new public APIs unless the change is explicitly version-specific.

## Cross-Cutting Configuration Changes

For new top-level tracer options or environment variables, update these surfaces.
Other settings update only their owning surfaces:

1. Define the environment variable, type, default, and applicable `configurationNames` in
    `packages/dd-trace/src/config/supported-configurations.json`.
2. Run `npm run generate:config:types` after registry changes. Do not edit generated configuration types manually.
3. The registry drives ordinary defaults, environment and option mappings, and configuration telemetry.
    Change runtime configuration code only when the existing registry machinery cannot express the required behavior.
4. Update both supported public TypeScript surfaces and their documentation comments when applicable.
    API reference documentation is generated from these declarations.
    Edit `docs/API.md` only for additional guide content.
5. Test the option in `packages/dd-trace/test/config/index.spec.js`.

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
- Before opening or updating a PR, read and follow `.github/pull_request_template.md`.
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

Instrumentations hook libraries and publish diagnostic-channel events; plugins own tracing behavior.
Validate new plugin registration and structure with
`./node_modules/.bin/mocha packages/dd-trace/test/plugins/plugin-structure.spec.js`.

Use `dc-polyfill` for production diagnostic-channel imports. Do not import `node:diagnostics_channel` directly.

For vendored rspack dependencies, run yarn from `vendor/`; generated bundles are written under
`packages/node_modules/`.
