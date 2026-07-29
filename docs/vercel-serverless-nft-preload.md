# Vercel Next.js Native Preload

## Finding

Next.js `outputFileTracingIncludes` and Vercel's Next adapter already support
shipping `dd-trace` in each Node function. Vercel represents traced files in
`.vc-config.json.filePathMap`; they are uploaded from the project root and are
not expected to exist physically inside the local `.func` directory.

The failed prototype checked only physical function files and therefore
incorrectly reported that Vercel had dropped the NFT entries.

## Current Proven Flow

1. The app installs `dd-trace` and keeps it external to the Next bundle.
2. The app's Next configuration uses `outputFileTracingIncludes` to add the
   tracer and its runtime dependency closure to each server route.
3. `@vercel/next` reads each route NFT manifest and adds those files to the
   grouped function pseudo-layer.
4. Vercel serializes `FileFsRef` entries into `filePathMap` and uploads them
   with a prebuilt deployment.
5. A prototype post-build step adds
   `NODE_OPTIONS=--import=dd-trace/initialize.mjs` to each eligible Node
   function's `.vc-config.json`.
6. The tracer initializes before the Next server runtime, instruments the
   compiled Next modules, exports traces directly to Datadog, and flushes at
   the end of the request.

No custom tracer bundle, handler wrapper, OTel bridge, or physical post-build
copy is required.

## Customer-Committed Flow

For applications without Next Proxy or Middleware, the customer can use the
same mechanism today without mutating Vercel's build output:

1. Commit a small `datadog-preload.mjs` that imports
   `dd-trace/initialize.mjs` when `dd-trace` is available and otherwise exits
   cleanly.
2. Add the preload, `dd-trace`, and its runtime dependency closure to
   `outputFileTracingIncludes`.
3. Keep `dd-trace` external with `serverExternalPackages`.
4. Configure the Vercel project with
   `NODE_OPTIONS=--import=./datadog-preload.mjs`.

The conditional import is required because Vercel applies `NODE_OPTIONS` to
dependency installation before `dd-trace` exists. Once dependencies are
installed, the same preload initializes the tracer during the build and in
each Node route function.

This does not support Next Proxy or Middleware. Vercel applies the global
`NODE_OPTIONS` there too, but does not include the app-owned preload through
route-level `outputFileTracingIncludes`. The process then fails before the
conditional loader can run because `/var/task/datadog-preload.mjs` is absent.

## MVP Flow

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
