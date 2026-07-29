# Datadog APM For Next.js On Vercel

This prototype shows the Builder boundary required to initialize `dd-trace`
before Next.js in Vercel Node functions. It delegates the framework build to
Vercel's official `@vercel/next` Builder, then changes only the public Build
Output API handler in each Node `.func`. Edge functions are left unchanged.

## Application Setup

Install `dd-trace` as a production dependency and add
[`instrumentation.js`](./instrumentation.js) at the application root. If the
application already has one, merge the Node-runtime import into `register`.

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

Use Vercel's normal source-build deployment path. Configure `DD_API_KEY` and
normal Datadog service tags through the Vercel integration or encrypted project
environment settings. Do not commit API keys or enable `DD_TRACE_DEBUG` in
production.

## Release Status

`@datadog/vercel-next-builder` is not published by this repository. The
repository release workflow publishes only `dd-trace`, and
`packages/datadog-plugin-next` is not an independently publishable package.
This directory is therefore a tested prototype and onboarding contract, not a
customer-installable release. Publishing the Builder requires a package owner,
package manifest, registry/release workflow, and live Vercel acceptance before
this configuration can be supported.
