'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')

const { EventEmitter } = require('node:events')

const { withNamingSchema } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const { rawExpectedSchema } = require('./naming')

class MockAbortController {
  constructor () {
    this.signal = new EventEmitter()
  }

  abort () {
    this.signal.emit('abort')
  }
}

function request (http2, url, { signal } = {}) {
  url = new URL(url)
  return new Promise((resolve, reject) => {
    const client = http2
      .connect(url.origin)
      .on('error', reject)

    const req = client.request({
      ':path': url.pathname,
      ':method': 'GET'
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
        beforeEach(() => {
          listener = (req, res) => {
            setTimeout(() => {
              app && app(req, res)
              res.writeHead(200)
              res.end()
            }, 500)
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

        it('should send traces to agent', (done) => {
          app = sinon.stub()
          agent
            .assertSomeTraces(traces => {
              expect(app).not.to.have.been.called // request should be cancelled before call to app
              expect(traces[0][0]).to.have.property('name', 'web.request')
              expect(traces[0][0]).to.have.property('service', 'test')
              expect(traces[0][0]).to.have.property('type', 'web')
              expect(traces[0][0]).to.have.property('resource', 'GET')
              expect(traces[0][0].meta).to.have.property('span.kind', 'server')
              expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
              expect(traces[0][0].meta).to.have.property('http.method', 'GET')
              expect(traces[0][0].meta).to.have.property('http.status_code', '200')
              expect(traces[0][0].meta).to.have.property('component', 'http2')
            })
            .then(done)
            .catch(done)

          // Don't use real AbortController because it requires 15.x+
          const ac = new MockAbortController()
          request(http2, `http://localhost:${port}/user`, {
            signal: ac.signal
          })
          setTimeout(() => { ac.abort() }, 100)
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
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('name', 'web.request')
              expect(traces[0][0]).to.have.property('service', 'test')
              expect(traces[0][0]).to.have.property('type', 'web')
              expect(traces[0][0]).to.have.property('resource', 'GET')
              expect(traces[0][0].meta).to.have.property('span.kind', 'server')
              expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
              expect(traces[0][0].meta).to.have.property('http.method', 'GET')
              expect(traces[0][0].meta).to.have.property('http.status_code', '200')
              expect(traces[0][0].meta).to.have.property('component', 'http2')
            })
            .then(done)
            .catch(done)

          request(http2, `http://localhost:${port}/user`).catch(done)
        })

        it('should run the request\'s close event in the correct context', done => {
          app = (req, res) => {
            req.on('close', () => {
              expect(tracer.scope().active()).to.equal(null)
              done()
            })
          }

          request(http2, `http://localhost:${port}/user`).catch(done)
        })

        it('should run the response\'s close event in the correct context', done => {
          app = (req, res) => {
            const span = tracer.scope().active()

            res.on('close', () => {
              expect(tracer.scope().active()).to.equal(span)
              done()
            })
          }

          request(http2, `http://localhost:${port}/user`).catch(done)
        })

        it('should run the finish event in the correct context', done => {
          app = (req, res) => {
            const span = tracer.scope().active()

            res.on('finish', () => {
              expect(tracer.scope().active()).to.equal(span)
              done()
            })
          }

          request(http2, `http://localhost:${port}/user`).catch(done)
        })

        it('should not cause `end` to be called multiple times', done => {
          app = (req, res) => {
            res.end = sinon.spy(res.end)

            res.on('finish', () => {
              expect(res.end).to.have.been.calledOnce
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
            expect(spy).to.not.have.been.called
            done()
          }, 100)

          request(http2, `http://localhost:${port}/health`).catch(done)
        })
      })
    })
  })
})
