# Datadog APM For Next.js On Vercel

This setup initializes `dd-trace` before Next.js in deployed Node functions,
lets Next package the tracer dependency closure, and exports traces directly to
Datadog without a trace drain or Datadog Agent.

It has been validated with Next.js 16 App Router routes and a Node Proxy.
`dd-trace` does not support the Edge runtime.

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

## 4. Preload Before Next

Merge [`vercel.json`](./vercel.json) into the project configuration. Its
runtime `NODE_OPTIONS` initializes `dd-trace` before Vercel's Next launcher.
`build.env.NODE_OPTIONS` prevents the runtime preload from affecting dependency
installation and the build.

Remove any project-level `NODE_OPTIONS` tracing value from the Vercel dashboard
so there is one source of truth. If the application already uses
`NODE_OPTIONS`, preserve those options in the corresponding runtime and build
values.

Do not use this project-global preload in an application containing an Edge
route. Vercel applies the option before the Edge handler starts, but Edge
functions do not contain the Node tracer. Supporting mixed Node and Edge
projects requires Vercel's adapter to apply the preload only to generated Node
functions. An application-side runtime check cannot run before Node resolves
the preload itself.

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

```bash
npm run build
npx vercel@latest deploy --prod
```

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
web.request  GET /api/flow
  next.request  GET /api/flow
    http.request
      web.request  GET /api/ping
        next.request  GET /api/ping
          downstream integration spans
```

Completion requires successful routes, route-named roots, correctly parented
Next and downstream spans, complete concurrent traces, and no credentials or
serialized request headers in Vercel logs.
