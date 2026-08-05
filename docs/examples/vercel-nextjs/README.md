# Datadog APM for Next.js on Vercel

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

The Builder copies `dd-trace/initialize.mjs` into every Node function and uses
Vercel's Node File Trace to include the initialization entrypoint's actual
runtime closure in that function, nested under `dd-trace` so it cannot replace
the application's dependencies. It then merges
`--import=dd-trace/initialize.mjs` into that function's existing `NODE_OPTIONS`.
It does not change the function handler, set project-global `NODE_OPTIONS`,
alter Edge output, or depend on Trace Drain.

Current Next.js automatically treats `dd-trace` as a server external. This is
separate from the Builder's runtime closure: Next keeps the tracer out of
function source bundles, while NFT supplies the files that native Node module
resolution needs at runtime. The Builder does not add an unsupported
post-build external-dependency setting.

Use Vercel's normal source-build deployment path. The Datadog integration must
configure direct OTLP endpoints and encrypted headers for traces, logs, and
metrics. It must also enable `OTEL_TRACES_EXPORTER=otlp`,
`DD_LOGS_OTEL_ENABLED=true`, and `DD_METRICS_OTEL_ENABLED=true`, alongside the
normal Datadog service tags. Customers do not commit API keys or OTLP headers
to their application, and `DD_TRACE_DEBUG` remains disabled in production.

## Release Status

`@datadog/vercel-next-builder` is not published by this repository. This
directory is therefore a tested prototype and onboarding contract, not a
customer-installable release. Publishing the Builder requires a package owner,
package manifest with `@vercel/next`, `@vercel/nft`, and `dd-trace`
dependencies, registry/release workflow, and live Vercel acceptance before this
configuration can be supported.
