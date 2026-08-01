---
name: apm-integrations
description: |
  Use when adding, debugging, fixing, reviewing, or modifying dd-trace-js instrumentation and plugins for
  third-party libraries. Trigger on addHook, shimmer, Orchestrion, diagnostic channels, TracingPlugin subclasses,
  bindStart/bindFinish, runStores, subscriber cardinality, upstream source, and integration tests.
---

# APM integrations

Keep instrumentation under `packages/datadog-instrumentations/src/` trace-agnostic: observe the library and publish
diagnostic-channel context. Keep span naming, tags, parenting, errors, and completion in
`packages/datadog-plugin-<name>/src/`.

Use `serverless-integrations` for a cloud-function invocation and the LLMObs skills for LLMObs spans. Reuse this
skill only for their shared instrumentation and plugin mechanics.

## Route and bound evidence

Choose one mode before reading: **add** follows source → hook → plugin → full registration ledger → proof; **review**
reads the diff and only contracts it invokes; **debug/fix** reproduces → finds the owner → covers siblings; hand a
cloud-function invocation to `serverless-integrations`.

Run `npm run verify:integration-skills` after checkout, rebase, or skill edits; derive a fresh task map with
`npm run inspect:integration -- <id> --mode <add|review|debug> [--package <npm-name>] [--traits <list>]`. Name the
plugin base (`database`, `cache`, etc.) among traits, plus mechanisms such as `orchestrion`, `callback`, or `cjs-esm`.
Treat its paths, base signature, channels, registrations, and selected references as a map, not proof.

Read the exact upstream source and public call first; record arguments, receiver, return identity, errors, and
completion. Compare CJS/ESM builds and version boundaries when they differ. Next read the reported contract and one
closest reference. Expand only for a named unresolved question; search all channel subscribers only when changing
that channel or its cardinality.

For a review, return correctness findings only. For a design, return decisions, touched ledgers, tests, and
unresolved evidence. Omit workflow recaps and consulted-file inventories unless requested.

## Choose the hook

Use Orchestrion when a source function can be matched. It handles CJS/ESM and sync, promise, callback, and iterator
lifecycles without replacing runtime properties. Read [Orchestrion](references/orchestrion.md) only after choosing
it.

Use shimmer only when the required boundary is runtime-created, must mutate arguments before subscribers run, or
belongs to an identity-sensitive return or emitted event. Leave one short comment at the hook naming that concrete
constraint. Read [Shimmer](references/shimmer.md) only after choosing it.

## Implement and register

1. Add the instrumentation and one entry per npm package name in
    `packages/datadog-instrumentations/src/helpers/hooks.js`.
2. For Orchestrion, add the rewriter config, register it in the current instrumentation index, and use `getHooks()`
    from `helpers/instrument.js` in the instrumentation entry.
3. Add the plugin package and getter in `packages/dd-trace/src/plugins/index.js`.
4. Register every id reached by `operationName()` or `serviceName()` in both naming-schema versions for its type.
5. Update `index.d.ts` and `index.d.v5.ts` unless the API is v6-only; update `docs/test.ts`, both `docs/API.md`
    plugin locations, `.github/CODEOWNERS`, and the owning workflow.
6. Pin the latest tested library in `packages/dd-trace/test/plugins/versions/package.json`; keep supported ranges in
    instrumentation declarations.

Discover the current filenames and registration shapes from adjacent entries. Do not preserve a scaffold here:
workflow matrices, package layouts, and public surfaces change more often than their governing ledger.

## Preserve the plugin contract

Read `packages/dd-trace/src/plugins/tracing.js` and the selected subclass before calling `startSpan`.

- `bindStart(ctx)` starts the span with the context object and returns `ctx.currentStore`.
- `TracingPlugin` and most role bases take `startSpan(name, options, ctx)`.
- `CachePlugin`, `ProducerPlugin`, and `ConsumerPlugin` take `startSpan(options, ctx)` and own the name. Passing a
  name shifts every argument.
- `RouterPlugin` is outside the `TracingPlugin` lifecycle.
- Match `static prefix` to the exact channel. Do not add manual subscriptions when lifecycle methods cover it.
- Finish only on the event proving actual completion. A still-pending async call publishes `end` before a result;
  retain the existing result/error presence gate when one plugin handles both sync and async returns.
- Let `TracingPlugin.error(ctx)` tag ordinary errors. Override only for additional tags or a library value that is
  not an error.

Use `CompositePlugin` only when child operations need distinct prefixes, bases, or configuration. A tracing plugin
subscribes to one prefix unless it explicitly overrides subscription setup.

## Preserve channel contracts

Keep per-call publication outside deduplication when any subscriber needs each call. Gate setup with
`hasSubscribers` only when no subscriber needs the event. Never equate a disabled tracing plugin with an unused
channel.

Establish async context through an Orchestrion binding or `runStores()`, not a plain start publish. Instrumentation
owns library-call fields; the plugin consumes them and owns span fields.

## Prove the real path

Read [Testing integrations](references/testing.md), then test through the installed library's public API. Cover the
upstream completion forms and module builds that actually differ, success and error, enabled and disabled tracing,
parenting, and version boundaries. A bug fix also covers sibling cases sharing the changed path.

Run the selected plugin tests, the structural plugin spec, scoped changed-file coverage, `npm run lint`, and
`npm run lint:editorconfig`. Do not declare completion from a hand-built plugin instance or an instrumentation
internal export.
