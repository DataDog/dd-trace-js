'use strict'

const tracer = require('dd-trace').init({ startupLogs: false, flushInterval: 10 })
const assert = require('node:assert/strict')

tracer.use('http', {
  server: {
    headers: ['x-request-test', 'x-response-test'],
  },
})
if (process.env.TEST_CASE === 'disabled') tracer.use('http', false)
const sharedError = new Error('shared failure')

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
    assert.strictEqual(this, server)
    if (process.env.TEST_CASE === 'disabled') {
      assert.strictEqual(tracer.scope().active(), null)
      tracer.trace('disabled.control', () => {})
      return new Response('disabled')
    }
    assert.ok(tracer.scope().active())
    const path = new URL(request.url).pathname
    if (path === '/throw') throw new Error('sync failure')
    if (path === '/reject') return Promise.reject(new Error('async failure'))
    if (path === '/shared-error') return Promise.reject(sharedError)
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
  fetch: process.env.TEST_CASE === 'routes-only' ? undefined : fetch,
  ...(process.env.TEST_CASE?.startsWith('routes') && {
    routes: {
      '/native/:id': request => new Response(request.params.id),
      '/static': new Response('static'),
      '/method': { POST: request => new Response(request.method) },
      '/route-error': () => { throw new Error('route failure') },
    },
  }),
  ...(process.env.TEST_CASE === 'custom-error' && {
    async error (error) {
      assert.strictEqual(this, server)
      assert.ok(tracer.scope().active())
      return new Response(error.message, { status: 502 })
    },
  }),
})

process.send({ port: server.port })
