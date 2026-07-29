# Vercel Next Builder Prototype

Vercel may deploy Next.js applications as a mix of Node and Edge functions.
`dd-trace` must load before Next in each Node function, while Edge functions
must not attempt to load the Node tracer.

The prototype in [`examples/vercel-nextjs`](./examples/vercel-nextjs/README.md)
delegates to `@vercel/next.build()`. When the official Builder returns a public
Build Output API directory, it visits Node `.func` outputs, writes a launcher
that initializes `dd-trace`, and changes only the function's public
`.vc-config.json` handler. It preserves Edge output and does not use global
`NODE_OPTIONS`, trace drain, Vercel private file maps, source mapping, debug
logging, or customer secrets.

The target package name is `@datadog/vercel-next-builder`. It cannot be
legitimately added as a new package to this repository without release
ownership: the current release workflow publishes only the root `dd-trace`
package, and the existing Next plugin is source code included in that package.
The prototype intentionally does not support older returned Lambda output,
because this slice has evidence only for the current public Build Output API
directory contract. A future Builder package may add that compatibility path
after it has a versioned Vercel contract and tests.

Before release, validate source-build Preview and Production deployments with
Node routes, mixed Edge routes, concurrent requests, and trace delivery. This
slice verifies the local public Build Output transformation only.
