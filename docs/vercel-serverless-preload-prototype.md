# Vercel Serverless Preload Prototype

## Finding

Vercel emits isolated function bundles for a Next.js application. A package
dependency or `NODE_OPTIONS` value does not guarantee that `dd-trace` is
present in each function. Next.js `outputFileTracingIncludes` added the tracer
to route NFT manifests, but Vercel did not copy those files into Build Output.

## Proven Shape

`scripts/build-serverless-preload.js` bundles the tracer initializer and ESM
loader with the existing Datadog esbuild plugin. It emits a bounded artifact,
an import-in-the-middle runtime helper, a `dd-trace` facade, and a manifest.

The deployed prototype was approximately 6.35 MB per physical function. It
restored early initialization for Next.js 16.2.10 and produced routed
`web.request -> next.request` traces for App Router and Pages Router, including
complete distributed flow and parallel traces with no missing parents.

## Product Boundary

The artifact builder can ship with `dd-trace`, but an adapter still must:

- include the artifact in every eligible Node function;
- configure `NODE_OPTIONS` before the generated handler loads;
- keep the request alive until agentless export completes;
- skip Edge and proxy functions.

The post-build finalizer and diagnostic handler wrapper used for validation are
not production contracts. The preferred integration is an official Vercel
function-preload capability consuming the generated manifest.

Redis and Postgres positive spans still need reachable services. AI SDK v7
coverage is separate integration functionality.
