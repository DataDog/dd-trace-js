# Datadog APM For Next.js On Vercel

This setup initializes `dd-trace` before Next.js in deployed Node functions,
lets Next package the tracer dependency closure, and exports traces directly to
Datadog without a trace drain or Datadog Agent.

It has been validated with Next.js 16 App Router routes, a Node Proxy, and an
Edge route deployed in the same project. `dd-trace` instruments Node functions
and leaves Edge functions unchanged.

## 1. Install

```bash
npm install --save dd-trace
```

`dd-trace` must be a production dependency.

## 2. Register Instrumentation

Add [`instrumentation.js`](./instrumentation.js) to the application root. If
one already exists, merge the import into its `register` function:

```js
export async function register () {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('dd-trace/initialize.mjs')
  }
}
```

This is both a standard Next.js instrumentation hook and the dependency edge
used by Next output file tracing. Next automatically packages the tracer and
its actual runtime dependencies into each Node function.

## 3. Keep The Tracer External

Merge this into `next.config.js`:

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['dd-trace'],
}

module.exports = nextConfig
```

Preserve existing `serverExternalPackages` entries. Do not list individual
`dd-trace` files or transitive packages.

## 4. Configure The Datadog Builder

Merge [`vercel.json`](./vercel.json) into the project configuration:

```json
{
  "version": 2,
  "builds": [
    {
      "src": "package.json",
      "use": "@datadog/vercel-next-builder"
    }
  ]
}
```

The Datadog Builder delegates to Vercel's `@vercel/next` Builder. After Next
produces its public Build Output API directory, it adds a small initialization
wrapper only to Node function handlers. Edge functions and all other outputs
remain unchanged.

This is configure-once behavior in Vercel's normal cloud source-build path. Do
not run `vercel build` or deploy `--prebuilt`. Remove any project-level tracing
`NODE_OPTIONS`.

`@datadog/vercel-next-builder` is the intended package name. The verified
prototype is included as [`builder.js`](./builder.js), but the package must be
published before this setup is customer-ready.

## 5. Configure Datadog

Link the repository to its Vercel project:

```bash
npx vercel@latest link
```

Set Production and Preview values:

```bash
npx vercel@latest env add _DD_APM_TRACING_AGENTLESS_ENABLED production,preview \
  --value='true' --sensitive --yes --force
npx vercel@latest env add DD_SITE production,preview \
  --value='datadoghq.com' --sensitive --yes --force
npx vercel@latest env add DD_SERVICE production,preview \
  --value='<service-name>' --sensitive --yes --force
npx vercel@latest env add DD_ENV production,preview \
  --value='<environment-name>' --sensitive --yes --force
```

Add the API key interactively:

```bash
npx vercel@latest env add DD_API_KEY production,preview --sensitive
```

Never print, commit, or pass the API key with `--value`. Keep
`DD_TRACE_DEBUG` disabled in production.

`_DD_APM_TRACING_AGENTLESS_ENABLED` is experimental on this branch and must
become a supported public configuration before release.

## 6. Deploy And Verify

The verified flow uses a manual source deployment:

```bash
npx vercel@latest deploy --prod
```

Git-connected Preview and Production deployment validation remains a release
requirement for the Builder package.

Exercise real Node routes, including one that calls another route:

```bash
curl -fsS 'https://<production-domain>/<node-route>'
```

In Datadog APM Trace Explorer, query:

```text
service:<service-name> env:<environment-name>
```

Expected route-to-route shape:

```text
next.request  GET /api/flow
  http.request
    next.request  GET /api/ping
      downstream integration spans
```

Completion requires successful routes, route-named roots, correctly parented
Next and downstream spans, complete concurrent traces, and no credentials or
serialized request headers in Vercel logs.
