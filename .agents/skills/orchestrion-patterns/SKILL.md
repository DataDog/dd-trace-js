---
name: orchestrion-patterns
description: |
  Migrate or review dd-trace-js integrations that use Orchestrion rewriter
  instrumentation. Use when mapping shimmer/addHook wrappers to
  packages/datadog-instrumentations/src/helpers/rewriter/instrumentations/*.js,
  choosing functionQuery targets or Sync/Async/Callback/AsyncIterator kinds,
  preserving diagnostic channel behavior, wiring plugins to
  tracing:orchestrion package channel prefixes, handling CJS/ESM file paths, or
  debugging Orchestrion channel/plugin mismatches. Triggers: "Orchestrion",
  "rewriter", "functionQuery", "channelName", "getHooks", "migrate shimmer",
  "migrate addHook", "Sync kind", "Async kind", "Callback kind", and
  "AsyncIterator kind".
---

# Orchestrion Patterns

Use Orchestrion as the hook mechanism while preserving the old integration's
observable behavior. Treat the current shimmer/addHook instrumentation, plugin,
tests, and downstream channel subscribers as the compatibility contract.

## Coordinate With Other Skills

Use this skill together with:

- `apm-integrations` for general dd-trace-js instrumentation architecture,
  plugin base-class choice, and test commands.
- `integration-internals` for repository layout, generated files, and local
  workflow details.
- `observability-patterns` when span tags, semantic conventions, or service
  naming are part of the migration.

If `apm-integrations/references/orchestrion.md` is available in the target repo,
read it before writing rewriter config. It is the low-level source of truth for
rewriter schema and edge-case patterns.

## Migration Workflow

1. **Inventory the existing hook surface.** Read
  `packages/datadog-instrumentations/src/<package>.js` before the plugin. List
  every `addHook`, version range, file path, wrapped class/function/method,
  `channel(...)` name, channel event method, and `ctx` field produced by the
  instrumentation.
2. **Extract the behavioral contract.** Read the plugin tests and span
  assertions. Preserve span names, resources, tags, metrics, services, error
  behavior, skip/no-span behavior, and parent/child relationships.
3. **Check downstream subscribers.** Grep every old channel name. IAST, AppSec,
  DSM, or other non-tracing subscribers may need per-call cardinality even when
  tracing only needs one publish per span. Preserve those channels or migrate
  all subscribers deliberately with tests.
4. **Map each old wrapping point to a static Orchestrion target.** Verify the
  actual installed package source under the supported version fixture before
  choosing `functionQuery` fields. Do not infer kind or file path from the old
  wrapper shape alone.
5. **Bridge instrumentation with `getHooks`.** After registering the rewriter
  config, the package instrumentation entrypoint should normally be only the
  standard `getHooks('<package>')` bridge.
6. **Rewrite the plugin around Orchestrion ctx.** Subscribe with
  `static prefix = 'tracing:orchestrion:<npm-package>:<channelName>'`, read
  data from `ctx.arguments`, `ctx.self`, `ctx.result`, and `ctx.error`, and
  pass `ctx` to `startSpan`.
7. **Verify by contract.** Run the focused plugin tests plus any dependent
  integration checks discovered from channel subscribers or subclassed plugins.

## Halt Instead of Guessing

Stop and explain the blocker if Orchestrion cannot safely express the old
wrapping point. Common blockers include:

- the old wrapper mutates arguments before the original call and no equivalent
  Orchestrion-safe pattern is established;
- the old wrapper instruments a factory return value or runtime-created method
  with no stable static dispatch function;
- the old channel is published from a wrapper passed into the library and no
  source-verified dispatch target exists;
- the target file path, class, or function differs across supported versions and
  the split cannot be verified locally.

Do not silently drop an old channel, loosen a test, or keep both shimmer and
Orchestrion wrapping the same operation.

## Reference

Read [rewriter-and-plugin.md](references/rewriter-and-plugin.md) when writing or
reviewing the rewriter config, plugin subscriptions, finish method selection,
CJS/ESM path coverage, or dependent channel compatibility.
