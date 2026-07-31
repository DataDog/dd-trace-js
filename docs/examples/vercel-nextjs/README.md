# Datadog APM For Next.js On Vercel

This prototype shows the Builder boundary required to initialize `dd-trace`
before Next.js in Vercel Node functions. It delegates the framework build to
Vercel's official `@vercel/next` Builder, then packages the tracer and configures
an early Node preload in each public Node `.func`. Edge functions are left
unchanged.

## Application Setup

No application source, Next.js configuration, or `dd-trace` dependency is
required. The published Builder owns the supported tracer version so its
runtime artifact is reproducible and tested as one release unit.

## Builder Setup

Configure the intended Datadog Builder once in `vercel.json`, as shown in
[`vercel.json`](./vercel.json). The Datadog Vercel integration should eventually
own this configuration so the customer only enables APM and deploys.

The Builder stages the published tracer package and uses Vercel's Node File
Trace for its declared runtime dependencies. It maps that runtime into each
Node function and merges
`--import=dd-trace/initialize.mjs` into that function's existing `NODE_OPTIONS`.
It does not change the function handler, set project-global `NODE_OPTIONS`,
alter Edge output, or depend on Trace Drain.

Use Vercel's normal source-build deployment path. The Datadog integration must
configure the selected agentless exporter, `DD_API_KEY`, and normal Datadog
service tags as encrypted project settings. Do not commit API keys or enable
`DD_TRACE_DEBUG` in production.

## Release Status

`@datadog/vercel-next-builder` is not published by this repository. This
directory is therefore a tested prototype and onboarding contract, not a
customer-installable release. Publishing the Builder requires a package owner,
package manifest with `@vercel/next`, `@vercel/nft`, and `dd-trace`
dependencies, registry/release workflow, and live Vercel acceptance before this
configuration can be supported.
