# Vercel Next.js Native `dd-trace` Preload

## Scope

This document describes how to initialize `dd-trace` before Next.js inside
Vercel Node functions without replacing the Next launcher, generating a custom
tracer bundle, or wrapping each route handler.

The current customer-committed flow is proven for Next.js Node route
functions. It does not support Next Proxy, Middleware, or the Edge runtime.

## Customer Flow At A Glance

1. Install the supported `dd-trace` version as a production dependency.
2. Commit `datadog-preload.mjs` at the application root.
3. Configure Next.js output file tracing to reference the installed preload
   and `dd-trace` package. Vercel packages those files automatically; the
   customer does not copy or vendor tracer runtime files.
4. Set `NODE_OPTIONS=--import=./datadog-preload.mjs` and the Datadog
   environment variables in the Vercel project.
5. Deploy through the normal Vercel Git or CLI workflow.
6. Each Node function starts the tracer before Next.js, records native Next and
   downstream spans, and sends them directly to Datadog at request completion.

This setup currently requires the tracer changes on
`conti/vercel-native-preload-clean`. It is not a released customer workflow
until those changes and a supported agentless configuration are published.

## What "Bundling" Means

The tracer is not compiled into each route's JavaScript bundle. The deployment
uses file tracing and function packaging:

| Component | Responsibility |
| --- | --- |
| Next.js build | Compiles the application and runs Node File Trace (NFT) for each server entry point. |
| `@vercel/nft` | Produces `.nft.json` manifests listing files needed at runtime. |
| `outputFileTracingIncludes` | Adds files that static tracing would otherwise omit. |
| `serverExternalPackages` | Keeps `dd-trace` as a runtime package instead of compiling it into Next output. |
| Vercel's Next adapter | Reads the NFT manifests and adds their files to each generated function's `filePathMap`. |
| Vercel deployment | Uploads the mapped files with each function. |
| Node `NODE_OPTIONS` | Imports the Datadog preload before the Next function launcher runs. |

The complete path is:

```text
next build
  -> route JavaScript and route.nft.json
  -> @vercel/next reads route.nft.json
  -> traced files become function filePathMap entries
  -> Vercel uploads the function and mapped files
  -> Node imports datadog-preload.mjs
  -> datadog-preload.mjs imports dd-trace/initialize.mjs
  -> the Vercel Next launcher loads with instrumentation active
```

Files represented by `filePathMap` do not need to appear as physical copies in
the local `.vercel/output/functions/<name>.func` directory. The Vercel adapter
can reference their original project paths and upload them later.

## Customer Setup

### 1. Install the tracer

```bash
npm install dd-trace
```

`dd-trace` must be a production dependency, not a development dependency,
because every deployed Node function needs it at runtime.

### 2. Commit the conditional preload

Copy the
[`conditional preload`](./examples/vercel-nextjs/datadog-preload.mjs) to
`datadog-preload.mjs` in the application root.

The loader first checks whether `dd-trace` is installed. Vercel applies the
project's `NODE_OPTIONS` during dependency installation, when the package is
not available yet. The loader exits cleanly only in that case. Once `dd-trace`
can be resolved, initialization failures are deliberately not suppressed.

### 3. Configure Next.js file tracing

Add the following to `next.config.js`:

```js
/** @type {import('next').NextConfig} */
module.exports = {
  serverExternalPackages: ['dd-trace'],
  outputFileTracingIncludes: {
    '/*': [
      './datadog-preload.mjs',
      './node_modules/dd-trace/**/*',
      './node_modules/dc-polyfill/**/*',
      './node_modules/import-in-the-middle/**/*',
      './node_modules/require-in-the-middle/**/*',
      './node_modules/module-details-from-path/**/*',
      './node_modules/cjs-module-lexer/**/*',
      './node_modules/es-module-lexer/**/*',
      './node_modules/opentracing/**/*',
    ],
  },
}
```

Merge these values with existing `serverExternalPackages` and
`outputFileTracingIncludes` configuration instead of replacing application
settings.

The explicit dependency list is the closure verified by the prototype tracer
package. The paths reference packages already installed in `node_modules`;
customers do not add those files to their repository.

This version-sensitive list is acceptable only for the current validation
setup. A production Datadog integration or package-owned helper must configure
the tracer's file-tracing closure automatically so customers do not maintain
Datadog dependency paths when `dd-trace` changes.

### 4. Configure the Vercel project

Set:

```text
NODE_OPTIONS=--import=./datadog-preload.mjs
_DD_APM_TRACING_AGENTLESS_ENABLED=true
DD_API_KEY=<stored as a Vercel sensitive environment variable>
DD_SITE=datadoghq.com
DD_SERVICE=<service name>
DD_ENV=<environment name>
```

