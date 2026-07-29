# Testing integrations

Test through the library's public API. The test must load the same package entry point and module format a user
loads; do not export instrumentation internals or bypass the package's build to make a unit test convenient.

## Version fixtures

Plugin dependencies live under `versions/`, not the root `node_modules`. Add or update
`versions/<package>/package.json` and use `withVersions(plugin, modules[, range], callback)` from
`packages/dd-trace/test/setup/mocha`. `yarn services` installs the selected fixtures.

The same module exports `withNamingSchema` for v0/v1 operation and service names, and `withPeerService` for peer
service computation. Outbound, storage, and messaging specs cover both.

Read the closest current plugin test before adding setup. Use the existing test agent:

- `agent.load(pluginNames, pluginConfig, tracerConfig)` enables the plugin and returns the live tracer; bind that
  return value instead of requiring `dd-trace` separately.
- `agent.assertFirstTraceSpan(expected)` handles a single span with `assertObjectContains`.
- `agent.assertSomeTraces(callback)` exposes the full trace payload for relationships or several spans.
- `agent.close()` tears down the agent and resets per-test expectations.

Start the assertion promise before triggering the operation, then await both sides when the operation is async.

## Cases

Cover the branches the instrumentation owns:

- success and error completion;
- sync, promise, callback, stream, or iterator forms the upstream API actually supports;
- enabled and disabled plugin paths;
- context propagation and parent/child relationships;
- each CJS and ESM build that has different source;
- version boundaries where the hook path or payload shape changes.

A bug fix includes the reported case and sibling shapes that share the changed hook or completion path. Do not add
permutations the upstream contract excludes.

## ESM and sandbox tests

Use `useSandbox` for native ESM or package-export tests. Load `dd-trace/init.js` before the library and exercise the
real export. The helpers live in `integration-tests/helpers`: `FakeAgent`, whose `assertMessageReceived` method takes
the payload assertion, plus `curlAndAssertMessage`, `sandboxCwd` for the sandbox directory,
`spawnPluginIntegrationTestProcAndExpectExit` to run a server file against the fake agent, and `stopProc` for
teardown.

`varySandbox(filename, { packageName, bindingName, defaultExport, namedExports })` runs after `useSandbox` and
returns a map of variant name to generated filename, one per import form the package's exports allow. Describe the
real exports, and copy a package-specific fixture instead when the runtime requires a directory layout or launcher
`varySandbox` cannot model. Azure Functions is the current example.

Sandbox processes are integration tests and do not contribute to nyc coverage. Keep a same-process test for changed
production branches when coverage would otherwise be missing.

## Commands

Instrumented shells may export OpenTelemetry exporters that bypass the test agent:

```bash
unset OTEL_TRACES_EXPORTER OTEL_LOGS_EXPORTER OTEL_METRICS_EXPORTER
```

Install the selected version fixtures and run the plugin:

```bash
PLUGINS="<name>" npm run test:plugins:ci
```

When fixtures are already installed:

```bash
PLUGINS="<name>" npm run test:plugins
PLUGINS="<name>" SPEC="<substring>" npm run test:plugins
```

For services, copy `SERVICES` and setup from the plugin's current workflow job. Do not invent a Docker service name:

```bash
export SERVICES="<service>" PLUGINS="<name>"
docker compose up -d <service>
yarn services
npm run test:plugins
```

Run the structural contract:

```bash
./node_modules/.bin/mocha packages/dd-trace/test/plugins/plugin-structure.spec.js
```

For changed production files, run nyc with `--include` scoped to those files and inspect changed-line and branch
coverage before declaring the integration complete.
