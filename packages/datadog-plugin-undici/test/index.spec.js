'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { channel } = require('node:diagnostics_channel')
const { once } = require('node:events')
const { finished } = require('node:stream/promises')
const { promisify } = require('node:util')

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
const execFileAsync = promisify(execFile)

/**
 * @typedef {object} EncodedSpan
 * @property {Record<string, string>} meta
 * @property {Record<string, number>} metrics
 */

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

/**
 * @param {(value?: unknown) => void} resolve
 * @param {(reason?: unknown) => void} reject
 * @returns {object}
 */
function createDispatchHandler (resolve, reject) {
  return {
    onConnect: () => {},
    onError: reject,
    onHeaders: () => true,
    onData: () => {},
    onComplete: resolve,
    onRequestStart: () => {},
    onResponseError: (_controller, error) => reject(error),
    onResponseStart: controller => controller.resume(),
    onResponseData: () => {},
    onResponseEnd: () => resolve(),
  }
}

/**
 * @param {NodeJS.ProcessEnv} [overrides]
 */
async function runDefaultDispatcherRetentionFixture (overrides = {}) {
  const env = { ...process.env, ...overrides }
  delete env.NODE_OPTIONS
  delete env.OTEL_LOGS_EXPORTER
  delete env.OTEL_METRICS_EXPORTER
  delete env.OTEL_TRACES_EXPORTER

  await execFileAsync(process.execPath, [
    '--expose-gc',
    require.resolve('./fixtures/default-dispatcher-retention'),
  ], { env })
}