`_DD_APM_TRACING_AGENTLESS_ENABLED` is experimental on this branch and is not
yet a released customer contract. It sends spans directly to Datadog because a
Datadog Agent is not available in the Vercel function.

Do not enable tracer debug logging in production. The API key must never be
printed, committed, placed in `next.config.js`, or exposed to browser code.

### 5. Deploy normally

No custom build command or prebuilt deployment is required for the
customer-committed flow. Vercel runs the normal install and Next.js build.

## Build And Runtime Behavior

The global `NODE_OPTIONS` affects several Vercel phases:

1. During dependency installation, the preload exists but `dd-trace` does not.
   The conditional loader skips initialization.
2. During `next build`, dependencies exist and the tracer initializes. This can
   create build-process telemetry unless separately filtered.
3. During a Node function invocation, Vercel starts the function with the same
   preload. The tracer initializes before the Next launcher and can patch Next
   and other supported libraries.
4. At request completion, the tracer registers its export flush through the
   Vercel request lifetime so the process is not frozen before agentless intake
   completes.

The preload must run before Next loads. Importing `dd-trace` from
`instrumentation.js`, a route file, or a handler is too late for reliable
module wrapping when Vercel has already instantiated the relevant Next
runtime.

## Generated Artifacts

After `next build`, each Node route has an NFT manifest similar to:

```text
.next/server/app/api/example/route.js.nft.json
```

That manifest should contain:

- `datadog-preload.mjs`;
- `dd-trace/initialize.mjs`;
- the tracer runtime;
- the external packages required by the tracer.

When using `vercel build`, the Vercel adapter produces function configuration
under:

```text
.vercel/output/functions/*.func/.vc-config.json
```

The relevant files appear in `filePathMap`. Their absence as physical files
inside the `.func` directory is not evidence that they were omitted.

## Verification

Build the application and inspect at least one route manifest:

```bash
npm run build
find .next/server -name '*.nft.json'
```

For a Vercel prebuild, inspect the generated mappings:

```bash
find .vercel/output/functions -name '.vc-config.json'
```

Runtime verification must inspect emitted telemetry, not only build output.
Exercise:

- one Node route;
- a route that calls another route with distributed propagation;
- concurrent requests;
- at least one instrumented downstream library.

Expected trace shape for the verified flow:

```text
web.request  GET /api/flow
  next.request  GET /api/flow
    http.request  GET
      web.request  GET /api/ping
        next.request  GET /api/ping
          http.request  GET
            tcp.connect
              dns.lookup
```

Backend indexing is asynchronous. The burst verification for this prototype
became complete after a delay rather than immediately after requests finished.

## Runtime Support

| Runtime or entry point | Result |
| --- | --- |
| Next App Router Node route handlers | Verified |
| Nested request from one Node route to another | Verified |
| Node HTTP, DNS, and TCP instrumentation | Verified |
| Concurrent Node route requests | Verified |
| Pages Router and Pages API on the Node runtime | Uses the same packaging path; requires a dedicated deployment check before claiming release support |
| Next Proxy or Middleware | Not supported by the customer-committed flow |
| Vercel Edge runtime | Not supported by `dd-trace`; Node preload APIs are unavailable |

## Proxy And Middleware Limitation

Vercel applies the project-level `NODE_OPTIONS` to Proxy or Middleware, but
route-level `outputFileTracingIncludes` does not place the application-owned
preload into that function. Node then tries to import
`/var/task/datadog-preload.mjs` before application code runs and fails with
`MIDDLEWARE_INVOCATION_FAILED`.

The loader cannot conditionally recover from this case because Node cannot load
the loader itself. A universal solution must apply the preload per generated
Node function and skip Proxy, Middleware, and Edge functions.

## Required Tracer Changes

The customer setup only handles early loading and function packaging. The
tracer must provide the following runtime behavior:

1. **Correct agentless export.** Send spans to the APM agentless intake with
   nanosecond start times and durations, preserved trace and parent IDs, and
   correct root and top-level markers.
2. **Real flush completion.** A flush callback must wait for intake requests
   already in flight. Vercel uses an immediate flush interval because an
   invocation can be frozen before a periodic timer runs.
3. **Vercel request-lifetime flush.** Register the export promise through
   Vercel or Next's active `waitUntil` request context when a Next request span
   finishes.
4. **Native modern Next.js hooks.** Instrument the precompiled App Route,
   Pages API, and App Page runtime modules used by Next 15.4 and later. The
   older Next hooks are bypassed by these runtimes.
