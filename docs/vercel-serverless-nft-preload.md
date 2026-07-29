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
4. Set a conditional runtime `NODE_OPTIONS` import in `vercel.json`, with a
   clean build-time `NODE_OPTIONS`.
5. Configure agentless export and normal Datadog service tags.

No build mutation, custom launcher, copied tracer tree, hard-coded transitive
dependency list, trace drain, or custom Vercel adapter is required.

## Why Both Initialization Paths Exist

The `instrumentation.js` import gives Next output file tracing a real dependency
edge. Next's NFT manifest then discovers the exact `dd-trace` closure, and
Vercel merges that closure into generated Node functions.

The runtime `NODE_OPTIONS` import runs before the Vercel Next launcher. This is
what lets `dd-trace` wrap Next itself rather than only modules loaded later by
route code.

The instrumentation import packages the tracer. The preload establishes the
correct initialization order.

## Mixed Runtime Behavior

Vercel applies project runtime environment variables before both Node and Edge
handlers:

- Node functions contain the NFT-packaged tracer, so the conditional preload
  initializes it.
- Node Proxy or Middleware also contains the instrumentation NFT closure and
  starts successfully.
- Edge functions do not contain `dd-trace`, so the conditional preload skips
  initialization and the Edge handler starts normally.

The condition must execute from a self-contained `data:` import. A physical
application preload is absent from Proxy and Edge deployment functions, so
Node fails to resolve a file-based preload before that file can inspect the
runtime.

This preserves mixed-runtime applications. It does not add APM support for
Edge, where Node instrumentation APIs are unavailable.

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
Proxy, and an Edge route:

- `/api/ping`, `/api/flow`, `/proxy-check`, and `/api/edge` all returned 200.
- Edge skipped Datadog initialization instead of failing startup.
- Node route traces exported directly to Datadog.
- Trace `2378948595391565956` contained:

```text
web.request  GET /api/flow
  next.request  GET /api/flow
    http.request  GET
      web.request  GET /api/ping
        next.request  GET /api/ping
          http.request  GET
            tcp.connect  example.com:443
              dns.lookup  example.com
```

Every displayed parent ID was present in the same trace, route resources were
normalized, and the trace had a real root span.

## Production Direction

The customer-side conditional import is viable today, but it is not the ideal
onboarding surface.

The preferred Vercel integration is:

1. The Datadog integration enables APM for a project.
2. Vercel's official Next adapter detects that configuration.
3. The adapter keeps `dd-trace` external and includes the instrumentation NFT
   closure in each eligible Node function.
4. The adapter merges `--import=dd-trace/initialize.mjs` into each Node
   function's `NODE_OPTIONS`.
5. The adapter omits the preload from Edge functions.
6. Datadog injects secrets through supported Vercel integration settings.

That removes `vercel.json` and `NODE_OPTIONS` management from the customer
without depending on private Vercel output formats or tracer internals.

## Remaining Work

1. Review and productize the tracer's agentless mode, flush semantics, and
   safe logging.
2. Add live Vercel acceptance coverage for App Router, Pages API,
   route-to-route propagation, concurrency, Proxy, and mixed Edge projects.
3. Confirm supported Next.js version ranges rather than pinning one sample
   version.
4. Implement the official Vercel adapter/integration handoff for per-function
   preload configuration.
5. Define Edge telemetry separately through supported Vercel or OpenTelemetry
   ingestion; do not load the Node tracer into Edge.

## Rejected Approaches

- Route-local `dd-trace` initialization: too late to instrument Next.
- `serverExternalPackages` alone: does not create a dependency edge.
- Manual tracer or transitive dependency lists: brittle and unnecessary.
- Post-build mutation or custom function launchers: coupled to private output.
- Physical project preload with global `NODE_OPTIONS`: fails when that file is
  absent from Proxy or Edge functions.
- Vercel trace drain as a requirement: adds a separate paid data path and is
  not needed for native Node spans.
