---
name: serverless-integrations
description: |
  Use when adding, modifying, debugging, or reviewing dd-trace-js serverless integrations that own cloud-function
  invocations, including AWS Lambda bootstrap behavior, Azure Functions, GCP Functions, serverless root spans,
  runtime handler wrapping, timeout flushing, DD_LAMBDA_HANDLER, and deployed verification.
---

# Serverless integrations

Use the APM skill for shared instrumentation/plugin mechanics. Keep only the serverless delta here: invocation
ownership, runtime lifecycle, trigger context, and flush behavior. A library called inside a function is ordinary
APM.

Run `npm run verify:integration-skills` after checkout, rebase, or skill edits. For a plugin-backed runtime, run
`npm run inspect:integration -- <id> --mode serverless [--package <npm-name>] [--traits <list>]`.
Traits only select references. Before ownership, read reported plugins, contract sources, dependents, and channel
anchors; registry package names are authoritative.

## Classify the owner

- Plugin-backed runtime: runtime registration/execution → trace-agnostic instrumentation → tracing channel → plugin
  → invocation span.
- AWS Lambda bootstrap: handler resolution, runtime patching, timeout signaling, and crash flushing under
  `packages/dd-trace/src/lambda/`. This path does not currently create the invocation span.

Do not copy the Lambda bootstrap into an npm-package integration or add an invocation span there without first
tracing the active-span owner through the extension and runtime path.

## Read the runtime contract

For every supported runtime version, read the provider source and record handler registration/resolution, supported
completion forms, request/event/context carriers, batch cardinality, timeout/shutdown signals, and duplicate-wrap
possibilities. Read the nearest real launcher/emulator fixture and its current workflow job.

## Plugin-backed invariants

- Establish the invocation context before user code; child integrations must inherit it.
- Start and finish each invocation span exactly once. Completion follows recorded runtime state, not timer ordering.
- Extract distributed context at the runtime boundary; link every valid upstream context for a batch rather than
  choosing one arbitrary parent.
- Keep resources low-cardinality. Request, message, event, and object identifiers do not belong in resources.
- Reuse `packages/dd-trace/src/plugins/util/web.js` for HTTP tags, inferred proxies, status, and AppSec behavior.
- Preserve diagnostic-channel events needed by non-tracing subscribers when tracing is disabled.
- Catch and log instrumentation failures without blocking the user handler.

Register plugin-backed invocation ids in both serverless naming schemas and update the runtime hook, plugin getter,
types/docs, CODEOWNERS, workflow, version manifest, and real runtime fixture as applicable. Discover the current
shape from adjacent entries rather than copying a stored scaffold.

## Lambda bootstrap invariants

Read `packages/dd-trace/src/lambda/index.js`, `packages/dd-trace/src/lambda/runtime/patch.js`,
`packages/dd-trace/src/lambda/handler.js`, and their tests as one path. Preserve the disabled-instrumentation gate
and handler loading on hook failures. Use fake timers for timeout deadlines and pin the last safe point plus the
first timeout point.

Verify writer/flush behavior against lifecycle the local runtime can reproduce. Use deployed verification only for
provider-owned behavior such as freeze timing or injected metadata.

## Proof

Read [Testing serverless integrations](references/testing-guide.md). Exercise the provider runtime or emulator, not
a direct call to an exported helper. Cover supported success/error/completion paths, disabled instrumentation,
parenting, carriers/links, HTTP behavior where applicable, duplicate wrapping, and exactly-once finish.

For a review, return ownership and lifecycle findings only. For a design, return the owner, boundary, real test
path, and unresolved provider evidence; omit a workflow recap.
