'use strict'

const assert = require('node:assert/strict')

const axios = require('axios')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { incomingHttpRequestStart } = require('../../dd-trace/src/appsec/channels')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema } = require('../../dd-trace/test/setup/mocha')
const { rawExpectedSchema } = require('./naming')
describe('Plugin', () => {
  let http
  let listener
  let appListener
  let tracer
  let port
  let app
  let timeout

  ['http', 'node:http'].forEach(pluginToBeLoaded => {
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
        clearTimeout(timeout)
        timeout = null
        return agent.close({ ritmReset: false })
      })

      describe('canceled request', () => {
        beforeEach(() => {
          listener = (req, res) => {
            timeout = setTimeout(() => {
              app && app(req, res)
              res.writeHead(200)
              res.end()
            }, 500)
          }
        })

        beforeEach(() => {
          return agent.load('http')
            .then(() => {
              http = require(pluginToBeLoaded)
            })
        })

        beforeEach(done => {
          const server = new http.Server(listener)
          appListener = server
            .listen(0, 'localhost', () => {
              port = appListener.address().port
              done()
            })
        })

        it('should send traces to agent', (done) => {
          app = sinon.stub()
          agent
            .assertSomeTraces(traces => {
              sinon.assert.notCalled(app) // request should be cancelled before call to app
              assert.strictEqual(traces[0][0].name, 'web.request')
              assert.strictEqual(traces[0][0].service, 'test')
              assert.strictEqual(traces[0][0].type, 'web')
              assert.strictEqual(traces[0][0].resource, 'GET')
              assert.strictEqual(traces[0][0].meta['span.kind'], 'server')
              assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/user`)
              assert.strictEqual(traces[0][0].meta['http.method'], 'GET')
              assert.strictEqual(traces[0][0].meta['http.status_code'], '200')
              assert.strictEqual(traces[0][0].meta.component, 'http')
              assert.strictEqual(traces[0][0].meta['_dd.integration'], 'http')
            })
            .then(done)
            .catch(done)
          const source = axios.CancelToken.source()
          axios.get(`http://localhost:${port}/user`, { cancelToken: source.token })
            .then(() => {})
          setTimeout(() => { source.cancel() }, 100)
        })
      })

      describe('without configuration', () => {
        beforeEach(() => {
          return agent.load('http')
            .then(() => {
              http = require(pluginToBeLoaded)
            })
        })

        beforeEach(done => {
          const server = new http.Server(listener)
          appListener = server
            .listen(port, 'localhost', () => done())
        })

        withNamingSchema(
          done => {
            axios.get(`http://localhost:${port}/user`).catch(done)
          },
          rawExpectedSchema.server
        )

        it('should do automatic instrumentation', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].name, 'web.request')
              assert.strictEqual(traces[0][0].service, 'test')
              assert.strictEqual(traces[0][0].type, 'web')
              assert.strictEqual(traces[0][0].resource, 'GET')
              assert.strictEqual(traces[0][0].meta['span.kind'], 'server')
              assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/user`)
              assert.strictEqual(traces[0][0].meta['http.method'], 'GET')
              assert.strictEqual(traces[0][0].meta['http.status_code'], '200')
              assert.strictEqual(traces[0][0].meta.component, 'http')
            })
            .then(done)
            .catch(done)

          axios.get(`http://localhost:${port}/user`).catch(done)
        })

        it('should run the request listener in the request scope', done => {
          const spy = sinon.spy(() => {
            assert.notStrictEqual(tracer.scope().active(), null)
          })

          incomingHttpRequestStart.subscribe(spy)

          app = (req, res) => {
            assert.notStrictEqual(tracer.scope().active(), null)

            const abortController = new AbortController()
            sinon.assert.calledOnceWithExactly(spy, { req, res, abortController }, incomingHttpRequestStart.name)

            done()
          }

          axios.get(`http://localhost:${port}/user`).catch(done)
        })

        it('should run the request\'s close event in the correct context', done => {
          app = (req, res) => {
            req.on('close', () => {
              assert.strictEqual(tracer.scope().active(), null)
              done()
            })
          }

          axios.get(`http://localhost:${port}/user`).catch(done)
        })

        it('should run the response\'s close event in the correct context', done => {
          app = (req, res) => {
            const span = tracer.scope().active()

            res.on('close', () => {
              assert.strictEqual(tracer.scope().active(), span)
              done()
            })
          }

          axios.get(`http://localhost:${port}/user`).catch(done)
        })

        it('should run the finish event in the correct context', done => {
          app = (req, res) => {
            const span = tracer.scope().active()

            res.on('finish', () => {
              assert.strictEqual(tracer.scope().active(), span)
              done()
            })
          }

          axios.get(`http://localhost:${port}/user`).catch(done)
        })

        it('should not instrument manually instantiated server responses', () => {
          const { IncomingMessage, ServerResponse } = http

          const req = new IncomingMessage()
          const res = new ServerResponse(req)

          assert.doesNotThrow(() => res.emit('finish'))
        })

        it('should not cause `end` to be called multiple times', done => {
          app = (req, res) => {
            res.end = sinon.spy(res.end)

            res.on('finish', () => {
              sinon.assert.calledOnce(res.end)
              done()
            })
          }

          axios.get(`http://localhost:${port}/user`).catch(done)
        })
      })

      describe('with a `server` configuration', () => {
        beforeEach(() => {
          return agent.load('http', { client: false, server: {} })
            .then(() => {
              http = require(pluginToBeLoaded)
            })
        })

        beforeEach(done => {
          const server = new http.Server(listener)
          appListener = server
            .listen(port, 'localhost', () => done())
        })

        // see https://github.com/DataDog/dd-trace-js/issues/2453
        it('should not have disabled tracing', (done) => {
          agent.assertSomeTraces(() => {})
            .then(done)
            .catch(done)

          axios.get(`http://localhost:${port}/user`).catch(done)
        })
      })

      describe('with a blocklist configuration', () => {
        beforeEach(() => {
          return agent.load('http', { client: false, blocklist: '/health' })
            .then(() => {
              http = require(pluginToBeLoaded)
            })
        })

        beforeEach(done => {
          const server = new http.Server(listener)
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

          axios.get(`http://localhost:${port}/health`).catch(done)
        })
      })
    })
  })
})
