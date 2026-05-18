---
name: integration-internals
description: |
  Supplementary deep-dive for dd-trace-js integration work. Use alongside the
  repo's apm-integrations skill when you need details on: ESM detection and
  dual-package handling, diagnostic channel internals (runStores vs publish,
  three channel types, tracingChannel API), shimmer function-type patterns
  (sync/async/callback/factory), addHook API, double-patching prevention,
  dd-debug debugging tool, test failure diagnosis (80/20 rule), manual test
  patterns (withVersions + agent.load), hot-path performance rules, or
  environment variables for debugging.
  Triggers: "ESM", "esmFirst", "dual module", "runStores", "publish",
  "diagnostic channel", "tracingChannel", "three channel types",
  "shimmer pattern", "callback wrapping", "addHook", "double patch",
  "dd-debug", "test failing", "timeout", "wrong tags", "channel mismatch",
  "performance", "hot path", "hasSubscribers", "failure mode",
  "createIntegrationTestSuite", "withVersions", "agent.load",
  "DD_TRACE_DEBUG", "environment variable".
---

# Integration Internals

Supplementary reference for dd-trace-js integration development. This skill fills gaps not covered by the repo's `apm-integrations` skill — read that skill first.

## ESM Detection & Dual-Package Handling

See [references/esm.md](references/esm.md) for:
- Detecting whether a package is CJS, ESM, or dual
- The `esmFirst` flag and when to set it
- Handling different export styles across module systems
- Ensuring both CJS and ESM builds are instrumented

## Diagnostic Channels Deep Dive

See [references/channels.md](references/channels.md) for:
- Three channel types: plain `dc.channel`, `tracingChannel`, orchestrion
- `tracingChannel` API and auto-suffixed events
- `runStores()` vs `publish()` with detailed examples
- Channel event lifecycle diagram
- Callback wrapping for context propagation

## Shimmer Function-Type Patterns

See [references/shimmer-patterns.md](references/shimmer-patterns.md) for:
- Synchronous, async/promise, callback, handler/event, and factory wrapping patterns
- `addHook` API (name, versions, file parameters)
- Preventing double-patching (Symbol guard)
- Common mistakes and fixes

These patterns are needed when orchestrion cannot be used.

## Debugging with dd-debug

See [references/debugging.md](references/debugging.md) for:
- dd-debug usage and commands (superior to `DD_TRACE_DEBUG`)
- Output symbols reference (SUBSCRIBE, PUBLISH, LISTENER, SPAN)
- Quick diagnosis flowchart
- Failure modes and fixes (the 80/20 rule: 80% tags, 20% channels)

## Test Helpers & Environment

See [references/test-environment.md](references/test-environment.md) for:
- `createIntegrationTestSuite` helper
- Manual test pattern (`withVersions` + `agent.load/close`)
- Docker services table
- `externals.json` and `versions/package.json`
- Environment variables (`DD_TRACE_DEBUG`, `DD_TRACE_LOG_LEVEL`, plugin enable/disable)
- ARM64 incompatible packages
- Test commands reference

## Plugin Writing Patterns

See [references/plugin-patterns.md](references/plugin-patterns.md) for:
- Base class hierarchy and selection guide
- Base class features (DatabasePlugin DBM, ClientPlugin peer service, etc.)
- Key files reference table
- Plugin registration
- Code style rules and reference implementations
- Debugging the ctx object

## ESM Integration Testing

See [references/esm-testing.md](references/esm-testing.md) for:
- Subprocess-based ESM test file structure
- server.mjs and client.spec.js templates
- Key helpers: useSandbox, spawnPluginIntegrationTestProcAndExpectExit, FakeAgent, varySandbox
- `--import` vs `--loader` distinction for LLM packages

## Performance & Code Quality

See [references/performance.md](references/performance.md) for:
- Hot-path rules (allocations, loops, closures)
- `hasSubscribers` optimization
- GC pressure reduction
- Logging best practices (printf-style, callback form)
- Error handling patterns
- Code quality checklist