describe('Plugin', () => {
  let express
  let fetch
  let appListener
  let tracer

  it('traces the preexisting default dispatcher with bounded finished-span retention', async function () {
    this.timeout(30000)
    await runDefaultDispatcherRetentionFixture()
  })

  it('falls back to native request ownership for an immutable default dispatcher', async function () {
    this.timeout(30000)
    await runDefaultDispatcherRetentionFixture({ FROZEN_GLOBAL_DISPATCHER: 'true' })
  })

  it('wraps a foreign dispatcher installed after npm Undici loads', async function () {
    this.timeout(30000)
    await runDefaultDispatcherRetentionFixture({ FOREIGN_GLOBAL_DISPATCHER: 'true' })
  })

  it('finishes CONNECT through the preexisting global dispatcher', async function () {
    this.timeout(30000)
    await runDefaultDispatcherRetentionFixture({ CONNECT_GLOBAL_DISPATCHER: 'true' })
  })

  it('keeps foreign dispatcher instrumentation disabled without subscribers', async function () {
    this.timeout(30000)
    await runDefaultDispatcherRetentionFixture({ UNDICI_PLUGIN_DISABLED: 'true' })
  })

  it('does not fail npm Undici loading when a foreign dispatcher cannot be wrapped', async function () {
    this.timeout(30000)
    await runDefaultDispatcherRetentionFixture({ THROWING_GLOBAL_DISPATCHER: 'true' })
  })

  describe('undici-fetch', () => {
    withVersions('undici', 'undici', NODE_MAJOR < 20 ? '<7.11.0' : '*', (version, moduleName, resolvedVersion) => {
      let dispatcher
      let originalDispatcher

      function server (app, listener) {
        const server = require('http').createServer(app)
        server.listen(0, 'localhost', () => listener(
          (/** @type {import('net').AddressInfo} */ (server.address())).port)
        )
        return server
      }

      function loadUndici () {
        const undici = require(`../../../versions/undici@${version}`).get()
        originalDispatcher = undici.getGlobalDispatcher()
        dispatcher = new undici.Agent()
        undici.setGlobalDispatcher(dispatcher)
        tracer = require('../../dd-trace')
        return undici
      }

      /**
       * @param {import('node:http').RequestListener} app
       */
      async function listen (app) {
        appListener = require('node:http').createServer(app)
        appListener.listen(0, 'localhost')
        await once(appListener, 'listening')
        return (/** @type {import('node:net').AddressInfo} */ (appListener.address())).port
      }

      /**
       * @param {string} url
       * @param {object} [options]
       */
      async function requestAndDrain (url, options) {
        const { body } = await fetch.request(url, options)
        body.resume()
        await finished(body)
      }

      /**
       * @param {string} url
       * @returns {Promise<void>}
       */
      function requestAndDrainCallback (url) {
        return new Promise((resolve, reject) => {
          fetch.request(url, (error, response) => {
            if (error) {
              reject(error)
              return
            }

            response.body.resume()
            resolve(finished(response.body))
          })
        })
      }

      /**
       * @param {string} url
       */
      async function fetchAndConsume (url) {
        const response = await fetch.fetch(url)
        await response.arrayBuffer()
      }

      /**
       * @param {import('express').Request} _request
       * @param {import('express').Response} response
       */
      function respondOk (_request, response) {
        response.status(200).send('OK')
      }

      /**
       * @param {Array<Array<import('../../dd-trace/src/opentracing/span')>>} traces
       */
      function assertSingleUndiciSpan (traces) {
        assert.strictEqual(traces.length, 1)
        assert.strictEqual(traces[0].length, 1)
        assert.strictEqual(asEncodedSpan(traces[0][0]).meta.component, 'undici')
      }

      /**
       * @param {unknown} span
       * @returns {EncodedSpan}
       */
      function asEncodedSpan (span) {
        return /** @type {EncodedSpan} */ (span)
      }

      beforeEach(() => {
        appListener = null
      })

      afterEach(async () => {
        if (appListener) {
          appListener.close()
        }
        if (fetch && originalDispatcher) {
          fetch.setGlobalDispatcher(originalDispatcher)
        }
        await Promise.all([
          dispatcher?.close(),
          agent.close(),
        ])
        dispatcher = undefined
        originalDispatcher = undefined
      })

      describe('with OTel semantics enabled', () => {
        beforeEach(() => {
          process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED = 'true'
          return agent.load('undici', {
            service: 'test',
          })
            .then(() => {
              express = require('express')
              fetch = loadUndici()
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
              const encodedSpan = asEncodedSpan(span)
              assertObjectContains(encodedSpan, {
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
              assert.ok(!Object.hasOwn(encodedSpan.meta, 'http.method'))
              assert.ok(!Object.hasOwn(encodedSpan.meta, 'http.url'))
              assert.ok(!Object.hasOwn(encodedSpan.meta, 'http.status_code'))
              assert.ok(!Object.hasOwn(encodedSpan.meta, 'out.host'))
            }).then(done).catch(done)

            fetch.fetch(`http://localhost:${port}/user`, { method: 'GET' })
          })
        })
      })

      describe('without configuration', () => {
        beforeEach(() => {
          return agent.load('undici', {
            service: 'test',
          })
            .then(() => {
              express = require('express')
              fetch = loadUndici()
            })
        })

        afterEach(() => {
          express = null
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

        it('emits one request span for fetch', async () => {
          const app = express()
          app.get('/user', respondOk)
          const port = await listen(app)

          const tracesPromise = agent.assertSomeTraces(assertSingleUndiciSpan)
          const fetchPromise = fetchAndConsume(`http://localhost:${port}/user`)
          assert.strictEqual(tracer.scope().active(), null)

          await Promise.all([tracesPromise, fetchPromise])
          assert.strictEqual(tracer.scope().active(), null)
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
              assertSingleUndiciSpan(traces)
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
          assert.strictEqual(tracer.scope().active(), null)
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
                assertSingleUndiciSpan(traces)
                assert.strictEqual(traces[0][0].error, 0)
                assert.ok(!('http.status_code' in traces[0][0].meta))
              })
              .then(done)
              .catch(done)

            const controller = new AbortController()

            fetch.fetch(`http://localhost:${port}/user`, {
              signal: controller.signal,
            }).catch(() => {})
            assert.strictEqual(tracer.scope().active(), null)

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
                assertSingleUndiciSpan(traces)
                assert.strictEqual(traces[0][0].service, SERVICE_NAME)
              })
              .then(done)
              .catch(done)

            const controller = new AbortController()

            fetch.fetch(`http://localhost:${port}/user`, {
              signal: controller.signal,
            }).catch(() => {})
            assert.strictEqual(tracer.scope().active(), null)

            controller.abort()
          })
        })

        // Tests for undici.request() using native diagnostic channels
        // Only run for undici >= 4.7.0 where diagnostic channels were added
        if (semver.satisfies(resolvedVersion, '>=4.7.0')) {
          it('restores root context after dispatch and after awaiting request', async () => {
            const app = express()
            app.get('/user', respondOk)
            const port = await listen(app)
            let requestTraceId

            const tracesPromise = agent.assertSomeTraces(traces => {
              assertSingleUndiciSpan(traces)
              requestTraceId = traces[0][0].trace_id.toString(10)
            })
            const requestPromise = requestAndDrain(`http://localhost:${port}/user`)

            assert.strictEqual(tracer.scope().active(), null)

            await Promise.all([tracesPromise, requestPromise])

            assert.strictEqual(tracer.scope().active(), null)

            const laterSpan = tracer.startSpan('later')
            assert.notStrictEqual(laterSpan.context()._traceId.toString(10), requestTraceId)
            laterSpan.finish()
          })

          it('keeps sequential and parallel requests as siblings of their manual parent', async () => {
            const app = express()
            app.get('/user', respondOk)
            const port = await listen(app)
            const parent = tracer.startSpan('parent')
            const scope = tracer.scope()
            const tracesPromise = agent.assertSomeTraces(traces => {
              assert.strictEqual(traces.length, 1)
              assert.strictEqual(traces[0].length, 5)

              const parentSpan = traces[0].find(span => span.name === 'parent')
              assert.ok(parentSpan)

              const requestSpans = traces[0].filter(span => span.meta.component === 'undici')
              assert.strictEqual(requestSpans.length, 4)
              for (const requestSpan of requestSpans) {
                assert.strictEqual(requestSpan.parent_id.toString(), parentSpan.span_id.toString())
              }
            })

            await scope.activate(parent, async () => {
              const firstRequest = requestAndDrain(`http://localhost:${port}/user`)
              assert.strictEqual(scope.active(), parent)
              await firstRequest
              assert.strictEqual(scope.active(), parent)

              const secondRequest = requestAndDrainCallback(`http://localhost:${port}/user`)
              assert.strictEqual(scope.active(), parent)
              await secondRequest
              assert.strictEqual(scope.active(), parent)

              const parallelRequests = [
                requestAndDrain(`http://localhost:${port}/user`),
                fetchAndConsume(`http://localhost:${port}/user`),
              ]
              assert.strictEqual(scope.active(), parent)
              await Promise.all(parallelRequests)
              assert.strictEqual(scope.active(), parent)
            })

            parent.finish()
            await tracesPromise
            assert.strictEqual(scope.active(), null)
          })

          it('keeps context cleared across sequential root requests', async () => {
            const app = express()
            app.get('/user', respondOk)
            const port = await listen(app)

            for (let requestIndex = 0; requestIndex < 2; requestIndex++) {
              await Promise.all([
                agent.assertSomeTraces(assertSingleUndiciSpan),
                requestAndDrain(`http://localhost:${port}/user`),
              ])
              assert.strictEqual(tracer.scope().active(), null)
            }
          })

          it('uses the configured origin for direct Client requests', async () => {
            const app = express()
            app.get('/user', respondOk)
            const port = await listen(app)
            const origin = `http://localhost:${port}`
            const client = new fetch.Client(origin)
            const parent = tracer.startSpan('parent')
            const scope = tracer.scope()
            const tracesPromise = agent.assertSomeTraces(traces => {
              assert.strictEqual(traces.length, 1)
              assert.strictEqual(traces[0].length, 2)

              const parentSpan = traces[0].find(span => span.name === 'parent')
              const requestSpan = traces[0].find(span => span.meta.component === 'undici')
              assert.ok(parentSpan)
              assert.ok(requestSpan)
              assert.strictEqual(requestSpan.parent_id.toString(), parentSpan.span_id.toString())
              assert.strictEqual(requestSpan.meta['http.url'], `${origin}/user`)
            })

            await scope.activate(parent, async () => {
              const { body } = await client.request({ method: 'GET', path: '/user' })
              body.resume()
              await finished(body)
              assert.strictEqual(scope.active(), parent)
            })

            parent.finish()
            await Promise.all([tracesPromise, client.close()])
            assert.strictEqual(scope.active(), null)
          })

          it('does not read dispatch options before Undici creates the request', async () => {
            const app = express()
            app.get('/user', respondOk)
            const port = await listen(app)
            const client = new fetch.Client(`http://localhost:${port}`)
            let methodReads = 0
            const requestPromise = new Promise((resolve, reject) => {
              client.dispatch({
                path: '/user',
                get method () {
                  methodReads++
                  if (methodReads > 1) throw new Error('method was read more than once')
                  return 'GET'
                },
              }, createDispatchHandler(resolve, reject))
            })

            await Promise.all([
              agent.assertSomeTraces(assertSingleUndiciSpan),
              requestPromise,
            ])
            assert.strictEqual(methodReads, 1)
            await client.close()
          })

          it('does not read the request origin before Undici uses it', async () => {
            const app = express()
            app.get('/user', respondOk)
            const port = await listen(app)
            const origin = `http://localhost:${port}`
            const client = new fetch.Client(origin)
            let originReads = 0
            const requestPromise = new Promise((resolve, reject) => {
              client.dispatch({
                path: '/user',
                method: 'GET',
                get origin () {
                  originReads++
                  return origin
                },
              }, createDispatchHandler(resolve, reject))
            })

            await Promise.all([
              agent.assertSomeTraces(assertSingleUndiciSpan),
              requestPromise,
            ])
            const expectedOriginReads = satisfies(resolvedVersion, '>4.7.0 <7.0.0') ? 1 : 0
            assert.strictEqual(originReads, expectedOriginReads)
            await client.close()
          })

          it('traces invalid methods only when Undici creates a request', async () => {
            const client = new fetch.Client('http://localhost')
            const tracesPromise = satisfies(resolvedVersion, '<5.1.0')
              ? agent.assertSomeTraces(traces => {
                assertSingleUndiciSpan(traces)
                assert.strictEqual(traces[0][0].error, 1)
              })
              : agent.assertNoTraces(() => {
                throw new Error('A dispatch without a request should not be traced.')
              }, { timeoutMs: 100 })
            let handledError
            let resolveHandledError
            const handledErrorPromise = new Promise(resolve => {
              resolveHandledError = resolve
            })
            const handler = {
              onConnect: () => {},
              onError: error => {
                handledError = error
                resolveHandledError()
              },
              onHeaders: () => true,
              onData: () => {},
              onComplete: () => {},
            }
            let thrownError

            try {
              client.dispatch({ path: '/', method: 'INVALID METHOD' }, handler)
            } catch (error) {
              thrownError = error
            }
            if (!thrownError && !handledError) {
              await handledErrorPromise
            }
            assert.ok(thrownError || handledError)
            assert.strictEqual(tracer.scope().active(), null)

            await Promise.all([tracesPromise, client.close()])
          })

          it('does not trace synchronous failures before request creation', async function () {
            if (!satisfies(resolvedVersion, '<5.0.0')) {
              this.skip()
              return
            }

            const client = new fetch.Client('http://localhost')
            const noTracesPromise = agent.assertNoTraces(() => {
              throw new Error('A dispatch without a request should not be traced.')
            }, { timeoutMs: 100 })

            assert.throws(
              () => client.dispatch({ path: '/', method: 'GET' }),
              { name: 'InvalidArgumentError', message: /handler must be an object/ }
            )
            assert.strictEqual(tracer.scope().active(), null)

            await Promise.all([noTracesPromise, client.close()])
          })

          for (const { description, options, message } of [
            {
              description: 'missing options',
              options: undefined,
              message: /opts must be an object/,
            },
            {
              description: 'missing method',
              options: { path: '/' },
              message: /method must be a string/,
            },
          ]) {
            it(`preserves invalid dispatch errors for ${description}`, async () => {
              const client = new fetch.Client('http://localhost')
              const noTracesPromise = agent.assertNoTraces(() => {
                throw new Error('An invalid dispatch should not be traced.')
              }, { timeoutMs: 100 })
              let resolveHandledError
              const handledErrorPromise = new Promise(resolve => {
                resolveHandledError = resolve
              })
              const handler = {
                onConnect: () => {},
                onError: resolveHandledError,
                onHeaders: () => true,
                onData: () => {},
                onComplete: () => {},
              }

              let thrownError

              try {
                client.dispatch(options, handler)
              } catch (error) {
                thrownError = error
              }
              const error = thrownError || await handledErrorPromise

              assert.strictEqual(error.name, 'InvalidArgumentError')
              assert.match(error.message, message)
              assert.strictEqual(tracer.scope().active(), null)

              await Promise.all([noTracesPromise, client.close()])
            })
          }

          it('finishes the request span when the server upgrades the connection', async () => {
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

            const tracesPromise = agent.assertSomeTraces(traces => {
              assertSingleUndiciSpan(traces)
              assert.strictEqual(traces[0][0].error, 0)
              assert.strictEqual(traces[0][0].meta['http.status_code'], '101')
            })
            const upgradePromise = (async () => {
              const { socket } = await client.upgrade({ path: '/', protocol: 'test' })
              socket.destroy()
            })()

            await Promise.all([tracesPromise, upgradePromise])
            assert.strictEqual(tracer.scope().active(), null)
            await client.close()
          })

          it('tags a rejected CONNECT response before finishing the span', async () => {
            appListener = require('node:http').createServer()
            appListener.once('connect', (_request, socket) => {
              socket.end(
                'HTTP/1.1 407 Proxy Authentication Required\r\n' +
                'Content-Length: 0\r\n' +
                '\r\n'
              )
            })
            appListener.listen(0, 'localhost')
            await once(appListener, 'listening')
            const port = (/** @type {import('node:net').AddressInfo} */ (appListener.address())).port
            const client = new fetch.Client(`http://localhost:${port}`)

            const tracesPromise = agent.assertSomeTraces(traces => {
              assertSingleUndiciSpan(traces)
              assert.strictEqual(traces[0][0].error, 1)
              assert.strictEqual(traces[0][0].meta['http.status_code'], '407')
            })
            let connectPromise
            if (satisfies(resolvedVersion, '<5.1.0')) {
              connectPromise = assert.rejects(
                () => client.connect({ path: '/example.com:443' }),
                { name: 'SocketError' }
              )
            } else {
              connectPromise = (async () => {
                const { socket, statusCode } = await client.connect({ path: '/example.com:443' })
                assert.strictEqual(statusCode, 407)
                socket.destroy()
              })()
            }

            await Promise.all([tracesPromise, connectPromise])
            assert.strictEqual(tracer.scope().active(), null)
            await client.close()
          })

          it('should do automatic instrumentation for undici.request()', function (done) {
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

          it('should support POST requests with undici.request()', done => {
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

          it('should inject trace headers in undici.request()', done => {
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

          it('should handle connection errors in undici.request()', done => {
            let error

            agent
              .assertSomeTraces(traces => {
                assertSingleUndiciSpan(traces)
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
            assert.strictEqual(tracer.scope().active(), null)
          })

          it('should record HTTP 4XX responses as errors in undici.request()', done => {
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

          it('should not record HTTP 5XX responses as errors in undici.request()', done => {
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

      if (semver.satisfies(resolvedVersion, '>=4.7.0')) {
        describe('with Node fetch instrumentation', () => {
          beforeEach(async () => {
            await agent.load(['undici', 'fetch'])
            express = require('express')
            fetch = loadUndici()
          })

          it('keeps npm Undici and Node global fetch ownership separate', async () => {
            const app = express()
            app.get('/user', respondOk)
            const port = await listen(app)
            const url = `http://localhost:${port}/user`

            const globalFetchTraces = agent.assertSomeTraces(traces => {
              assert.strictEqual(traces.length, 1)
              assert.deepStrictEqual(traces[0].map(span => span.meta.component), ['fetch'])
            })
            const globalResponse = await globalThis.fetch(url)
            await globalResponse.arrayBuffer()
            await globalFetchTraces

            await Promise.all([
              agent.assertSomeTraces(assertSingleUndiciSpan),
              requestAndDrain(url),
            ])
          })
        })

        describe('with net instrumentation', () => {
          beforeEach(async () => {
            await agent.load(['undici', 'net'])
            express = require('express')
            fetch = loadUndici()
          })

          it('parents tcp.connect to the request span under the manual parent', async () => {
            const app = express()
            app.get('/user', respondOk)
            const port = await listen(app)
            const parent = tracer.startSpan('parent')
            const tracesPromise = agent.assertSomeTraces(traces => {
              assert.strictEqual(traces.length, 1)
              assert.strictEqual(traces[0].length, 3)

              const parentSpan = traces[0].find(span => span.name === 'parent')
              const requestSpan = traces[0].find(span => span.meta.component === 'undici')
              const connectSpan = traces[0].find(span => span.name === 'tcp.connect')
              assert.ok(parentSpan)
              assert.ok(requestSpan)
              assert.ok(connectSpan)
              assert.strictEqual(requestSpan.parent_id.toString(), parentSpan.span_id.toString())
              assert.strictEqual(connectSpan.parent_id.toString(), requestSpan.span_id.toString())
            })

            await tracer.scope().activate(parent, () => requestAndDrain(`http://localhost:${port}/user`))
            parent.finish()
            await tracesPromise
          })

          it('keeps reentrant requests separate before the outer request is created', async () => {
            const app = express()
            app.get('/user', respondOk)
            const port = await listen(app)
            const origin = `http://localhost:${port}`
            const outerClient = new fetch.Client(origin)
            const nestedClient = new fetch.Client(origin)
            const parent = tracer.startSpan('parent')
            const scope = tracer.scope()
            let nestedRequestPromise = Promise.resolve()
            let nestedRequestStarted = false
            const tracesPromise = agent.assertSomeTraces(traces => {
              assert.strictEqual(traces.length, 1)
              assert.strictEqual(traces[0].length, 5)

              const parentSpan = traces[0].find(span => span.name === 'parent')
              const requestSpans = traces[0].filter(span => span.meta.component === 'undici')
              const connectSpans = traces[0].filter(span => span.name === 'tcp.connect')
              assert.ok(parentSpan)
              assert.strictEqual(requestSpans.length, 2)
              assert.strictEqual(connectSpans.length, 2)

              const requestSpanIds = new Set()
              for (const requestSpan of requestSpans) {
                assert.strictEqual(requestSpan.parent_id.toString(), parentSpan.span_id.toString())
                requestSpanIds.add(requestSpan.span_id.toString())
              }
              for (const connectSpan of connectSpans) {
                assert.ok(requestSpanIds.has(connectSpan.parent_id.toString()))
              }
            })

            await scope.activate(parent, async () => {
              const outerRequestPromise = new Promise((resolve, reject) => {
                outerClient.dispatch({
                  path: '/user',
                  get method () {
                    if (!nestedRequestStarted) {
                      nestedRequestStarted = true
                      nestedRequestPromise = new Promise((resolve, reject) => {
                        nestedClient.dispatch(
                          { path: '/user', method: 'GET' },
                          createDispatchHandler(resolve, reject)
                        )
                      })
                    }
                    return 'GET'
                  },
                }, createDispatchHandler(resolve, reject))
              })

              await Promise.all([outerRequestPromise, nestedRequestPromise])
              assert.strictEqual(scope.active(), parent)
            })

            parent.finish()
            await Promise.all([tracesPromise, outerClient.close(), nestedClient.close()])
          })
        })
      }

      describe('with service configuration', () => {
        let config

        beforeEach(() => {
          config = {
            service: 'custom',
          }

          return agent.load('undici', config)
            .then(() => {
              express = require('express')
              fetch = loadUndici()
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
      describe('with headers configuration', () => {
        let config

        beforeEach(() => {
          config = {
            headers: ['x-baz', 'x-foo'],
          }

          return agent.load('undici', config)
            .then(() => {
              express = require('express')
              fetch = loadUndici()
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

        beforeEach(() => {
          config = {
            hooks: {
              request: (span, req, res) => {
                span.setTag('foo', '/foo')
              },
            },
          }

          return agent.load('undici', config)
            .then(() => {
              express = require('express')
              fetch = loadUndici()
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
              fetch = loadUndici()
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
              fetch = loadUndici()
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

        it('keeps the parent trace recording for a blocklisted request', async () => {
          const app = express()
          app.get('/user', respondOk)
          const port = await listen(app)
          const parent = tracer.startSpan('parent')
          const tracesPromise = agent.assertSomeTraces(traces => {
            assert.strictEqual(traces.length, 1)
            assert.strictEqual(traces[0].length, 2)
            assert.ok(traces[0].some(span => span.name === 'parent'))
            assert.ok(traces[0].some(span => span.name === 'sibling'))
            assert.ok(!traces[0].some(span => span.meta.component === 'undici'))
          })

          await tracer.scope().activate(parent, async () => {
            await requestAndDrain(`http://localhost:${port}/user`)
            const sibling = tracer.startSpan('sibling', { childOf: parent })
            sibling.finish()
          })
          parent.finish()

          await tracesPromise
        })
      })

      describe('with custom dispatcher', () => {
        let requestHookCalls

        beforeEach(() => {
          requestHookCalls = 0
          return agent.load('undici', {
            hooks: {
              request: () => {
                requestHookCalls++
              },
            },
            service: 'test',
          })
            .then(() => {
              express = require('express')
              fetch = loadUndici()
            })
        })

        afterEach(() => {
          express = null
        })

        it('should preserve custom dispatcher option and trace the request', function (done) {
          // Skip for versions that use fetch wrapping instead of native DC
          // Those versions have the dispatcher issue described in #6439
          if (!satisfies(resolvedVersion, '>=4.7.0 <5.0.0 || >=5.1.0')) {
            this.skip()
            return
          }

          const app = express()
          app.get('/user', (req, res) => {
            res.status(200).send('OK')
          })

          appListener = server(app, port => {
            // Create a custom Agent with specific settings
            // This is the use case from issue #6439
            const customAgent = new fetch.Agent({
              connect: { keepAlive: false },
            })

            agent
              .assertFirstTraceSpan({
                service: 'test',
                type: 'http',
                resource: 'GET',
              })
              .then(done)
              .catch(done)

            // Make request with custom dispatcher
            // For native DC versions, dispatcher is preserved because we don't wrap fetch at all
            fetch.fetch(`http://localhost:${port}/user`, {
              dispatcher: customAgent,
            }).then(res => {
              assert.strictEqual(res.status, 200)
              return res.text()
            }).then(body => {
              assert.strictEqual(body, 'OK')
            }).catch(done)
          })
        })

        it('finishes when a foreign dispatcher throws after creating the request', async function () {
          if (!satisfies(resolvedVersion, '>=4.7.0 <5.0.0 || >=5.1.0')) {
            this.skip()
            return
          }

          const app = express()
          app.get('/user', respondOk)
          const port = await listen(app)
          const dispatcher = fetch.getGlobalDispatcher()
          fetch.setGlobalDispatcher({
            dispatch (options, handler) {
              dispatcher.dispatch({ ...options }, handler)
              throw new Error('dispatch failed after creating the request')
            },
          })
          const tracesPromise = agent.assertSomeTraces(traces => {
            assertSingleUndiciSpan(traces)
            assert.strictEqual(traces[0][0].error, 1)
            assert.strictEqual(traces[0][0].meta[ERROR_MESSAGE], 'dispatch failed after creating the request')
          })

          await assert.rejects(
            fetch.request(`http://localhost:${port}/user`),
            { message: 'dispatch failed after creating the request' }
          )
          await tracesPromise
        })

        it('finishes once when a native request error precedes a foreign dispatch error', async function () {
          if (!satisfies(resolvedVersion, '>=4.7.0 <5.0.0 || >=5.1.0')) {
            this.skip()
            return
          }

          const app = express()
          app.get('/user', respondOk)
          const port = await listen(app)
          const dispatcher = fetch.getGlobalDispatcher()
          const requestCreateChannel = channel('undici:request:create')
          let nativeRequest
          const onRequestCreate = message => {
            nativeRequest = message.request
          }
          requestCreateChannel.subscribe(onRequestCreate)
          fetch.setGlobalDispatcher({
            dispatch (options, handler) {
              dispatcher.dispatch({ ...options }, handler)
              assert.ok(nativeRequest)
              const error = new Error('native request failed before dispatch')
              const failRequest = nativeRequest.onError || nativeRequest.onResponseError
              failRequest.call(nativeRequest, error)
              throw error
            },
          })
          const tracesPromise = agent.assertSomeTraces(assertSingleUndiciSpan)

          try {
            await Promise.all([
              assert.rejects(
                fetch.request(`http://localhost:${port}/user`),
                { message: 'native request failed before dispatch' }
              ),
              tracesPromise,
            ])
          } finally {
            requestCreateChannel.unsubscribe(onRequestCreate)
          }

          assert.strictEqual(requestHookCalls, 1)
        })
      })

      describe('with ProxyAgent', () => {
        let proxyListener
        let requestHookCalls

        beforeEach(async () => {
          requestHookCalls = 0
          await agent.load('undici', {
            hooks: {
              request: () => {
                requestHookCalls++
              },
            },
            service: 'test',
          })
          express = require('express')
          fetch = loadUndici()
        })

        afterEach(() => {
          if (proxyListener) {
            proxyListener.close()
            proxyListener = null
          }
          express = null
        })

        it('finishes CONNECT after the proxy establishes the tunnel', async function () {
          if (!satisfies(resolvedVersion, '>=5.1.0')) {
            this.skip()
            return
          }

          const http = require('node:http')
          const net = require('node:net')

          const app = express()
          app.get('/data', (req, res) => res.status(200).send('OK'))

          const downstreamPort = await listen(app)
          const proxy = http.createServer((_request, response) => {
            response.writeHead(405)
            response.end()
          })
          const proxyConnection = once(proxy, 'connect')
          proxy.listen(0, 'localhost')
          await once(proxy, 'listening')
          proxyListener = proxy
          const proxyPort = (/** @type {import('net').AddressInfo} */ (proxy.address())).port
          const tracesPromise = agent.assertSomeTraces(traces => {
            const spans = traces.flat()
            assert.strictEqual(spans.length, 2)
            const connectSpan = spans.find(span => span.resource === 'CONNECT')
            assert.ok(connectSpan)
            assertObjectContains(connectSpan, {
              name: 'undici.request',
              service: 'test',
              type: 'http',
              resource: 'CONNECT',
              meta: {
                'http.method': 'CONNECT',
                'http.status_code': '200',
              },
            })
          }, { timeoutMs: 3000 })

          // proxyTunnel forces CONNECT for plain HTTP on every supported Undici version.
          const proxyDispatcher = new fetch.ProxyAgent({
            uri: `http://localhost:${proxyPort}`,
            proxyTunnel: true,
          })
          const requestPromise = (async () => {
            try {
              const { body } = await fetch.request(`http://localhost:${downstreamPort}/data`, {
                dispatcher: proxyDispatcher,
              })
              assert.strictEqual(await body.text(), 'OK')
            } finally {
              await proxyDispatcher.close()
            }
          })()

          const [request, clientSocket, head] = await proxyConnection
          assert.ok(request.url)
          const [hostname, portString] = request.url.split(':')
          const upstream = net.connect(Number.parseInt(portString, 10) || 80, hostname)
          await once(upstream, 'connect')
          assert.strictEqual(requestHookCalls, 0)

          upstream.once('error', () => clientSocket.end())
          clientSocket.once('error', () => upstream.end())
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          upstream.write(head)
          upstream.pipe(clientSocket)
          clientSocket.pipe(upstream)

          await Promise.all([tracesPromise, requestPromise])
          assert.strictEqual(requestHookCalls, 2)
        })
      })
    })
  })
})
