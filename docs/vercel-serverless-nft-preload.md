# Native Datadog Tracing For Next.js On Vercel

## Problem

Vercel builds a Next.js application into separate deployment functions. Each
function has its own launcher, files, dependencies, runtime, and environment.
Loading `dd-trace` from route code is too late because Next.js has already
loaded the modules that the tracer needs to instrument.

The tracer also cannot send to a local Datadog Agent on Vercel. It needs
bounded agentless export and a request-lifetime flush.

## Current MVP

The tested customer setup is documented in
[`docs/examples/vercel-nextjs`](./examples/vercel-nextjs/README.md):

1. Install `dd-trace` as a production dependency.
2. Import `dd-trace/initialize.mjs` from Next `instrumentation.js` for the
   Node runtime.
3. Add `dd-trace` to `serverExternalPackages`.
4. Set the runtime `NODE_OPTIONS` import in `vercel.json`, with a clean
   build-time `NODE_OPTIONS`.
5. Configure agentless export and normal Datadog service tags.

For Node-only projects, the project-level preload is a working MVP. It remains
a broad override: every generated function must contain the tracer. Mixed Node
and Edge projects need the Datadog Builder described below.

## Why Both Initialization Paths Exist

The `instrumentation.js` import gives Next output file tracing a real dependency
edge. Next's NFT manifest then discovers the exact `dd-trace` closure, and
Vercel merges that closure into generated Node functions.

The runtime `NODE_OPTIONS` import runs before the Vercel Next launcher. This is
what lets `dd-trace` wrap Next itself rather than only modules loaded later by
route code.

The instrumentation import packages the tracer. The preload establishes the
correct initialization order.

## Edge Runtime Boundary

Next.js supports selecting Node or Edge per route, so one Vercel project can
legitimately deploy both kinds of function. Node is the default and Vercel
recommends it for most workloads, but mixed projects remain a supported
compatibility case that the Datadog integration must not break.

Vercel applies project runtime environment variables before both Node and Edge
handlers. Node functions contain the NFT-packaged tracer, but Edge functions
do not. A project-global `--import=dd-trace/initialize.mjs` therefore fails an
Edge function before application code can check `NEXT_RUNTIME`.

There is no clean application-side conditional around that resolution step.
Mixed Node and Edge projects need a Datadog-owned Vercel Builder to wrap only
generated Node function handlers. This belongs at the public Build Output API
boundary, not in customer route code, project-global `NODE_OPTIONS`, or an
encoded loader.

## Required Tracer Changes

The branch contains two focused tracer capabilities:

### Agentless Vercel Export

- Select agentless trace intake only when explicitly enabled.
- Accept `DD_API_KEY` and normal Datadog site configuration.
- retain spans until a request-completion flush;
- serialize complete distributed traces without reordering their start times;
- redact request headers and credentials from all diagnostic logging.

The opt-in configuration remains experimental and needs a supported public
name and security review.

### Next.js Request Lifecycle

- Recognize Vercel Next Node functions.
- Create route-named root `web.request` and child `next.request` spans.
- Preserve distributed context for route-to-route requests.
- Flush at request completion so short-lived function execution does not lose
  traces.
- Preserve downstream HTTP, TCP, DNS, database, and AI integration spans.

## Verified Output

Validated on Vercel with Next.js 16.2.10 using App Router Node routes, a Node
Proxy, and an Edge route.

- The customer-global preload validated `/api/ping`, `/api/flow`, and
  `/proxy-check`, but failed Edge before application code.
- Copying a loader into an Edge `.func` did not work because Vercel bundles
  Edge source and does not expose the extra file to the Node host preload.
- A Datadog Builder delegated to `@vercel/next`, wrapped only generated Node
  handlers in the returned Build Output API directory, and left Edge unchanged.
- `/api/ping`, `/api/flow`, `/proxy-check`, and `/api/edge` then returned 200.
- Node route traces exported directly to Datadog.
- Edge started without initializing `dd-trace`.
- Clean source deployment `dpl_GCTbVjHZj5cC9ymCVyaRLqGXp4kE` required no
  customer prebuild and instrumented 11 Node function bundles.
- Trace `1764132629899357976` contained:

```text
next.request  GET /api/flow
  http.request  GET
    next.request  GET /api/ping
      http.request  GET
    tcp.connect  conti-next-conditional-loader.vercel.app:443
      dns.lookup  conti-next-conditional-loader.vercel.app
```

Every displayed parent ID was present in the same trace, route resources were
normalized, and the trace had a real root span.

## Production Direction

The preferred Vercel integration is a Datadog-owned Builder:

1. The Datadog integration enables APM for a project.
2. Vercel invokes the Datadog Builder instead of the default Next Builder.
3. The Datadog Builder calls the published `@vercel/next.build()` implementation.
4. It preserves all official output, routes, caching, and framework behavior.
5. On Next 16 cloud builds, it receives `buildOutputPath`, adds a small CommonJS
   wrapper to each Node `.func`, and changes only that function's public
   `.vc-config.json` handler.
6. On local or older Builder output, it performs the equivalent change to each
   returned `NodejsLambda`.
7. It leaves Edge functions unchanged.
8. Next instrumentation NFT supplies the tracer dependency closure.
9. Datadog injects secrets through the existing Vercel integration settings.

`@vercel/next` exposes `build()` and Next 16 returns its public
`buildOutputPath`. The wrapper modifies the documented Build Output API handler
contract before deployment. It does not patch Vercel source, mutate a customer's
prebuilt `.vercel/output`, depend on private file maps, use project-level
`NODE_OPTIONS`, or require trace-drain cooperation. The verified prototype is
[`docs/examples/vercel-nextjs/builder.js`](./examples/vercel-nextjs/builder.js).

Vercel's `builds[].use` can register an npm Builder, although `builds` is a
legacy configuration surface. The Datadog integration should own this
configuration so customers do not maintain it manually.

## Remaining Work

1. Review and productize the tracer's agentless mode, flush semantics, and
   safe logging.
2. Add live Vercel acceptance coverage for App Router, Pages API,
   route-to-route propagation, concurrency, Proxy, and mixed Edge projects.
3. Confirm supported Next.js version ranges rather than pinning one sample
   version.
4. Publish the Datadog Builder wrapper around `@vercel/next`, then validate
   Git-connected Preview and Production deployments.
5. Define Edge telemetry separately through supported Vercel or OpenTelemetry
   ingestion; do not load the Node tracer into Edge.

## Rejected Approaches

- Route-local `dd-trace` initialization: too late to instrument Next.
- `serverExternalPackages` alone: does not create a dependency edge.
- Manual tracer or transitive dependency lists: brittle and unnecessary.
- Customer-run post-build mutation: requires prebuilt deployments.
- Encoded `data:` preload: can skip missing packages, but is opaque and not an
  acceptable customer configuration.
- Copying a preload into an Edge `.func`: the Edge compiler does not preserve
  it as a host filesystem file for `NODE_OPTIONS`.
- Project-global package preload in mixed Edge projects: Edge does not contain
  the Node tracer and fails before application code can inspect the runtime.
- A Vercel upstream patch: not required; the Datadog Builder can transform the
  public Lambda objects returned by `@vercel/next.build()`.
- Vercel trace drain as a requirement: adds a separate paid data path and is
  not needed for native Node spans.
