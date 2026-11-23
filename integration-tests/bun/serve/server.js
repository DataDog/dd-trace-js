'use strict'

const tracer = require('dd-trace').init({ startupLogs: false, flushInterval: 10 })
const assert = require('node:assert/strict')

tracer.use('http', {
  server: {
    headers: ['x-request-test', 'x-response-test'],
    hooks: {
      request (span, req) {
        if (req.aborted) span.setTag('test.aborted', 'true')
      },
    },
  },
})
if (process.env.TEST_CASE === 'disabled') tracer.use('http', false)
const sharedError = new Error('shared failure')
const pendingErrors = []
const staticResponse = new Response('static')
staticResponse.clone = () => { throw new Error('static routes must not be cloned in JavaScript') }

let fetch
if (process.env.TEST_CASE === 'hono') {
  const { Hono } = require('hono')
  const app = new Hono()
  app.use(async function middleware (c, next) { await next() })
  app.get('/users/:id', async c => {
    await Promise.resolve()
    assert.ok(tracer.scope().active())
    return c.text(c.req.param('id'))
  })
  fetch = app.fetch
} else {
  fetch = function (request, server) {
    const url = URL.parse(request.url)
    // Malformed Host headers produce request URLs that cannot be parsed, and such requests are not traced.
    if (url === null) return new Response('unparsed')
    if (url.pathname.startsWith('/direct')) {
      // Bun omits the server argument for direct `server.fetch(request)` calls.
      assert.strictEqual(server, undefined)
      assert.ok(tracer.scope().active())
      if (url.pathname === '/direct/throw') throw new Error('direct sync failure')
      if (url.pathname === '/direct/reject') return Promise.reject(new Error('direct async failure'))
      return new Response('direct')
    }
    assert.strictEqual(this, server)
    if (process.env.TEST_CASE === 'disabled') {
      assert.strictEqual(tracer.scope().active(), null)
      tracer.trace('disabled.control', () => {})
      return new Response('disabled')
    }
    assert.ok(tracer.scope().active())
    const path = url.pathname
    if (path === '/ws') {
      if (server.upgrade(request)) return
      return new Response('upgrade rejected', { status: 400 })
    }
    if (path === '/abort') {
      process.send({ event: 'pending' })
      return new Promise(resolve => {
        request.signal.addEventListener('abort', () => resolve(new Response('late', { status: 503 })), { once: true })
      })
    }
    if (path === '/throw') throw new Error('sync failure')
    if (path === '/reject') return Promise.reject(new Error('async failure'))
    if (path === '/shared-error') return Promise.reject(sharedError)
    if (path.startsWith('/shared-error/')) {
      return new Promise((resolve, reject) => {
        pendingErrors.push(reject)
        if (pendingErrors.length === 2) {
          queueMicrotask(() => pendingErrors.splice(0).forEach(reject => reject(sharedError)))
        }
      })
    }
    if (path.startsWith('/concurrent/')) {
      const span = tracer.scope().active()
      return new Promise(resolve => setImmediate(() => {
        assert.strictEqual(tracer.scope().active(), span)
        resolve(new Response(path))
      }))
    }
    if (path === '/async') {
      return Promise.resolve().then(() => {
        assert.ok(tracer.scope().active())
        return new Response('async')
      })
    }
    if (path === '/unavailable') return new Response('unavailable', { status: 503 })
    if (path === '/redirect') return Response.redirect('https://example.com/')
    if (path === '/stream') {
      return new Response(new ReadableStream({
        start (controller) {
          controller.enqueue(new TextEncoder().encode('streamed body'))
          controller.close()
        },
      }))
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' },
      })
    }
    return new Response('ok', { headers: { 'x-response-test': 'response-value' } })
  }
}

const server = globalThis.Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  development: false,
  websocket: { message (ws, message) { ws.send(message) } },
  fetch: process.env.TEST_CASE === 'routes-only' ? undefined : fetch,
  ...((process.env.TEST_CASE?.startsWith('routes') || process.env.TEST_CASE === 'disabled') && {
    routes: {
      '/native/:id': request => new Response(request.params.id),
      '/static': staticResponse,
      '/static-method': { GET: staticResponse },
      '/method': { POST: request => new Response(request.method) },
      '/route-error': () => { throw new Error('route failure') },
    },
  }),
  ...(process.env.TEST_CASE === 'custom-error' && {
    async error (error) {
      assert.strictEqual(this, server)
      assert.ok(tracer.scope().active())
      return tracer.trace('custom.error', async () => {
        await Promise.resolve()
        return new Response(tracer.scope().active().context().toTraceId(), { status: 502 })
      })
    },
  }),
})

if (process.env.TEST_CASE === 'reload') {
  server.reload({
    fetch () { return new Response('reloaded') },
    routes: {
      '/reloaded/:id': request => new Response(request.params.id),
      '/static': staticResponse,
      '/reload-error': () => { throw new Error('reload failure') },
    },
    error (error) { return new Response(error.message, { status: 502 }) },
  })
  server.reload({ fetch: () => new Response('reloaded') })
}

process.on('message', async ({ event, path }) => {
  if (event !== 'direct') return
  try {
    const response = await server.fetch(new Request(`http://localhost:${server.port}${path}`))
    process.send({ event: 'direct', status: response.status, body: await response.text() })
  } catch (error) {
    process.send({ event: 'direct', error: error.message })
  }
})

process.send({ port: server.port })
