# Datadog APM for Next.js on Vercel

This prototype shows the Builder boundary required to initialize `dd-trace`
before Next.js in Vercel Node functions. It delegates the framework build to
Vercel's official `@vercel/next` Builder, then changes only the public Build
Output API handler in each Node `.func`. Edge functions are left unchanged.

This integration branch uses Bengl native spans and libdatadog to send traces
directly to Datadog over OTLP. It does not use the removed legacy
`_DD_APM_TRACING_AGENTLESS_ENABLED` exporter.

## Application Setup

Install `dd-trace` as a production dependency and add
[`instrumentation.js`](./instrumentation.js) at the application root. If the
application already has one, merge the Node-runtime import into `register`.
Keep the `NEXT_RUNTIME === 'nodejs'` guard so Edge functions do not load the
Node tracer.

Keep `dd-trace` external in `next.config.js` so Next's output-file tracing
includes its runtime dependency closure:

```js
/** @type {import('next').NextConfig} */
module.exports = {
  serverExternalPackages: ['dd-trace'],
}
```

## Builder Setup

Configure the intended Datadog Builder once in `vercel.json`, as shown in
[`vercel.json`](./vercel.json). Its package must provide `builder.js` from this
directory and declare `@vercel/next` as its dependency.

The Builder writes a CommonJS launcher next to each public Node function
handler. The launcher requires `dd-trace/init` before loading the unchanged
Next launcher. It does not set project-global `NODE_OPTIONS`, mutate a local
prebuilt deployment, alter Edge output, use Vercel private file maps, or depend
on Trace Drain.

Use Vercel's normal cloud source-build deployment path.

## Native OTLP Setup

Configure these Vercel project environment variables:

```text
OTEL_TRACES_EXPORTER=otlp
DD_TRACE_OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://vercel.integrations.otlp.datadoghq.com/v1/traces
OTEL_EXPORTER_OTLP_TRACES_HEADERS=dd-api-key=<encrypted API key>,compute_stats=true
DD_API_KEY=<encrypted project secret>
DD_SERVICE=<service name>
DD_ENV=<environment>
DD_VERSION=<version>
DD_TRACE_DEBUG=false
```

Store both `DD_API_KEY` and the API key embedded in
`OTEL_EXPORTER_OTLP_TRACES_HEADERS` as encrypted project environment values.
Never commit, print, or log either value. Do not enable the removed legacy
agentless exporter.

## Request Lifecycle

For normal Node HTTP requests, the HTTP plugin schedules the native OTLP flush
after it finishes the outer `web.request` span. If Vercel invokes Next without
a Node HTTP parent, the Next plugin schedules the fallback flush after its
`next.request` span. The scheduler registers the retained promise with Vercel's
`waitUntil` context before starting the native flush, and resolves it only when
the native exporter callback completes.

Without Trace Drain, valid trace shapes are:

```text
web.request -> next.request -> integration spans
next.request -> integration spans
```

The direct `next.request` shape occurs when Vercel bypasses the Node HTTP
server. An outer Vercel edge parent is not present without Trace Drain.

## Validation Evidence

The final live deployment used Next.js 16.2.12 and produced 16 Node function
bundles covering App, Pages, flow, parallel, and error routes. All 100
user-kept traces were retrievable: 92 had `web.request -> next.request` and 8
used the valid direct-Next shape. There were zero internal parent gaps and no
exporter errors, debug output, or API-key logging.

See the [final Vercel deployment](https://vercel.com/datadog-development/conti-vercel-native-spans-e2e/9dYvNzNvY6rRtowMDa5dRfmYBuAG)
and a [representative trace](https://app.datadoghq.com/apm/trace/5b56be67b18e3563dccd37379cbbc807).

## Release Status

`@datadog/vercel-next-builder` is not published by this repository. The
repository release workflow publishes only `dd-trace`, and
`packages/datadog-plugin-next` is not an independently publishable package.
The Builder still requires a package owner, package manifest, registry release
workflow, productization, and publication. The native OTLP support is also
branch/preview work. This document records verified integration behavior, not
current GA customer onboarding.
