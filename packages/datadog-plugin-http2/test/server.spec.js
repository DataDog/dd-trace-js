'use strict'

const assert = require('node:assert/strict')
const { setImmediate } = require('node:timers/promises')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { rawExpectedSchema } = require('./naming')

/**
 * @param {typeof import('http2')} http2
 * @param {string} url
 * @param {{ signal?: import('node:events').EventEmitter }} [options]
 */
function request (http2, url, options = {}) {
  const { signal } = options
  const urlObj = new URL(url)
  return new Promise((resolve, reject) => {
    const client = http2
      .connect(urlObj.origin)
      .on('error', reject)

    const req = client.request({
      ':path': urlObj.pathname + urlObj.search,
      ':method': 'GET',
    })
    req.on('error', reject)

    if (signal) {
      signal.on('abort', () => req.destroy())
    }

    const chunks = []
    req.on('data', (chunk) => {
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolve(Buffer.concat(chunks))
    })

    req.end()
  })
}

describe('Plugin', () => {
  let http2
  let listener
  let appListener
  let tracer
  let port
  let app

  ['http2', 'node:http2'].forEach(pluginToBeLoaded => {
    describe(`${pluginToBeLoaded}/server`, () => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
        listener = (req, res) => {
          app && app(req, res)
          res.writeHead(200)
          res.end()
        }
      })

      afterEach(() => {
        appListener && appListener.close()
        app = null
        return agent.close()
      })

      describe('cancelled request', () => {
        /** @type {Promise<void>} */
        let requestReceived
        /** @type {() => void} */
        let resolveRequestReceived

        /** @type {Promise<void>} */
        let allowHandler
        /** @type {() => void} */
        let resolveAllowHandler
        let responseSent

        beforeEach(() => {
          requestReceived = new Promise(resolve => { resolveRequestReceived = resolve })
          allowHandler = new Promise(resolve => { resolveAllowHandler = resolve })
          responseSent = false

          listener = (req, res) => {
            resolveRequestReceived()

            // Only invoke `app` after the test has explicitly allowed it.
            // This keeps the test deterministic and removes reliance on wall-clock time.
            let closed = false
            req.once('close', () => { closed = true })
            res.once('close', () => { closed = true })

            // Server-side safeguard: if something tries to send a response, record it.
            const writeHead = res.writeHead
            res.writeHead = function (...args) {
              responseSent = true
              return writeHead.apply(this, args)
            }
            const end = res.end
            res.end = function (...args) {
              responseSent = true
              return end.apply(this, args)
            }

            allowHandler.then(() => {
              if (closed) return
              app && app(req, res)
              res.writeHead(200)
              res.end()
            })
          }
        })

        beforeEach(() => {
          return agent.load('http2')
            .then(() => {
              http2 = require(pluginToBeLoaded)
            })
        })

        beforeEach(done => {
          const server = http2.createServer(listener)
          appListener = server
            .listen(0, 'localhost', () => {
              port = appListener.address().port
              done()
            })
        })

        it('should send traces to agent', async () => {
          app = sinon.stub()

          const tracesPromise = agent.assertSomeTraces(traces => {
            // The batch may also contain the client-side http.request span; find the server span.
            const serverTrace = traces.find(t => t[0]?.name === 'web.request')
            if (!serverTrace) throw new Error('No web.request span found in batch yet')

            sinon.assert.notCalled(app) // request should be cancelled before call to app

            assertObjectContains(serverTrace[0], {
              name: 'web.request',
              service: 'test',
              type: 'web',
              resource: 'GET',
              meta: {
                'span.kind': 'server',
                'http.url': `http://localhost:${port}/user`,
                'http.method': 'GET',
                'http.status_code': '200',
                component: 'http2',
              },
            })
          })

          const noop = () => {}
          const url = new URL(`http://localhost:${port}/user`)
          const client = http2.connect(url.origin)
          client.on('error', noop)

          const req = client.request({
            ':path': url.pathname,
            ':method': 'GET',
          })
          req.on('error', noop)

          let responseReceived = false
          req.once('response', () => { responseReceived = true })
          req.on('data', () => { responseReceived = true })
          const reqClosed = new Promise(resolve => req.once('close', resolve))

          req.end()

          // Ensure the server has received the request before we cancel it.
          await requestReceived

          const cancelCode = http2.constants && http2.constants.NGHTTP2_CANCEL
          if (typeof req.close === 'function' && cancelCode !== undefined) {
            req.close(cancelCode)
          } else {
            req.destroy()
          }

          if (typeof client.close === 'function') {
            client.close()
          } else {
            client.destroy()
          }

          // Give the event loop a chance to process the stream cancellation before allowing
          // the server handler to proceed (no fixed sleep, just a few turns).
          await setImmediate()
          await setImmediate()
          await setImmediate()

          resolveAllowHandler()

          await tracesPromise

          // Safeguard: if the handler ran, we'd typically see a response event/data.
          // Wait until the stream is fully closed, then assert we never observed a response.
          await reqClosed
          assert.strictEqual(responseReceived, false)
          assert.strictEqual(responseSent, false)
        })
      })

      describe('with OTel semantics enabled', () => {
        beforeEach(() => {
          process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED = 'true'
          return agent.load('http2', { client: false })
            .then(() => {
              http2 = require(pluginToBeLoaded)
            })
        })

        beforeEach(done => {
          appListener = http2.createServer(listener).listen(0, 'localhost', () => {
            port = appListener.address().port
            done()
          })
        })

        afterEach(() => {
          delete process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED
        })

        it('emits OpenTelemetry server attributes and omits the Datadog ones', done => {
          agent.assertSomeTraces(traces => {
            const span = traces[0][0]
            assertObjectContains(span, {
              name: 'web.request',
              meta: {
                'span.kind': 'server',
                'http.request.method': 'GET',
                'url.path': '/user',
                'url.scheme': 'http',
                'server.address': 'localhost',
              },
              metrics: {
                'http.response.status_code': 200,
              },
            })
            assert.ok(!Object.hasOwn(span.meta, 'http.method'))
            assert.ok(!Object.hasOwn(span.meta, 'http.url'))
            assert.ok(!Object.hasOwn(span.meta, 'http.status_code'))
          }).then(done).catch(done)

          request(http2, `http://localhost:${port}/user`).catch(done)
        })
      })

      describe('without configuration', () => {
        beforeEach(() => {
          return agent.load('http2')
            .then(() => {
              http2 = require(pluginToBeLoaded)
            })
        })

        beforeEach(done => {
          const server = http2.createServer(listener)
          appListener = server
            .listen(0, 'localhost', () => {
              port = appListener.address().port
              done()
            })
        })

        const spanProducerFn = (done) => {
          request(http2, `http://localhost:${port}/user`).catch(done)
        }

        withNamingSchema(
          spanProducerFn,
          rawExpectedSchema.server
        )

        it('should do automatic instrumentation', done => {
          agent
            .assertFirstTraceSpan({
              name: 'web.request',
              service: 'test',
              type: 'web',
              resource: 'GET',
              meta: {
                'span.kind': 'server',
                'http.url': `http://localhost:${port}/user`,
                'http.method': 'GET',
                'http.status_code': '200',
                component: 'http2',
              },
            })
            .then(done)
            .catch(done)

          request(http2, `http://localhost:${port}/user`).catch(done)
        })

        it('should run the request\'s close event in the correct context', done => {
          app = (req, res) => {
            req.on('close', () => {
              assert.strictEqual(tracer.scope().active(), null)
              done()
            })
          }

          request(http2, `http://localhost:${port}/user`).catch(done)
        })

        it('should run the response\'s close event in the correct context', done => {
          app = (req, res) => {
            const span = tracer.scope().active()

            res.on('close', () => {
              assert.strictEqual(tracer.scope().active(), span)
              done()
            })
          }

          request(http2, `http://localhost:${port}/user`).catch(done)
        })

        it('should run the finish event in the correct context', done => {
          app = (req, res) => {
            const span = tracer.scope().active()

            res.on('finish', () => {
              assert.strictEqual(tracer.scope().active(), span)
              done()
            })
          }

          request(http2, `http://localhost:${port}/user`).catch(done)
        })

        it('should not cause `end` to be called multiple times', done => {
          app = (req, res) => {
            res.end = sinon.spy(res.end)

            res.on('finish', () => {
              sinon.assert.calledOnce(res.end)
              done()
            })
          }

          request(http2, `http://localhost:${port}/user`).catch(done)
        })
      })

      describe('with a blocklist configuration', () => {
        beforeEach(() => {
          return agent.load('http2', { client: false, blocklist: '/health' })
            .then(() => {
              http2 = require(pluginToBeLoaded)
            })
        })

        beforeEach(done => {
          const server = http2.createServer(listener)
          appListener = server
            .listen(0, 'localhost', () => {
              port = appListener.address().port
              done()
            })
        })

        it('should drop traces for blocklist route', done => {
          const spy = sinon.spy(() => {})

          agent
            .assertSomeTraces((traces) => {
              spy()
            })
            .catch(done)

          setTimeout(() => {
            sinon.assert.notCalled(spy)
            done()
          }, 100)

          request(http2, `http://localhost:${port}/health`).catch(done)
        })
      })

      describe('with queryStringObfuscation', () => {
        describe('set to a regex pattern', () => {
          beforeEach(() => {
            return agent.load('http2', { client: false, queryStringObfuscation: 'secret=.*?(&|$)' })
              .then(() => {
                http2 = require(pluginToBeLoaded)
              })
          })

          beforeEach(done => {
            const server = http2.createServer(listener)
            appListener = server
              .listen(0, 'localhost', () => {
                port = appListener.address().port
                done()
              })
          })

          it('should obfuscate matching query string parameters', done => {
            agent
              .assertFirstTraceSpan({
                name: 'web.request',
                service: 'test',
                type: 'web',
                resource: 'GET',
                meta: {
                  'span.kind': 'server',
                  'http.url': `http://localhost:${port}/user?<redacted>foo=bar`,
                  'http.method': 'GET',
                  'http.status_code': '200',
                  component: 'http2',
                },
              })
              .then(done)
              .catch(done)

            request(http2, `http://localhost:${port}/user?secret=password&foo=bar`).catch(done)
          })
        })

        describe('set to true', () => {
          beforeEach(() => {
            return agent.load('http2', { client: false, queryStringObfuscation: true })
              .then(() => {
                http2 = require(pluginToBeLoaded)
              })
          })

          beforeEach(done => {
            const server = http2.createServer(listener)
            appListener = server
              .listen(0, 'localhost', () => {
                port = appListener.address().port
                done()
              })
          })

          it('should remove the entire query string', done => {
            agent
              .assertFirstTraceSpan({
                name: 'web.request',
                service: 'test',
                type: 'web',
                resource: 'GET',
                meta: {
                  'span.kind': 'server',
                  'http.url': `http://localhost:${port}/user`,
                  'http.method': 'GET',
                  'http.status_code': '200',
                  component: 'http2',
                },
              })
              .then(done)
              .catch(done)

            request(http2, `http://localhost:${port}/user?secret=password&foo=bar`).catch(done)
          })
        })

        describe('set to false', () => {
          beforeEach(() => {
            return agent.load('http2', { client: false, queryStringObfuscation: false })
              .then(() => {
                http2 = require(pluginToBeLoaded)
              })
          })

          beforeEach(done => {
            const server = http2.createServer(listener)
            appListener = server
              .listen(0, 'localhost', () => {
                port = appListener.address().port
                done()
              })
          })

          it('should not obfuscate the query string', done => {
            agent
              .assertFirstTraceSpan({
                name: 'web.request',
                service: 'test',
                type: 'web',
                resource: 'GET',
                meta: {
                  'span.kind': 'server',
                  'http.url': `http://localhost:${port}/user?secret=password&foo=bar`,
                  'http.method': 'GET',
                  'http.status_code': '200',
                  component: 'http2',
                },
              })
              .then(done)
              .catch(done)

            request(http2, `http://localhost:${port}/user?secret=password&foo=bar`).catch(done)
          })
        })
      })

      describe('core API', () => {
        beforeEach(() => {
          return agent.load('http2', { client: false })
            .then(() => {
              http2 = require(pluginToBeLoaded)
            })
        })

        function listen (server, done) {
          appListener = server.listen(0, 'localhost', () => {
            port = appListener.address().port
            done()
          })
        }

        describe('server.on(\'stream\')', () => {
          beforeEach(done => {
            const server = http2.createServer()
            server.on('stream', (stream) => {
              stream.respond({ ':status': 200 })
              stream.end()
            })
            listen(server, done)
          })

          it('should instrument the core stream API', done => {
            agent
              .assertFirstTraceSpan({
                name: 'web.request',
                service: 'test',
                type: 'web',
                resource: 'GET',
                meta: {
                  'span.kind': 'server',
                  'http.url': `http://localhost:${port}/user`,
                  'http.method': 'GET',
                  'http.status_code': '200',
                  component: 'http2',
                },
              })
              .then(done)
              .catch(done)

            request(http2, `http://localhost:${port}/user`).catch(done)
          })

          it('should produce exactly one server span per request', async () => {
            await assertSingleServerSpan(http2, `http://localhost:${port}/user`)
          })

          it('should run the stream\'s close event in the correct context', done => {
            const server = appListener
            server.removeAllListeners('stream')
            server.on('stream', (stream) => {
              const span = tracer.scope().active()
              stream.once('close', () => {
                assert.strictEqual(tracer.scope().active(), span)
                done()
              })
              stream.respond({ ':status': 200 })
              stream.end()
            })

            request(http2, `http://localhost:${port}/user`).catch(done)
          })

          it('reports status 200 for a stream aborted before it responded', done => {
            const server = appListener
            server.removeAllListeners('stream')
            server.on('stream', (stream) => {
              stream.on('error', () => {})
              // Close without responding: `stream.sentHeaders` stays empty, so the
              // adapter falls back to the compatibility default of 200 instead of
              // tagging the span as an error with no status.
              stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR)
            })

            agent
              .assertFirstTraceSpan({
                name: 'web.request',
                resource: 'GET',
                error: 0,
                meta: {
                  'span.kind': 'server',
                  'http.method': 'GET',
                  'http.status_code': '200',
                  component: 'http2',
                },
              })
              .then(done)
              .catch(done)

            request(http2, `http://localhost:${port}/user`).catch(() => {})
          })
        })

        describe('with configured headers', () => {
          beforeEach(() => {
            return agent.load('http2', { client: false, headers: ['x-foo', 'x-resp:resp_tag'] })
              .then(() => {
                http2 = require(pluginToBeLoaded)
              })
          })

          beforeEach(done => {
            const server = http2.createServer()
            server.on('stream', (stream) => {
              stream.respond({ ':status': 200, 'x-resp': 'sent' })
              stream.end()
            })
            listen(server, done)
          })

          it('tags configured request and response headers from the stream', done => {
            agent
              .assertFirstTraceSpan({
                name: 'web.request',
                meta: {
                  component: 'http2',
                  'http.request.headers.x-foo': 'bar',
                  resp_tag: 'sent',
                },
              })
              .then(done)
              .catch(done)

            const url = new URL(`http://localhost:${port}/user`)
            const client = http2.connect(url.origin).on('error', done)
            const req = client.request({ ':path': url.pathname, ':method': 'GET', 'x-foo': 'bar' })
            req.on('error', done)
            req.on('end', () => client.close())
            req.resume()
            req.end()
          })
        })

        describe('compatibility servers do not double-span', () => {
          /** @param {import('node:http2').Http2Server} server */
          function listenAsync (server) {
            return new Promise(resolve => listen(server, resolve))
          }

          it('createServer(handler) produces exactly one server span', async () => {
            const server = http2.createServer((req, res) => {
              res.writeHead(200)
              res.end()
            })
            await listenAsync(server)
            await assertSingleServerSpan(http2, `http://localhost:${port}/user`)
          })

          it('createServer().on(\'request\') produces exactly one server span', async () => {
            const server = http2.createServer()
            server.on('request', (req, res) => {
              res.writeHead(200)
              res.end()
            })
            await listenAsync(server)
            await assertSingleServerSpan(http2, `http://localhost:${port}/user`)
          })

          it('a server with both request and stream listeners produces exactly one server span', async () => {
            const server = http2.createServer((req, res) => {
              res.writeHead(200)
              res.end()
            })
            server.on('stream', () => {})
            await listenAsync(server)
            await assertSingleServerSpan(http2, `http://localhost:${port}/user`)
          })
        })
      })

      describe('core API distributed tracing', () => {
        beforeEach(() => {
          return agent.load('http2')
            .then(() => {
              http2 = require(pluginToBeLoaded)
            })
        })

        beforeEach(done => {
          const server = http2.createServer()
          server.on('stream', (stream) => {
            stream.respond({ ':status': 200 })
            stream.end()
          })
          appListener = server.listen(0, 'localhost', () => {
            port = appListener.address().port
            done()
          })
        })

        it('makes the core server span a child of the client span', async () => {
          const spans = []
          const collect = traces => spans.push(...traces.flat())
          agent.subscribe(collect)

          try {
            await request(http2, `http://localhost:${port}/user`)

            for (let drain = 0; drain < 5; drain++) await setImmediate()

            const clientSpan = spans.find(span => span.meta?.['span.kind'] === 'client')
            const serverSpan = spans.find(span => span.name === 'web.request')

            assert.ok(clientSpan, 'expected an http2 client span')
            assert.ok(serverSpan, 'expected a core-API server span')
            assert.strictEqual(serverSpan.trace_id.toString(), clientSpan.trace_id.toString())
            assert.strictEqual(serverSpan.parent_id.toString(), clientSpan.span_id.toString())
          } finally {
            agent.unsubscribe(collect)
          }
        })
      })
    })
  })
})

/**
 * Drive one request and assert the agent receives exactly one `web.request`
 * span for it. A compatibility server emits both 'request' and 'stream'; a
 * regression that drops the core-API request-listener gate produces a second
 * `web.request` span that flushes in a later payload, so the count accumulates
 * across every payload and is read only after the request has fully closed and
 * the flush turns have drained (`flushInterval` is 0 under the test agent).
 *
 * @param {typeof import('http2')} http2
 * @param {string} url
 */
async function assertSingleServerSpan (http2, url) {
  let serverSpanCount = 0
  const countHandler = traces => {
    serverSpanCount += traces.flat().filter(span => span.name === 'web.request').length
  }
  agent.subscribe(countHandler)

  try {
    await request(http2, url)

    // Let every flush for the request drain (flushInterval is 0, so each
    // finished trace chunk is sent on the next turns) before reading the count.
    for (let drain = 0; drain < 5; drain++) await setImmediate()

    assert.strictEqual(serverSpanCount, 1)
  } finally {
    agent.unsubscribe(countHandler)
  }
}
