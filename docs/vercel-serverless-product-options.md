# Vercel Serverless Product Options

## Goal

Customers install `dd-trace`, enable Datadog APM, and deploy normally. Every
eligible Vercel Node function must contain the tracer, initialize it before
Next.js, and remain alive until agentless export completes.

## Option 1: Artifact Inside `dd-trace`

Publish the generated serverless preload as a `dd-trace` subpath with a
manifest. The Vercel adapter copies it into each Node function.

- Simplest customer dependency and versioning.
- Adds approximately 6.35 MB to the published package.

## Option 2: Separate Preload Package

Publish a versioned package such as `@datadog/node-serverless-preload`.

- Avoids increasing the normal `dd-trace` package.
- Adds package coordination and tracer-instance aliasing.
- Could serve Vercel, Netlify, and other serverless platforms.

## Option 3: Bounded Native Package Closure

Refactor `dd-trace` so Node File Trace can discover a bounded serverless
dependency closure without a generated bundle.

- Uses normal Node package semantics.
- Requires substantial tracer restructuring.
- Does not remove the need for adapter-owned inclusion and preload ordering.

## Option 4: Datadog Vercel Adapter

Ship artifact inclusion, function configuration, and lifecycle handling in a
Datadog adapter that wraps Vercel's Next adapter.

- Can ship without waiting for Vercel.
- Datadog owns compatibility with Vercel Build Output unless adapter
  composition becomes an official contract.

## Option 5: Official Vercel Preload Support

Vercel's official adapter accepts a generic function-local preload definition.
The Datadog integration supplies the artifact, supported runtimes, and
request-lifetime export callback.

- Cleanest and most stable customer experience.
- Requires Vercel engineering and product coordination.

## Option 6: Supported Finalizer

Package the current post-build mutation as a Datadog CLI step for prebuilt
deployments.

- Works with current Vercel Build Output.
- Remains coupled to generated output internals.
- Appropriate for preview or controlled CI, not final onboarding.

## Rejected Primary Approaches

- `outputFileTracingIncludes`: Next added `dd-trace` to route NFT manifests,
  but Vercel did not copy the files into generated functions.
- `instrumentation.js`: initializes too late for complete Node and compiled
  Next.js instrumentation.
- Global `NODE_OPTIONS`: fails when the preload is absent from a function.
- OTel bridge: useful fallback, but unnecessary when native preload works.
- Trace Drain: adds platform spans but does not provide native Datadog
  application instrumentation or all tracer products.

## Recommendation

1. Keep the artifact builder in `dd-trace` and produce a versioned manifest.
2. Publish the artifact initially as a `dd-trace` subpath.
3. Use the Datadog adapter or finalizer for a controlled preview.
4. Add official function-local preload and artifact inclusion to Vercel's
   adapter contract.
5. Replace the diagnostic launcher with supported request-lifetime flushing.