5. **Stable route names and parenting.** Reuse an existing Next request span
   instead of creating duplicates, extract distributed context from web
   `Headers` objects, and apply the normalized `METHOD /route` resource to both
   the Next span and its HTTP parent.
6. **Credential-safe diagnostics.** Agentless request logs must contain only
   bounded endpoint and request metadata. They must never serialize headers or
   the Datadog API key.

These changes are implemented on this branch by:

- `bd081843d` for agentless encoding, intake, safe logging, and flush
  completion;
- `e2a7942fb` for modern Next runtime hooks, propagation, route naming, and
  Vercel request-lifetime flushing.

No OTel bridge, generated tracer bundle, handler wrapper, or custom Next
launcher is required by this flow.

## Productized MVP

The first supported version can package the proven build behavior in the
Datadog Vercel integration or a Datadog build adapter:

1. The customer installs `dd-trace` and enables Datadog APM for the project.
2. The integration composes with the official Next adapter; it does not replace
   the Next build or launcher.
3. It adds the tracer closure to Next file tracing and applies the preload to
   every generated Node function configuration.
4. Vercel deploys the normal functions, and the tracer handles native Next
   instrumentation, agentless export, and request-lifetime flushing.

The customer should not maintain a wrapper, generated tracer artifact, or
post-build mutation script. Until Vercel exposes preload propagation upstream,
the integration owns the small build-output configuration step.

## Ideal Production Flow

The Datadog integration should reduce onboarding to enabling APM and providing
Datadog configuration:

1. The integration ensures `dd-trace` is a project dependency and declares its
   runtime files for tracing.
2. Vercel natively propagates the configured Datadog preload to every generated
   Node function.
3. Vercel excludes Edge runtime and proxy functions, where the Node preload
   cannot run.
4. The official Next launcher starts unchanged, with `dd-trace` initialized
   before Next loads.

This removes deployment-output mutation from Datadog code and makes the preload
behavior a stable Vercel platform contract.

## Upstream Vercel Improvement

Vercel can make this substantially simpler by supporting a project or
integration-provided Node preload and copying it into the `NODE_OPTIONS` of
every generated Node function. This must happen after function grouping and
configuration generation so it covers App Routes, Pages Routes, API routes,
and other Node server functions without requiring Datadog to discover them.

The upstream contract should:

- merge with existing `NODE_OPTIONS` instead of replacing it;
- apply only when the preload module is present in that function's traced
  files;
- skip Edge runtime and proxy functions;
- preserve the setting in both normal and prebuilt deployments;
- expose enough build diagnostics to confirm which functions received it.

## Evidence

- Next 16.2.10 wrote 1,015 `dd-trace` entries into the App Route NFT.
- All four physical Node function groups contained all required preload files
  in `filePathMap`; the Next proxy was left unchanged.
- Deployment `dpl_3viYPGSiqanBEbDXcWhZQkkwnLKx` used the unmodified Next
  launcher plus function-local `NODE_OPTIONS`.
- Trace `5043974407832829254` contains routed native spans:
  `web.request -> next.request -> http.request -> web.request -> next.request`,
  including two parallel downstream calls and their DNS/TCP children.
- Project `conti-next-conditional-loader` verified the customer-committed flow
  on Next 16.2.10. The install phase skipped the unavailable tracer, normal
  routes returned successfully, and no build-output mutation was used.
- Trace `1427389653325595070` contains the complete distributed route:
  `GET /api/flow -> GET /api/ping -> example.com`, including native
  `next.request`, HTTP, DNS, and TCP spans with coherent parent IDs.
- A concurrent exercise produced 47 indexed spans across 12 traces, including
  complete flow and ping traces. This confirms request-lifetime flushing under
  burst traffic after allowing for backend indexing delay.
- The same deployment reproduced the Proxy limitation as
  `MIDDLEWARE_INVOCATION_FAILED`: Node could not import the app-owned preload
  from `/var/task` because it was absent from the Proxy function.
- Deployment `dpl_8WczWwtcQVt2v5t91QrRgYMHn6rr` used the exact conditional
  preload committed with this document. Trace `6105856971091232747` contains
  the correctly parented `GET /api/flow -> GET /api/ping` route tree.

## Product Work

Until the upstream preload contract exists, the Vercel integration or an
official Datadog adapter must automate two build-time actions:

- add the tracer runtime dependency closure to Next file tracing;
- add the preload to every Node function configuration while skipping Edge
  and proxy functions.

The tracer changes on `conti/vercel-native-preload-clean` provide agentless
intake correctness, request-lifetime flushing, and compiled Next runtime
instrumentation. Sample apps, generated output, and deployment mutations are
not part of the branch.
