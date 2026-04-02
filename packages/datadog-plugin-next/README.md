# datadog-plugin-next

Datadog APM plugin for Next.js. Provides automatic HTTP request tracing and explicit helpers for Server Actions, error handling, and RUM↔APM trace correlation.

## Setup

### 1. Install and initialize dd-trace

```bash
npm install dd-trace
```

### 2. Create `instrumentation.ts`

```ts
// instrumentation.ts
import { datadogOnRequestError } from 'dd-trace/next'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'edge') return

  const ddTrace = await import(/* webpackIgnore: true */ 'dd-trace')
  const tracer = ddTrace.default ?? ddTrace
  tracer.init({ service: 'my-nextjs-app' })
}

export const onRequestError = datadogOnRequestError
```

### 3. Configure `next.config.js`

```js
/** @type {import('next').NextConfig} */
module.exports = {
  serverExternalPackages: ['dd-trace'],
}
```

## Features

### Automatic HTTP Tracing

The plugin automatically instruments Next.js HTTP request handling — page renders, API routes, and static assets are traced without any code changes.

### Server Action Tracing

Wrap Server Actions with `withDatadogServerAction` to create named spans in APM:

```ts
// app/actions.ts
'use server'
import { withDatadogServerAction } from 'dd-trace/next'

export async function submitForm(formData: FormData) {
  return withDatadogServerAction('submitForm', async () => {
    // your action logic
    return { success: true }
  })
}
```

This creates a child span under the HTTP span:
```
POST /my-page              (HTTP span — auto-instrumented)
  └── submitForm           (Server Action span)
```

### RUM↔APM Trace Correlation

Use `getDatadogTraceMetadata` in your root layout's `generateMetadata` to inject trace IDs into the page. The Datadog RUM SDK reads these to link browser sessions with server traces.

```ts
// app/layout.tsx
import { getDatadogTraceMetadata } from 'dd-trace/next'
import type { Metadata } from 'next'

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: 'My App',
    ...getDatadogTraceMetadata(),
  }
}
```

This renders `<meta name="dd-trace-id">` and `<meta name="dd-trace-time">` tags that the RUM SDK picks up on page load.

### Error Handling

The `datadogOnRequestError` handler creates error spans with route context, error details, and RUM session correlation. Wire it up in `instrumentation.ts` as shown in the setup section.

Captured tags:
- `nextjs.router_kind` — `'app'` or `'pages'`
- `nextjs.route_path` — e.g., `/user/[id]`
- `nextjs.route_type` — `'page'`, `'route'`, `'action'`
- `nextjs.render_source` — rendering phase that errored
- `nextjs.error_digest` — Next.js error digest
- `rum.session_id` — RUM session ID from `_dd_s` cookie (for client↔server correlation)

## API Reference

### `withDatadogServerAction(actionName, action)`

Wraps a Server Action with a named APM span.

| Parameter | Type | Description |
|-----------|------|-------------|
| `actionName` | `string` | Name shown in the APM trace |
| `action` | `() => Promise<T>` | The Server Action function to wrap |

Returns: `Promise<T>`

### `getDatadogTraceMetadata()`

Returns a Next.js `Metadata`-compatible object with trace correlation meta tags.

Returns: `{ other: { 'dd-trace-id': string, 'dd-trace-time': string } }` or `{}` if no active trace.

### `datadogOnRequestError(error, request, context)`

Next.js `onRequestError` hook handler. Creates an error span with full route context.

## Client-Side RUM

For client-side Real User Monitoring (view tracking, RSC fetch labeling, error collection), use [`@datadog/browser-rum-nextjs`](https://github.com/DataDog/browser-sdk/tree/main/packages/rum-nextjs).
