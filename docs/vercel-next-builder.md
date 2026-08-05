# Vercel Next Builder Prototype

Vercel may deploy Next.js applications as a mix of Node and Edge functions.
`dd-trace` must load before Next in each Node function, while Edge functions
must not attempt to load the Node tracer.

The prototype in [`examples/vercel-nextjs`](./examples/vercel-nextjs/README.md)
adds `dd-trace` to the build input's production dependencies and creates the
standard `instrumentation.ts` entrypoint before calling `@vercel/next.build()`.
Next invokes its `register()` hook before requests and performs its normal
output-file tracing. The generated hook makes the external tracer visible to
that tracing pass, and skips Edge initialization. After that build, the Builder
prepends `--import=dd-trace/initialize.mjs` to each Node function's local
`NODE_OPTIONS`; the preload provides initialization before Next. It does not
copy tracer files or change handlers.
Next.js already lists `dd-trace` as a server external, so it stays outside
function source bundles. NFT's per-function closure provides the corresponding
runtime files; no post-build external-dependency configuration is needed.
If the project already has a root or `src/instrumentation.*` file, the Builder
fails without changing it rather than attempting to compose customer code.
Frozen installs (`npm ci`, `yarn --frozen-lockfile`, or immutable installs)
must already declare `dd-trace` as a production dependency with an updated
lockfile; the Builder fails before invoking an incompatible command.
The Datadog integration configures direct OTLP intake for traces, logs, and
metrics independently of the Builder's packaging work.

The target package name is `@datadog/vercel-next-builder`. It must declare
`@vercel/next`, `@vercel/build-utils`, and a supported `dd-trace` version as
dependencies. It cannot be legitimately added as a published package to this
repository without release ownership because the current release workflow
publishes only the root `dd-trace` package. The prototype intentionally supports
only the current public Build Output API directory contract.
