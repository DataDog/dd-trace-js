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
      ':path': urlObj.pathname,
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
        return agent.close({ ritmReset: false })
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
            res.writeHead = function () {
              responseSent = true
              return writeHead.apply(this, arguments)
            }
            const end = res.end
            res.end = function () {
              responseSent = true
              return end.apply(this, arguments)
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
            sinon.assert.notCalled(app) // request should be cancelled before call to app

            assertObjectContains(traces[0][0], {
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
            .listen(port, 'localhost', () => done())
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
            .listen(port, 'localhost', () => done())
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
    })
  })
})
