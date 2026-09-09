'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')

const { channel } = require('dc-polyfill')
const semver = require('semver')
const satisfies = require('../../../vendor/dist/semifies')
const tags = require('../../../ext/tags')
const { NODE_MAJOR } = require('../../../version')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { rawExpectedSchema } = require('./naming')
const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS

const SERVICE_NAME = 'test'
const upgradeChannel = channel('apm:undici:request:upgrade')

// Helper to find an error with a specific type in the caught error's cause chain
// Different undici versions wrap errors differently, so we need to walk the chain
// Returns the matching error object, or null if not found
function findErrorInCauseChain (error, targetErrorType) {
  let current = error
  while (current) {
    if (current.name === targetErrorType) return current
    // Also check errors array in AggregateError
    if (current.errors) {
      for (const e of current.errors) {
        if (e.name === targetErrorType) return e
      }
    }
    current = current.cause
  }
  return null
}

describe('Plugin', () => {
  let express
  let fetch
  let appListener

  describe('undici-fetch', () => {
    withVersions('undici', 'undici', NODE_MAJOR < 20 ? '<7.11.0' : '*', (version, moduleName, resolvedVersion) => {
      const hasNativeDiagnostics = satisfies(resolvedVersion, '>=4.7.0 <5.0.0 || >=5.1.0')

      /**
       * @param {import('express').Application} app
       * @param {(port: number) => void} [listener]
       * @returns {import('node:http').Server}
       */
      function server (app, listener) {
        const server = require('http').createServer(app)
        server.listen(0, 'localhost', () => {
          listener?.((/** @type {import('net').AddressInfo} */ (server.address())).port)
        })
        return server
      }

      beforeEach(() => {
        appListener = null
      })

      afterEach(() => {
        if (appListener) {
          appListener.close()
        }
        return agent.close()
      })

      describe('with OTel semantics enabled', () => {
        beforeEach(() => {
          process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED = 'true'
          return agent.load('undici', {
            service: 'test',
          })
            .then(() => {
              express = require('express')
              fetch = require(`../../../versions/undici@${version}`, {}).get()
            })
        })

        afterEach(() => {
          express = null
          delete process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED
        })

        it('emits OpenTelemetry client attributes and omits the Datadog ones', done => {
          const app = express()
          app.get('/user', (req, res) => {
            res.status(200).send()
          })
          appListener = server(app, port => {
            agent.assertFirstTraceSpan(span => {
              assertObjectContains(span, {
                meta: {
                  'span.kind': 'client',
                  'http.request.method': 'GET',
                  'url.full': `http://localhost:${port}/user`,
                  'server.address': 'localhost',
                },
                metrics: {
                  'server.port': port,
                  'http.response.status_code': 200,
                },
              })
              assert.ok(!Object.hasOwn(span.meta, 'http.method'))
              assert.ok(!Object.hasOwn(span.meta, 'http.url'))
              assert.ok(!Object.hasOwn(span.meta, 'http.status_code'))
              assert.ok(!Object.hasOwn(span.meta, 'out.host'))
            }).then(done).catch(done)

            fetch.fetch(`http://localhost:${port}/user`, { method: 'GET' })
          })
        })
      })

      describe('without configuration', () => {
        let tracer

        beforeEach(() => {
          return agent.load('undici', {
            service: 'test',
          })
            .then(currentTracer => {
              tracer = currentTracer
              express = require('express')
              fetch = require(`../../../versions/undici@${version}`, {}).get()
            })
        })

        afterEach(() => {
          express = null
          tracer = null
        })

        withNamingSchema(
          () => {
            const app = express()
            app.get('/user', (req, res) => {
              res.status(200).send()
            })

            appListener = server(app, port => {
              fetch.fetch(`http://localhost:${port}/user`, { method: 'GET' })
            })
          },
          rawExpectedSchema.client
        )

        it('should do automatic instrumentation', function (done) {
          const app = express()
          app.get('/user', (req, res) => {
            res.status(200).send()
          })
          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].service, 'test')
                assert.strictEqual(traces[0][0].type, 'http')
                assert.strictEqual(traces[0][0].resource, 'GET')
                assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
                assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/user`)
                assert.strictEqual(traces[0][0].meta['http.method'], 'GET')
                assert.strictEqual(traces[0][0].meta['http.status_code'], '200')
                assert.strictEqual(traces[0][0].meta.component, 'undici')
                assert.strictEqual(traces[0][0].meta['_dd.integration'], 'undici')
                assert.strictEqual(traces[0][0].meta['out.host'], 'localhost')
              })
              .then(done)
              .catch(done)

            fetch.fetch(`http://localhost:${port}/user`, { method: 'GET' })
          })
        })

        it('should keep the caller span active while creating a request', async function () {
          if (!hasNativeDiagnostics) {
            this.skip()
            return
          }

          const app = express()
          app.get('/user', (_request, response) => response.status(200).send())
          appListener = server(app)
          await once(appListener, 'listening')
          const port = (/** @type {import('node:net').AddressInfo} */ (appListener.address())).port
          const parent = tracer.startSpan('parent')

          try {
            await tracer.scope().activate(parent, async () => {
              const responsePromise = fetch.fetch(`http://localhost:${port}/user`)
              assert.strictEqual(tracer.scope().active(), parent)
              const response = await responsePromise
              await response.arrayBuffer()
            })
          } finally {
            parent.finish()
          }
        })

        it('should finish the request span when the server accepts an upgrade', async function () {
          if (!satisfies(resolvedVersion, '>=4.7.0')) {
            this.skip()
            return
          }

          let requestHookCalls = 0
          agent.reload('undici', {
            hooks: {
              request () {
                requestHookCalls++
              },
            },
            service: 'test',
          })

          appListener = require('node:http').createServer()
          appListener.once('upgrade', (_request, socket) => {
            socket.write(
              'HTTP/1.1 101 Switching Protocols\r\n' +
              'Connection: Upgrade\r\n' +
              'Upgrade: test\r\n' +
              '\r\n'
            )
          })
          appListener.listen(0, 'localhost')
          await once(appListener, 'listening')
          const port = (/** @type {import('node:net').AddressInfo} */ (appListener.address())).port
          const client = new fetch.Client(`http://localhost:${port}`)
          const fallbackMessages = []
          const fallbackSubscriber = message => fallbackMessages.push(message)
          const tracePromise = agent.assertFirstTraceSpan(span => {
            assert.strictEqual(span.resource, 'GET')
            assert.strictEqual(span.meta['http.status_code'], '101')
          })
          upgradeChannel.subscribe(fallbackSubscriber)

          try {
            const { headers, socket } = await client.upgrade({ path: '/', protocol: 'test' })
            assert.notStrictEqual(headers, undefined)
            socket.destroy()
            await Promise.all([tracePromise, client.close()])

            assert.strictEqual(fallbackMessages.length, 1)
            assert.strictEqual(fallbackMessages[0].statusCode, 101)
            assert.strictEqual(requestHookCalls, 1)
          } finally {
            upgradeChannel.unsubscribe(fallbackSubscriber)
          }
        })

        it('should not use the accepted-upgrade fallback when the server rejects an upgrade', async function () {
          if (!satisfies(resolvedVersion, '>=4.7.0')) {
            this.skip()
            return
          }

          appListener = require('node:http').createServer((_request, response) => response.end())
          appListener.listen(0, 'localhost')
          await once(appListener, 'listening')
          const port = (/** @type {import('node:net').AddressInfo} */ (appListener.address())).port
          const client = new fetch.Client(`http://localhost:${port}`)
          const fallbackMessages = []
          const fallbackSubscriber = message => fallbackMessages.push(message)
          const tracePromise = agent.assertFirstTraceSpan({ resource: 'GET' })
          upgradeChannel.subscribe(fallbackSubscriber)

          try {
            await assert.rejects(client.upgrade({ path: '/', protocol: 'test' }))
            await Promise.all([tracePromise, client.close()])
            assert.deepStrictEqual(fallbackMessages, [])
          } finally {
            upgradeChannel.unsubscribe(fallbackSubscriber)
          }
        })

        it('should finish the request span when an accepted-upgrade handler throws', async function () {
          if (!hasNativeDiagnostics) {
            this.skip()
            return
          }

          appListener = require('node:http').createServer()
          appListener.once('upgrade', (_request, socket) => {
            socket.write(
              'HTTP/1.1 101 Switching Protocols\r\n' +
              'Connection: Upgrade\r\n' +
              'Upgrade: test\r\n' +
              '\r\n'
            )
          })
          appListener.listen(0, 'localhost')
          await once(appListener, 'listening')
          const port = (/** @type {import('node:net').AddressInfo} */ (appListener.address())).port
          const client = new fetch.Client(`http://localhost:${port}`)
          const expectedError = new Error('upgrade handler failed')
          const fallbackMessages = []
          const fallbackSubscriber = message => fallbackMessages.push(message)
          const throwExpectedError = () => { throw expectedError }
          const tracePromise = agent.assertFirstTraceSpan(span => {
            assert.strictEqual(span.resource, 'GET')
            assert.strictEqual(span.meta['http.status_code'], '101')
            assert.strictEqual(span.meta[ERROR_TYPE], expectedError.name)
            assert.strictEqual(span.meta[ERROR_MESSAGE], expectedError.message)
          })
          upgradeChannel.subscribe(fallbackSubscriber)

          try {
            client.dispatch({ method: 'GET', path: '/', upgrade: 'test' }, {
              onConnect () {},
              onError () {},
              onRequestStart () {},
              onRequestUpgrade: throwExpectedError,
              onResponseError () {},
              onUpgrade: throwExpectedError,
            })
            await Promise.all([tracePromise, client.close()])

            assert.strictEqual(fallbackMessages.length, 1)
            assert.strictEqual(fallbackMessages[0].error, expectedError)
          } finally {
            upgradeChannel.unsubscribe(fallbackSubscriber)
          }
        })

        it('should support URL input', done => {
          const app = express()
          app.post('/user', (req, res) => {
            res.status(200).send()
          })
          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].service, SERVICE_NAME)
                assert.strictEqual(traces[0][0].type, 'http')
                assert.strictEqual(traces[0][0].resource, 'POST')
                assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
                assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/user`)
                assert.strictEqual(traces[0][0].meta['http.method'], 'POST')
                assert.strictEqual(traces[0][0].meta['http.status_code'], '200')
                assert.strictEqual(traces[0][0].meta.component, 'undici')
                assert.strictEqual(traces[0][0].meta['out.host'], 'localhost')
              })
              .then(done)
              .catch(done)

            fetch.fetch(new URL(`http://localhost:${port}/user`), { method: 'POST' })
          })
        })

        it('should return the response', done => {
          const app = express()
          app.get('/user', (req, res) => {
            res.status(200).send()
          })
          appListener = server(app, port => {
            fetch.fetch((`http://localhost:${port}/user`))
              .then(res => {
                assert.strictEqual(res.status, 200)
                done()
              })
              .catch(done)
          })
        })

        it('should remove the query string from the URL', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].meta['http.status_code'], '200')
                assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/user`)
              })
              .then(done)
              .catch(done)

            fetch.fetch(`http://localhost:${port}/user?foo=bar`)
          })
        })

        it('should inject its parent span in the headers', done => {
          const app = express()

          app.get('/user', (req, res) => {
            assert.strictEqual(typeof req.get('x-datadog-trace-id'), 'string')
            assert.strictEqual(typeof req.get('x-datadog-parent-id'), 'string')

            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].meta['http.status_code'], '200')
              })
              .then(done)
              .catch(done)

            fetch.fetch(`http://localhost:${port}/user?foo=bar`)
          })
        })

        it('should inject its parent span in the existing headers', done => {
          const app = express()

          app.get('/user', (req, res) => {
            assert.strictEqual(typeof req.get('foo'), 'string')
            assert.strictEqual(typeof req.get('x-datadog-trace-id'), 'string')
            assert.strictEqual(typeof req.get('x-datadog-parent-id'), 'string')

            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].meta['http.status_code'], '200')
              })
              .then(done)
              .catch(done)

            fetch.fetch(`http://localhost:${port}/user?foo=bar`, { headers: { foo: 'bar' } })
          })
        })

        it('should handle connection errors', done => {
          let caughtError

          agent
            .assertSomeTraces(traces => {
              const spanErrorType = traces[0][0].meta[ERROR_TYPE]

              // The error in the span should match either the thrown error or something in its cause chain
              // For fetch with native DC (>= 4.7.0), the DC error becomes caught.cause
              // For fetch wrapper (< 4.7.0), it records the thrown error directly
              const error = findErrorInCauseChain(caughtError, spanErrorType)
              assert.ok(error, `Error type ${spanErrorType} should match thrown error or be in cause chain`)

              assertObjectContains(traces, [[{
                error: 1,
                meta: {
                  [ERROR_TYPE]: error.name,
                  [ERROR_MESSAGE]: error.message || error.code,
                  [ERROR_STACK]: error.stack,
                  component: 'undici',
                },
              }]])
            })
            .then(done)
            .catch(done)

          fetch.fetch('http://localhost:7357/user').catch(err => {
            caughtError = err
          })
        })

        it('should not record HTTP 5XX responses as errors by default', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(500).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].error, 0)
              })
              .then(done)
              .catch(done)

            fetch.fetch(`http://localhost:${port}/user`)
          })
        })

        it('should record HTTP 4XX responses as errors by default', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(400).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].error, 1)
              })
              .then(done)
              .catch(done)

            fetch.fetch(`http://localhost:${port}/user`)
          })
        })

        it('should not record aborted requests as errors', done => {
          const app = express()

          app.get('/user', (req, res) => {})

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].error, 0)
                assert.ok(!('http.status_code' in traces[0][0].meta))
              })
              .then(done)
              .catch(done)

            const controller = new AbortController()

            fetch.fetch(`http://localhost:${port}/user`, {
              signal: controller.signal,
            }).catch(() => {})

            controller.abort()
          })
        })

        it('should record when the request was aborted', done => {
          const app = express()

          app.get('/abort', (req, res) => {
            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].service, SERVICE_NAME)
              })
              .then(done)
              .catch(done)

            const controller = new AbortController()

            fetch.fetch(`http://localhost:${port}/user`, {
              signal: controller.signal,
            }).catch(() => {})

            controller.abort()
          })
        })

        // Tests for undici.request() using native diagnostic channels
        // Only run for undici >= 4.7.0 where diagnostic channels were added
        {
          const requestTest = semver.satisfies(resolvedVersion, '>=4.7.0') ? it : it.skip
          requestTest('should do automatic instrumentation for undici.request()', function (done) {
            const app = express()
            app.get('/user', (req, res) => {
              res.status(200).send('OK')
            })
            appListener = server(app, port => {
              agent
                .assertFirstTraceSpan({
                  service: 'test',
                  type: 'http',
                  resource: 'GET',
                  meta: {
                    'span.kind': 'client',
                    'http.url': `http://localhost:${port}/user`,
                    'http.method': 'GET',
                    'http.status_code': '200',
                    component: 'undici',
                    'out.host': 'localhost',
                  },
                })
                .then(done)
                .catch(done)

              fetch.request(`http://localhost:${port}/user`, { method: 'GET' })
                .then(({ body }) => body.dump())
                .catch(() => {})
            })
          })

          requestTest('should support POST requests with undici.request()', done => {
            const app = express()
            app.post('/user', (req, res) => {
              res.status(201).send('Created')
            })
            appListener = server(app, port => {
              agent
                .assertFirstTraceSpan({
                  resource: 'POST',
                  meta: {
                    'http.method': 'POST',
                    'http.status_code': '201',
                  },
                })
                .then(done)
                .catch(done)

              fetch.request(`http://localhost:${port}/user`, { method: 'POST' })
                .then(({ body }) => body.dump())
                .catch(() => {})
            })
          })

          requestTest('should inject trace headers in undici.request()', done => {
            const app = express()

            app.get('/user', (req, res) => {
              assert.strictEqual(typeof req.get('x-datadog-trace-id'), 'string')
              assert.strictEqual(typeof req.get('x-datadog-parent-id'), 'string')

              res.status(200).send('OK')
            })

            appListener = server(app, port => {
              agent
                .assertFirstTraceSpan({
                  meta: {
                    'http.status_code': '200',
                  },
                })
                .then(done)
                .catch(done)

              fetch.request(`http://localhost:${port}/user`)
                .then(({ body }) => body.dump())
                .catch(() => {})
            })
          })

          requestTest('should handle connection errors in undici.request()', done => {
            let error

            agent
              .assertSomeTraces(traces => {
                assertObjectContains(traces[0][0], {
                  meta: {
                    [ERROR_TYPE]: error.name,
                    [ERROR_STACK]: error.stack,
                    component: 'undici',
                  },
                })
                assert.ok(traces[0][0].meta[ERROR_MESSAGE])
              })
              .then(done)
              .catch(done)

            fetch.request('http://localhost:7357/user')
              .catch(err => {
                error = err
              })
          })

          requestTest('should record HTTP 4XX responses as errors in undici.request()', done => {
            const app = express()

            app.get('/user', (req, res) => {
              res.status(400).send('Bad Request')
            })

            appListener = server(app, port => {
              agent
                .assertFirstTraceSpan({
                  error: 1,
                })
                .then(done)
                .catch(done)

              fetch.request(`http://localhost:${port}/user`)
                .then(({ body }) => body.dump())
                .catch(() => {})
            })
          })

          requestTest('should not record HTTP 5XX responses as errors in undici.request()', done => {
            const app = express()

            app.get('/user', (req, res) => {
              res.status(500).send('Server Error')
            })

            appListener = server(app, port => {
              agent
                .assertFirstTraceSpan({
                  error: 0,
                })
                .then(done)
                .catch(done)

              fetch.request(`http://localhost:${port}/user`)
                .then(({ body }) => body.dump())
                .catch(() => {})
            })
          })
        }
      })
      describe('with service configuration', () => {
        let config

        beforeEach(() => {
          config = {
            service: 'custom',
          }

          return agent.load('undici', config)
            .then(() => {
              express = require('express')
              fetch = require(`../../../versions/undici@${version}`, {}).get()
            })
        })

        it('should be configured with the correct values', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].service, 'custom')
              })
              .then(done)
              .catch(done)

            fetch.fetch(`http://localhost:${port}/user`).catch(() => {})
          })
        })
      })
      describe('with configured HTTP client error statuses', () => {
        beforeEach(() => {
          process.env.DD_TRACE_HTTP_CLIENT_ERROR_STATUSES = '200-201,202'

          return agent.load('undici', { service: 'test' })
            .then(() => {
              express = require('express')
              fetch = require(`../../../versions/undici@${version}`, {}).get()
            })
        })

        afterEach(() => {
          express = null
          delete process.env.DD_TRACE_HTTP_CLIENT_ERROR_STATUSES
        })

        it('should mark a configured status code as an error', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].meta['http.status_code'], '200')
                assert.strictEqual(traces[0][0].error, 1)
              })
              .then(done)
              .catch(done)

            fetch.fetch(`http://localhost:${port}/user`).catch(() => {})
          })
        })

        it('should not mark a status code outside of the configured statuses as an error', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(500).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].meta['http.status_code'], '500')
                assert.strictEqual(traces[0][0].error, 0)
              })
              .then(done)
              .catch(done)

            fetch.fetch(`http://localhost:${port}/user`).catch(() => {})
          })
        })
      })
      describe('with headers configuration', () => {
        let config

        beforeEach(() => {
          config = {
            headers: ['x-baz', 'x-foo'],
          }

          return agent.load('undici', config)
            .then(() => {
              express = require('express')
              fetch = require(`../../../versions/undici@${version}`, {}).get()
            })
        })

        it('should add tags for the configured headers', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.setHeader('x-foo', 'bar')
            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                const meta = traces[0][0].meta
                assert.strictEqual(meta[`${HTTP_REQUEST_HEADERS}.x-baz`], 'qux')
                assert.strictEqual(meta[`${HTTP_RESPONSE_HEADERS}.x-foo`], 'bar')
              })
              .then(done)
              .catch(done)

            fetch.fetch(`http://localhost:${port}/user`, {
              headers: {
                'x-baz': 'qux',
              },
            }).catch(() => {})
          })
        })
      })
      describe('with hooks configuration', () => {
        let config
        let activeSpan
        let hookSpan
        let tracer

        beforeEach(() => {
          config = {
            hooks: {
              request: (span, req, res) => {
                activeSpan = tracer.scope().active()
                hookSpan = span
                span.setTag('foo', '/foo')
              },
            },
          }

          return agent.load('undici', config)
            .then(currentTracer => {
              tracer = currentTracer
              express = require('express')
              fetch = require(`../../../versions/undici@${version}`, {}).get()
            })
        })

        it('should run the request hook before the span is finished', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].meta.foo, '/foo')
                if (hasNativeDiagnostics) {
                  assert.strictEqual(activeSpan === hookSpan, true)
                }
              })
              .then(done)
              .catch(done)

            fetch.fetch(`http://localhost:${port}/user`).catch(() => {})
          })
        })
      })

      describe('with propagationBlocklist configuration', () => {
        let config

        beforeEach(() => {
          config = {
            propagationBlocklist: [/\/users/],
          }

          return agent.load('undici', config)
            .then(() => {
              express = require('express')
              fetch = require(`../../../versions/undici@${version}`, {}).get()
            })
        })

        it('should skip injecting if the url matches an item in the propagationBlacklist', done => {
          const app = express()

          app.get('/users', (req, res) => {
            try {
              assert.strictEqual(req.get('x-datadog-trace-id'), undefined)
              assert.strictEqual(req.get('x-datadog-parent-id'), undefined)

              res.status(200).send()

              done()
            } catch (e) {
              done(e)
            }
          })

          appListener = server(app, port => {
            fetch.fetch(`http://localhost:${port}/users`).catch(() => {})
          })
        })
      })

      describe('with blocklist configuration', () => {
        let config

        beforeEach(() => {
          config = {
            blocklist: [/\/user/],
          }

          return agent.load('undici', config)
            .then(() => {
              express = require('express')
              fetch = require(`../../../versions/undici@${version}`, {}).get()
            })
        })

        it('should skip recording if the url matches an item in the blocklist', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertNoTraces(() => {
                throw new Error('Blocklisted requests should not be recorded.')
              }, { timeoutMs: 100 })
              .then(done, done)

            fetch.fetch(`http://localhost:${port}/users`).catch(() => {})
          })
        })
      })

      describe('with custom dispatcher', () => {
        beforeEach(() => {
          return agent.load('undici', {
            service: 'test',
          })
            .then(() => {
              express = require('express')
              fetch = require(`../../../versions/undici@${version}`, {}).get()
            })
        })

        afterEach(() => {
          express = null
        })

        it('should preserve custom dispatcher option and trace the request', async function () {
          // Skip for versions that use fetch wrapping instead of native DC
          // Those versions have the dispatcher issue described in #6439
          if (!satisfies(resolvedVersion, '>=4.7.0 <5.0.0 || >=5.1.0')) {
            // These versions wrap fetch and cannot preserve a custom dispatcher.
            this.skip()
            return
          }

          const app = express()
          app.get('/user', (req, res) => {
            res.status(200).send('OK')
          })

          appListener = server(app)
          await once(appListener, 'listening')
          const port = (/** @type {import('net').AddressInfo} */ (appListener.address())).port

          // Create a custom Agent with specific settings
          // This is the use case from issue #6439
          const customAgent = new fetch.Agent({
            connect: { keepAlive: false },
          })
          const tracePromise = agent.assertFirstTraceSpan({
            service: 'test',
            type: 'http',
            resource: 'GET',
          })

          // Make request with custom dispatcher
          // For native DC versions, dispatcher is preserved because we don't wrap fetch at all
          const response = await fetch.fetch(`http://localhost:${port}/user`, {
            dispatcher: customAgent,
          })
          assert.strictEqual(response.status, 200)
          const [, body] = await Promise.all([tracePromise, response.text()])
          assert.strictEqual(body, 'OK')
        })
      })

      describe('with ProxyAgent', () => {
        let proxyListener

        beforeEach(() => {
          return agent.load('undici', {
            service: 'test',
          })
            .then(() => {
              express = require('express')
              fetch = require(`../../../versions/undici@${version}`, {}).get()
            })
        })

        afterEach(() => {
          if (proxyListener) {
            proxyListener.close()
            proxyListener = null
          }
          express = null
        })

        // Regression for the leaked CONNECT span: ProxyAgent emits :create + :bodySent for
        // the tunnel-setup request, but never :headers/:trailers/:error. Before the fix the
        // CONNECT span was started and never finished, which kept the parent trace pinned in
        // span_processor and prevented the surrounding express.request span from exporting.
        it('finishes the CONNECT tunnel span established via ProxyAgent', async function () {
          if (!satisfies(resolvedVersion, '>=5.1.0')) {
            // ProxyAgent is only available from undici 5.1.0.
            this.skip()
            return
          }

          let requestHookCalls = 0
          agent.reload('undici', {
            hooks: {
              request () {
                requestHookCalls++
              },
            },
            service: 'test',
          })

          const http = require('node:http')
          const net = require('node:net')

          const app = express()
          app.get('/data', (req, res) => res.status(200).send('OK'))

          appListener = server(app)
          await once(appListener, 'listening')
          const downstreamPort = (/** @type {import('net').AddressInfo} */ (appListener.address())).port

          const proxy = http.createServer((_req, res) => {
            res.writeHead(405)
            res.end()
          })
          proxy.on('connect', (req, clientSocket, head) => {
            const [hostname, portStr] = req.url.split(':')
            const upstream = net.connect(Number.parseInt(portStr, 10) || 80, hostname, () => {
              clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
              upstream.write(head)
              upstream.pipe(clientSocket)
              clientSocket.pipe(upstream)
            })
            upstream.on('error', () => clientSocket.end())
            clientSocket.on('error', () => upstream.end())
          })
          proxy.listen(0, 'localhost')
          await once(proxy, 'listening')

          proxyListener = proxy
          const proxyPort = (/** @type {import('net').AddressInfo} */ (proxy.address())).port
          const tracePromise = agent.assertSomeTraces(traces => {
            const connectSpan = traces.flat().find(s => s.resource === 'CONNECT')
            assert.ok(connectSpan, 'expected a finished CONNECT span to be exported')
            assertObjectContains(connectSpan, {
              name: 'undici.request',
              service: 'test',
              type: 'http',
              resource: 'CONNECT',
              meta: { 'http.method': 'CONNECT' },
            })
          }, { timeoutMs: 3000 })

          // proxyTunnel forces a CONNECT tunnel for the plain-HTTP-over-HTTP-proxy case.
          // undici 8.7.0 (nodejs/undici#5116) made that case forward an absolute-form
          // request instead of tunneling by default, so without this the proxy never sees
          // a CONNECT and there is no CONNECT span to assert on. The option is a no-op on
          // undici < 6.22.0, where CONNECT was always used.
          const dispatcher = new fetch.ProxyAgent({
            uri: `http://localhost:${proxyPort}`,
            proxyTunnel: true,
          })
          const { body } = await fetch.request(`http://localhost:${downstreamPort}/data`, { dispatcher })
          await Promise.all([body.text(), tracePromise])
          assert.strictEqual(requestHookCalls, 2)
        })
      })
    })
  })
})
