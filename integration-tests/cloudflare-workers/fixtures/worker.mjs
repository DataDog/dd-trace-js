// Relative import resolves to this repo's own build (not an npm-published
// version), so the test exercises the local dd-trace loading under workerd.
import tracer from '../../../index.js'

// workerd forbids most I/O (including dd-trace's init-time file reads and
// logging/telemetry pipeline) outside of a request handler, so tracer.init()
// cannot run at module scope here — it must run on first request, inside
// fetch().
let initialized = false

export default {
  async fetch (request, env, ctx) {
    if (!initialized) {
      tracer.init() // reads process.env, populated from wrangler.jsonc "vars"
      initialized = true
    }

    const { pathname } = new URL(request.url)

    if (pathname === '/parented') {
      // Manual parenting via tracer.trace(): scope.js falls back to a storage.run()-scoped
      // activation on workerd, since workerd's AsyncLocalStorage has no imperative enterWith()
      // (see datadog-core/src/storage.js and scope.js). The child span is created while the
      // parent is the active span, so it must come back with the parent as its parent.
      tracer.trace('cf.parent', () => {
        tracer.trace('cf.child', () => {})
      })
    } else {
      // A flat span: automatic plugin instrumentation is unsupported in workerd (it imperatively
      // calls enterWith() with no bounding callback, which scope.js's fallback can't emulate).
      const span = tracer.startSpan('cf.worker.test')
      span.setTag('http.method', request.method)
      span.setTag('deploy.target', 'cloudflare-workers')
      span.finish()
    }

    // span.finish() fires the OTLP export as fire-and-forget async I/O (an
    // http.request() call), and dd-trace exposes no awaitable flush yet, so
    // hold the isolate open long enough for that request to leave. A localhost
    // POST clears in well under this margin; the generous value just guards
    // against CI load (the test resolves on receipt, not on this timer).
    ctx.waitUntil(new Promise((resolve) => setTimeout(resolve, 8000)))

    return new Response('ok\n')
  },
}
