# Vercel Next Builder Prototype

Vercel may deploy Next.js applications as a mix of Node and Edge functions.
`dd-trace` must load before Next in each Node function, while Edge functions
must not attempt to load the Node tracer.

The prototype in [`examples/vercel-nextjs`](./examples/vercel-nextjs/README.md)
delegates to `@vercel/next.build()`. When the official Builder returns a public
Build Output API directory, it stages the Builder's installed `dd-trace`
dependency graph once, isolates transitive dependencies under the tracer,
maps it into each Node `.func`, and prepends
`--import=dd-trace/initialize.mjs` to each function's existing `NODE_OPTIONS`.
It preserves handlers and Edge output and does not use project-global
`NODE_OPTIONS`, trace drain, source mapping, debug logging, or customer secrets.

The target package name is `@datadog/vercel-next-builder`. It must declare
`@vercel/next` and a supported `dd-trace` version as dependencies. It cannot be
legitimately added as a published package to this repository without release
ownership because the current release workflow publishes only the root
`dd-trace` package. The prototype intentionally supports only the current public
Build Output API directory contract.

Live source-build verification on Next.js 16 exercised App Router, Pages
Router, and Edge routes, concurrent requests, and outbound calls. The Edge
route remained unmodified and returned successfully. Direct OTLP intake
received a 14-span distributed Node trace containing `web.request`,
`next.request`, `fetch`, TCP, and DNS spans.
