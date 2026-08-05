# Datadog APM for Next.js on Vercel

This prototype shows the Builder boundary required to initialize `dd-trace`
through Next.js's supported instrumentation hook. Before delegating to Vercel's
official `@vercel/next` Builder, it writes `instrumentation.ts`. Next then
builds and traces its normal Node function output. It also prepends the early
`dd-trace/initialize.mjs` preload to each Node function's local `NODE_OPTIONS`.
Edge initialization is skipped.

## Application Setup

Install `dd-trace` as a production dependency in the application before
deploying. The Builder does not modify package manifests or lockfiles.

## Builder Setup

Configure the intended Datadog Builder once in `vercel.json`, as shown in
[`vercel.json`](./vercel.json). The Datadog Vercel integration should eventually
own this configuration so the customer only enables APM and deploys.

The Builder never overwrites an existing root or `src/instrumentation.*` file.
It fails before installation and asks the customer to add `dd-trace/init` to
their own hook instead. This avoids composing arbitrary customer code.

Current Next.js automatically treats `dd-trace` as a server external. This is
separate from normal output-file tracing: Next keeps the tracer out of function
source bundles while its normal NFT pass supplies the runtime files. The
generated hook makes the tracer visible to that pass; the function-local preload
performs initialization before Next. The Builder does not copy tracer files or
add unsupported function settings.

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
package manifest with `@vercel/next` and `@vercel/build-utils` dependencies,
registry/release workflow, and live Vercel acceptance before this configuration
can be supported.
