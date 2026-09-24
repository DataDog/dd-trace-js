'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')

const axios = require('axios')

const agent = require('../../dd-trace/test/plugins/agent')
const { storage } = require('../../datadog-core')
const {
  createDatadogInstrumentation,
  injectInstrumentation,
  DD_INSTRUMENTATION,
} = require('../../datadog-instrumentations/src/react-router')

describe('Plugin', () => {
  describe('react-router', () => {
    describe('injectInstrumentation', () => {
      it('should inject Datadog instrumentation into a ServerBuild', () => {
        const build = {
          entry: {
            module: {
              default () {},
              instrumentations: [],
            },
          },
        }

        const next = injectInstrumentation(build)

        assert.notEqual(next, build)
        assert.equal(next.entry.module.instrumentations.length, 1)
        assert.equal(next.entry.module.instrumentations[0][DD_INSTRUMENTATION], true)
      })

      it('should inject into unstable_instrumentations when that key is used', () => {
        const build = {
          entry: {
            module: {
              default () {},
              unstable_instrumentations: [{ handler () {} }],
            },
          },
        }

        const next = injectInstrumentation(build)

        assert.equal(next.entry.module.unstable_instrumentations.length, 2)
        assert.equal(next.entry.module.unstable_instrumentations[0][DD_INSTRUMENTATION], true)
      })

      it('should be idempotent', () => {
        const build = {
          entry: {
            module: {
              default () {},
              instrumentations: [],
            },
          },
        }

        const once = injectInstrumentation(build)
        const twice = injectInstrumentation(once)

        assert.equal(once, twice)
        assert.equal(once.entry.module.instrumentations.length, 1)
      })
    })

    describe('ServerInstrumentation API', () => {
      let tracer
      let server
      let port

      before(async () => {
        await agent.load(['react-router', 'http'], [{}, { client: false }])
        // Normally fired when `react-router` is required; publish manually so the
        // plugin class is registered for these ServerInstrumentation unit tests.
        require('../../datadog-instrumentations/src/react-router')
        require('dc-polyfill').channel('dd-trace:instrumentation:load')
          .publish({ name: 'react-router' })
        tracer = require('../../dd-trace')
      })

      after(() => agent.close({ ritmReset: false }))

      afterEach(() => {
        if (server) {
          server.close()
          server = null
        }
      })

      it('should tag the active span with http.route from handler meta.pattern', async () => {
        const instrumentation = createDatadogInstrumentation()
        const handlers = []

        instrumentation.handler({
          instrument (hooks) {
            handlers.push(hooks.request)
          },
        })

        server = http.createServer((req, res) => {
          const span = tracer.startSpan('test.request', {
            tags: {
              'span.type': 'web',
              'http.method': 'GET',
            },
          })

          // No `req` in the store so the plugin tags the active span directly
          // (Express/http normally provide `req` and go through web.setRoute).
          storage('legacy').enterWith({ span })

          const handleRequest = () => Promise.resolve({
            status: 'success',
            statusCode: 200,
            meta: { pattern: '/users/:id' },
          })

          Promise.resolve(handlers[0](handleRequest, {
            request: { method: 'GET', url: 'http://localhost/users/123' },
          })).then(() => {
            res.statusCode = 200
            res.end('ok')
            span.finish()
          }).catch((error) => {
            span.setTag('error', error)
            span.finish()
            res.statusCode = 500
            res.end('error')
          })
        })

        await new Promise((resolve) => {
          server.listen(0, '127.0.0.1', resolve)
        })
        port = server.address().port

        await axios.get(`http://127.0.0.1:${port}/users/123`)

        await agent.assertSomeTraces((traces) => {
          const span = traces[0].find(s => s.name === 'test.request')
          assert.ok(span)
          assert.equal(span.meta['http.route'], '/users/:id')
        })
      })

      it('should create a child span for loaders', async () => {
        const instrumentation = createDatadogInstrumentation()
        let routeHooks

        instrumentation.route({
          id: 'routes/users.$id',
          instrument (hooks) {
            routeHooks = hooks
          },
        })

        server = http.createServer((req, res) => {
          const span = tracer.startSpan('test.request', {
            tags: { 'span.type': 'web', 'http.method': 'GET' },
          })
          storage('legacy').enterWith({ span })

          Promise.resolve(routeHooks.loader(
            () => Promise.resolve({ status: 'success' }),
            {
              pattern: '/users/:id',
              request: { method: 'GET', url: 'http://localhost/users/123' },
            }
          )).then(() => {
            res.statusCode = 200
            res.end('ok')
            span.finish()
          })
        })

        await new Promise((resolve) => {
          server.listen(0, '127.0.0.1', resolve)
        })
        port = server.address().port

        await axios.get(`http://127.0.0.1:${port}/users/123`)

        await agent.assertSomeTraces((traces) => {
          const spans = traces[0]
          const parent = spans.find(s => s.name === 'test.request')
          const loader = spans.find(s => s.name === 'react-router.loader')
          assert.ok(parent)
          assert.ok(loader)
          assert.equal(loader.resource, '/users/:id')
          assert.equal(loader.parent_id.toString(), parent.span_id.toString())
          assert.equal(parent.meta['http.route'], '/users/:id')
        })
      })

      it('should create a child span for actions', async () => {
        const instrumentation = createDatadogInstrumentation()
        let routeHooks

        instrumentation.route({
          id: 'routes/users.$id',
          instrument (hooks) {
            routeHooks = hooks
          },
        })

        server = http.createServer((req, res) => {
          const span = tracer.startSpan('test.request', {
            tags: { 'span.type': 'web', 'http.method': 'POST' },
          })
          storage('legacy').enterWith({ span })

          Promise.resolve(routeHooks.action(
            () => Promise.resolve({ status: 'success' }),
            {
              pattern: '/users/:id',
              request: { method: 'POST', url: 'http://localhost/users/123' },
            }
          )).then(() => {
            res.statusCode = 200
            res.end('ok')
            span.finish()
          })
        })

        await new Promise((resolve) => {
          server.listen(0, '127.0.0.1', resolve)
        })
        port = server.address().port

        await axios.post(`http://127.0.0.1:${port}/users/123`)

        await agent.assertSomeTraces((traces) => {
          const spans = traces[0]
          const parent = spans.find(s => s.name === 'test.request')
          const action = spans.find(s => s.name === 'react-router.action')
          assert.ok(parent)
          assert.ok(action)
          assert.equal(action.resource, '/users/:id')
          assert.equal(action.parent_id.toString(), parent.span_id.toString())
        })
      })
    })
  })
})
