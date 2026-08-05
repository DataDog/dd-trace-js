# Vercel Next Builder Prototype

Vercel may deploy Next.js applications as a mix of Node and Edge functions.
`dd-trace` must load before Next in each Node function, while Edge functions
must not attempt to load the Node tracer.

The prototype in [`examples/vercel-nextjs`](./examples/vercel-nextjs/README.md)
delegates to `@vercel/next.build()`. When the official Builder returns a public
Build Output API directory, it traces `dd-trace/initialize.mjs` into each Node
`.func` with Vercel's Node File Trace and prepends
`--import=dd-trace/initialize.mjs` to each function's existing `NODE_OPTIONS`.
Non-tracer dependencies in that closure are nested under `dd-trace`, so the
Builder does not overwrite the application's runtime dependencies.
It preserves handlers and Edge output and does not use project-global
`NODE_OPTIONS`, Trace Drain, source mapping, debug logging, or customer secrets.
Next.js already lists `dd-trace` as a server external, so it stays outside
function source bundles. NFT's per-function closure provides the corresponding
runtime files; no post-build external-dependency configuration is needed or
supported.
The Datadog integration configures direct OTLP intake for traces, logs, and
metrics independently of the Builder's packaging work.

The target package name is `@datadog/vercel-next-builder`. It must declare
`@vercel/next`, `@vercel/nft`, and a supported `dd-trace` version as
dependencies. It cannot be legitimately added as a published package to this
repository without release ownership because the current release workflow
publishes only the root `dd-trace` package. The prototype intentionally supports
only the current public Build Output API directory contract.

Live source-build verification on Next.js 16 exercised App Router, Pages
Router, and Edge routes, concurrent requests, and outbound calls. The Edge
route remained unmodified and returned successfully. Direct OTLP intake
received a 14-span distributed Node trace containing `web.request`,
`next.request`, `fetch`, TCP, and DNS spans.
