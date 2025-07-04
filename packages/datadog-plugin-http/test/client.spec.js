'use strict'

const { withNamingSchema, withPeerService } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const fs = require('fs')
const path = require('path')
const tags = require('../../../ext/tags')
const { expect } = require('chai')
const { storage } = require('../../datadog-core')
const key = fs.readFileSync(path.join(__dirname, './ssl/test.key'))
const cert = fs.readFileSync(path.join(__dirname, './ssl/test.crt'))
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { rawExpectedSchema } = require('./naming')
const { satisfies } = require('semver')

const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS
const NODE_MAJOR = parseInt(process.versions.node.split('.')[0])
const SERVICE_NAME = 'test'

describe('Plugin', () => {
  let express
  let http
  let appListener
  let tracer

  ['http', 'https', 'node:http', 'node:https'].forEach(pluginToBeLoaded => {
    const protocol = pluginToBeLoaded.split(':')[1] || pluginToBeLoaded
    describe(pluginToBeLoaded, () => {
      function server (app, listener) {
        let server
        if (pluginToBeLoaded === 'https') {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
          server = require('https').createServer({ key, cert }, app)
        } else if (pluginToBeLoaded === 'node:https') {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
          server = require('node:https').createServer({ key, cert }, app)
        } else if (pluginToBeLoaded === 'http') {
          server = require('http').createServer(app)
        } else {
          server = require('node:http').createServer(app)
        }
        server.listen(0, 'localhost', () => {
          listener(server.address().port)
        })
        return server
      }

      beforeEach(() => {
        tracer = require('../../dd-trace')
        appListener = null
      })

      afterEach(() => {
        if (appListener) {
          appListener.close()
        }
        return agent.close({ ritmReset: false })
      })

      describe('without configuration', () => {
        beforeEach(() => {
          return agent.load('http', { server: false })
            .then(() => {
              http = require(pluginToBeLoaded)
              express = require('express')
            })
        })

        const spanProducerFn = (done) => {
          const app = express()
          app.get('/user', (req, res) => {
            res.status(200).send()
          })
          appListener = server(app, () => {
            const port = appListener.address().port
            const req = http.request(`${protocol}://localhost:${port}/user`, res => {
              res.on('data', () => {})
            })
            req.end()
            done()
          })
        }

        withPeerService(
          () => tracer,
          'http',
          spanProducerFn,
          'localhost',
          'out.host'
        )

        withNamingSchema(
          (done) => spanProducerFn((err) => err && done(err)),
          rawExpectedSchema.client
        )

        it('should do automatic instrumentation', done => {
          const app = express()
          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('service', SERVICE_NAME)
                expect(traces[0][0]).to.have.property('type', 'http')
                expect(traces[0][0]).to.have.property('resource', 'GET')
                expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
                expect(traces[0][0].meta).to.have.property('http.method', 'GET')
                expect(traces[0][0].meta).to.have.property('http.status_code', '200')
                expect(traces[0][0].meta).to.have.property('component', 'http')
                expect(traces[0][0].meta).to.have.property('_dd.integration', 'http')
                expect(traces[0][0].meta).to.have.property('out.host', 'localhost')
              })
              .then(done)
              .catch(done)

            const req = http.request(`${protocol}://localhost:${port}/user`, res => {
              res.on('data', () => {})
            })

            req.end()
          })
        })

        it('should also support get()', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0].meta).to.have.property('http.status_code', '200')
              expect(traces[0][0]).to.not.be.undefined
            })
            .then(done)
            .catch(done)

          appListener = server(app, port => {
            const req = http.get(`${protocol}://localhost:${port}/user`, res => {
              res.on('data', () => {})
            })

            req.end()
          })
        })

        it('should support CONNECT', done => {
          const app = express()
          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('service', SERVICE_NAME)
                expect(traces[0][0]).to.have.property('type', 'http')
                expect(traces[0][0]).to.have.property('resource', 'CONNECT')
                expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
                expect(traces[0][0].meta).to.have.property('http.method', 'CONNECT')
                expect(traces[0][0].meta).to.have.property('http.status_code', '200')
                expect(traces[0][0].meta).to.have.property('component', 'http')
                expect(traces[0][0].meta).to.have.property('out.host', 'localhost')
              })
              .then(done)
              .catch(done)

            appListener.on('connect', (req, clientSocket, head) => {
              clientSocket.write('HTTP/1.1 200 Connection Established\r\n' +
                                  'Proxy-agent: Node.js-Proxy\r\n' +
                                  '\r\n')
              clientSocket.end()
              appListener.close()
            })

            const req = http.request({
              protocol: `${protocol}:`,
              port,
              method: 'CONNECT',
              hostname: 'localhost',
              path: '/user'
            })

            req.on('connect', (res, socket) => socket.end())
            req.on('error', () => {})
            req.end()
          })
        })

        it('should support connection upgrades', done => {
          const app = express()
          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('service', SERVICE_NAME)
                expect(traces[0][0]).to.have.property('type', 'http')
                expect(traces[0][0]).to.have.property('resource', 'GET')
                expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
                expect(traces[0][0].meta).to.have.property('http.method', 'GET')
                expect(traces[0][0].meta).to.have.property('http.status_code', '101')
                expect(traces[0][0].meta).to.have.property('component', 'http')
              })
              .then(done)
              .catch(done)

            appListener.on('upgrade', (req, socket, head) => {
              socket.write('HTTP/1.1 101 Web Socket Protocol Handshake\r\n' +
                             'Upgrade: WebSocket\r\n' +
                             'Connection: Upgrade\r\n' +
                             '\r\n')
              socket.pipe(socket)
            })

            const req = http.request({
              protocol: `${protocol}:`,
              port,
              hostname: 'localhost',
              path: '/user',
              headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket'
              }
            })

            req.on('upgrade', (res, socket) => socket.end())
            req.on('error', () => {})
            req.end()
          })
        })

        it('should support configuration as an URL object', done => {
          const app = express()
          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
              })
              .then(done)
              .catch(done)

            const uri = {
              protocol: `${protocol}:`,
              hostname: 'localhost',
              port,
              path: '/user'
            }
            const req = http.request(uri)

            req.end()
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
                expect(traces[0][0].meta).to.have.property('http.status_code', '200')
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
              })
              .then(done)
              .catch(done)

            const req = http.request(`${protocol}://localhost:${port}/user?foo=bar`, res => {
              res.on('data', () => {})
            })

            req.end()
          })
        })

        // Merging no longer happens since Node 20
        if (NODE_MAJOR < 20) {
          it('should support a string URL and an options object, which merges and takes precedence', done => {
            const app = express()

            app.get('/user', (req, res) => {
              res.status(200).send()
            })

            appListener = server(app, port => {
              agent
                .assertSomeTraces(traces => {
                  expect(traces[0][0].meta).to.have.property('http.status_code', '200')
                  expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
                })
                .then(done)
                .catch(done)

              const req = http.request(`${protocol}://localhost:${port}/another-path`, { path: '/user' })

              req.end()
            })
          })
        }

        it('should support a URL object and an options object, which merges and takes precedence', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0].meta).to.have.property('http.status_code', '200')
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
              })
              .then(done)
              .catch(done)

            const uri = {
              protocol: `${protocol}:`,
              hostname: 'localhost',
              port,
              pathname: '/another-path'
            }
            const req = http.request(uri, { path: '/user' })

            req.end()
          })
        })

        it('should support configuration as an WHATWG URL object', done => {
          const app = express()

          appListener = server(app, port => {
            const url = new URL(`${protocol}://localhost:${port}/user`)

            app.get('/user', (req, res) => res.status(200).send())

            agent.assertSomeTraces(traces => {
              expect(traces[0][0].meta).to.have.property('http.status_code', '200')
              expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
            }).then(done, done)

            const req = http.request(url)
            req.end()
          })
        })

        it('should use the correct defaults when not specified', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/`)
              })
              .then(done)
              .catch(done)

            const req = http.request({
              protocol: `${protocol}:`,
              port
            })

            req.end()
          })
        })

        it('should not require consuming the data', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.not.be.undefined
            })
            .then(done)
            .catch(done)

          appListener = server(app, port => {
            const req = http.request(`${protocol}://localhost:${port}/user`)

            req.end()
          })
        })

        it('should wait for other listeners before resuming the response stream', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send('OK')
          })

          appListener = server(app, port => {
            const req = http.request(`${protocol}://localhost:${port}/user`, res => {
              setTimeout(() => {
                expect(res.listenerCount('error')).to.equal(0)
                res.on('data', () => done())
              })
            })

            req.end()
          })
        })

        it('should inject its parent span in the headers', done => {
          const app = express()

          app.get('/user', (req, res) => {
            expect(req.get('x-datadog-trace-id')).to.be.a('string')
            expect(req.get('x-datadog-parent-id')).to.be.a('string')

            res.status(200).send()
          })

          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0].meta).to.have.property('http.status_code', '200')
            })
            .then(done)
            .catch(done)

          appListener = server(app, port => {
            const req = http.request(`${protocol}://localhost:${port}/user`)

            req.end()
          })
        })

        it('should inject tracing header into request without mutating the header', done => {
          // ensures that the tracer clones request headers instead of mutating.
          // Fixes aws-sdk InvalidSignatureException, more info:
          // https://github.com/open-telemetry/opentelemetry-js-contrib/issues/1609#issuecomment-1826167348

          const app = express()

          const originalHeaders = {
            Authorization: 'AWS4-HMAC-SHA256 ...'
          }

          app.get('/', (req, res) => {
            try {
              expect(req.get('x-datadog-trace-id')).to.be.a('string')
              expect(req.get('x-datadog-parent-id')).to.be.a('string')

              expect(originalHeaders['x-datadog-trace-id']).to.be.undefined
              expect(originalHeaders['x-datadog-parent-id']).to.be.undefined

              res.status(200).send()

              done()
            } catch (e) {
              done(e)
            }
          })

          appListener = server(app, port => {
            const req = http.request({
              port,
              headers: originalHeaders
            })

            req.end()
          })
        })

        it('should run the callback in the parent context', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send('OK')
          })

          appListener = server(app, port => {
            const req = http.request(`${protocol}://localhost:${port}/user`, res => {
              expect(tracer.scope().active()).to.be.null
              done()
            })

            req.end()
          })
        })

        it('should run the event listeners in the parent context', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send('OK')
          })

          appListener = server(app, port => {
            const req = http.request(`${protocol}://localhost:${port}/user`, res => {
              const span = tracer.scope().active()

              res.on('data', () => {})
              res.on('end', () => {
                expect(tracer.scope().active()).to.equal(span)
                done()
              })
            })

            req.end()
          })
        })

        it('should run the response event in the request context', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send('OK')
          })

          appListener = server(app, port => {
            const req = http.request(`${protocol}://localhost:${port}/user`, () => {})

            req.on('response', () => {
              expect(tracer.scope().active()).to.not.be.null
              done()
            })

            req.end()
          })
        })

        it('should handle connection errors', done => {
          let error

          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message || error.code)
              expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
              expect(traces[0][0].meta).to.have.property('component', 'http')
            })
            .then(done)
            .catch(done)

          const req = http.request(`${protocol}://localhost:7357/user`)

          req.on('error', err => {
            error = err
          })

          req.end()
        })

        it('should not record HTTP 5XX responses as errors by default', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(500).send()
          })

          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('error', 0)
            })
            .then(done)
            .catch(done)

          appListener = server(app, port => {
            const req = http.request(`${protocol}://localhost:${port}/user`, res => {
              res.on('data', () => { })
            })

            req.end()
          })
        })

        it('should record HTTP 4XX responses as errors by default', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(400).send()
          })

          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('error', 1)
            })
            .then(done)
            .catch(done)

          appListener = server(app, port => {
            const req = http.request(`${protocol}://localhost:${port}/user`, res => {
              res.on('data', () => { })
            })

            req.end()
          })
        })

        it('should record destroyed requests as errors', done => {
          const app = express()

          app.get('/user', (req, res) => {})

          let error

          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('error', 1)
              expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
              expect(traces[0][0].meta).to.not.have.property('http.status_code')
              expect(traces[0][0].meta).to.have.property('component', 'http')
            })
            .then(done)
            .catch(done)

          appListener = server(app, port => {
            const req = http.request(`${protocol}://localhost:${port}/user`, res => {
              res.on('data', () => { })
            })

            req.on('error', err => {
              error = err
            })

            req.destroy()
          })
        })

        it('should not record aborted requests as errors', done => {
          const app = express()

          app.get('/user', (req, res) => {})

          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('error', 0)
              expect(traces[0][0].meta).to.not.have.property('http.status_code')
            })
            .then(done)
            .catch(done)

          appListener = server(app, port => {
            const req = http.request(`${protocol}://localhost:${port}/user`, res => {
              res.on('data', () => { })
            })

            req.on('abort', () => {})

            req.abort()
          })
        })

        it('should record timeouts as errors', done => {
          const app = express()

          app.get('/user', (req, res) => {})

          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('error', 1)
              expect(traces[0][0].meta).to.not.have.property('http.status_code')
            })
            .then(done)
            .catch(done)

          appListener = server(app, port => {
            const req = http.request(`${protocol}://localhost:${port}/user`, res => {
              res.on('data', () => { })
            })

            req.on('error', () => {})

            req.setTimeout(1)
            req.end()
          })
        })

        if (satisfies(process.version, '>=20')) {
          it('should not record default HTTP agent timeout as error with Node 20', done => {
            const app = express()

            app.get('/user', async (req, res) => {
              await new Promise(resolve => {
                setTimeout(resolve, 6 * 1000) // over 5s default
              })
              res.status(200).send()
            })

            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('error', 0)
              })
              .then(done)
              .catch(done)

            appListener = server(app, port => {
              const req = http.request(`${protocol}://localhost:${port}/user`, res => {
                res.on('data', () => { })
              })

              req.on('error', () => {})

              req.end()
            })
          }).timeout(10000)

          it('should record error if custom Agent timeout is used with Node 20', done => {
            const app = express()

            app.get('/user', async (req, res) => {
              await new Promise(resolve => {
                setTimeout(resolve, 6 * 1000)
              })
              res.status(200).send()
            })

            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('error', 1)
              })
              .then(done)
              .catch(done)

            const options = {
              agent: new http.Agent({ keepAlive: true, timeout: 5000 }) // custom agent with same default timeout
            }

            appListener = server(app, port => {
              const req = http.request(`${protocol}://localhost:${port}/user`, options, res => {
                res.on('data', () => { })
              })

              req.on('error', () => {})

              req.end()
            })
          }).timeout(10000)

          it('should record error if req.setTimeout is used with Node 20', done => {
            const app = express()

            app.get('/user', async (req, res) => {
              await new Promise(resolve => {
                setTimeout(resolve, 6 * 1000)
              })
              res.status(200).send()
            })

            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('error', 1)
              })
              .then(done)
              .catch(done)

            appListener = server(app, port => {
              const req = http.request(`${protocol}://localhost:${port}/user`, res => {
                res.on('data', () => { })
              })

              req.on('error', () => {})
              req.setTimeout(5000) // match default timeout

              req.end()
            })
          }).timeout(10000)
        }

        it('should only record a request once', done => {
          // Make sure both plugins are loaded, which could cause double-counting.
          if (pluginToBeLoaded.includes('node:')) {
            require('node:http')
            require('node:https')
          } else {
            require('http')
            require('https')
          }

          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          agent
            .assertSomeTraces(traces => {
              const spans = traces[0]
              expect(spans.length).to.equal(3)
            })
            .then(done)
            .catch(done)

          appListener = server(app, port => {
            // Activate a new parent span so we capture any double counting that may happen, otherwise double-counts
            // would be siblings and our test would only capture 1 as a false positive.
            const span = tracer.startSpan('http-test')
            tracer.scope().activate(span, () => {
              // Test `http(s).request
              const req = http.request(`${protocol}://localhost:${port}/user?test=request`, res => {
                res.on('data', () => {})
              })
              req.end()

              // Test `http(s).get`
              http.get(`${protocol}://localhost:${port}/user?test=get`, res => {
                res.on('data', () => {})
              })

              span.finish()
            })
          })
        })

        it('should record when the request was aborted', done => {
          const app = express()

          app.get('/abort', (req, res) => {
            res.status(200).send()
          })

          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('service', SERVICE_NAME)
            })
            .then(done)
            .catch(done)

          appListener = server(app, port => {
            const req = http.request(`${protocol}://localhost:${port}/abort`)

            req.abort()
          })
        })

        it('should use the correct fallback protocol', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0].meta).to.have.property('http.status_code', '200')
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
              })
              .then(done)
              .catch(done)

            const req = http.request({
              hostname: 'localhost',
              port,
              path: '/user?foo=bar'
            }, res => {
              res.on('data', () => {})
            })

            req.end()
          })
        })

        it('should not update the span after the request is finished', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][1]).to.have.property('error', 0)
                expect(traces[0][1].meta).to.have.property('http.status_code', '200')
                expect(traces[0][1].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
              })
              .then(done)
              .catch(done)

            tracer.trace('test.request', (span, finish) => {
              const req = http.request(`${protocol}://localhost:${port}/user`, res => {
                res.on('data', () => {})
                res.on('end', () => {
                  setTimeout(finish)
                })
              })

              req.end()
            })
          })
        })

        if (protocol === 'http') {
          it('should skip requests marked as noop', done => {
            const app = express()

            app.get('/user', (req, res) => {
              res.status(200).send()
            })

            const timer = setTimeout(done, 100)

            agent
              .assertSomeTraces(() => {
                done(new Error('Noop request was traced.'))
                clearTimeout(timer)
              })

            appListener = server(app, port => {
              const store = storage('legacy').getStore()

              storage('legacy').enterWith({ noop: true })
              const req = http.request(tracer._tracer._url.href)

              req.on('error', () => {})
              req.end()

              storage('legacy').enterWith(store)
            })
          })
        }

        it('should record unfinished http requests as error spans', done => {
          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('error', 1)
              expect(traces[0][0].meta).to.not.have.property('http.status_code')
            })
            .then(done)
            .catch(done)

          try {
            http.request('http://httpbin.org/get', { headers: { BadHeader: 'a\nb' } }, res => {
              res.on('data', () => { })
            })
          } catch {
            // expected to throw error
          }
        })
      })

      describe('with late plugin initialization and an external subscriber', () => {
        let ch
        let sub

        beforeEach(() => {
          return agent.load('http', { server: false })
            .then(() => {
              ch = require('dc-polyfill').channel('apm:http:client:request:start')
              sub = () => {}
              tracer = require('../../dd-trace')
              http = require(pluginToBeLoaded)
            })
        })

        afterEach(() => {
          ch.unsubscribe(sub)
        })

        it('should not crash', done => {
          const app = (req, res) => {
            res.end()
          }

          appListener = server(app, port => {
            ch.subscribe(sub)

            tracer.use('http', false)

            const req = http.request(`${protocol}://localhost:${port}`, res => {
              res.on('error', done)
              res.on('data', () => {})
              res.on('end', () => done())
            })
            req.on('error', done)

            tracer.use('http', true)

            req.end()
          })
        })
      })

      describe('with service configuration', () => {
        let config

        beforeEach(() => {
          config = {
            server: false,
            client: {
              service: 'custom'
            }
          }

          return agent.load('http', config)
            .then(() => {
              http = require(pluginToBeLoaded)
              express = require('express')
            })
        })

        it('should be configured with the correct values', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('service', 'custom')
            })
            .then(done)
            .catch(done)

          appListener = server(app, port => {
            const req = http.request(`${protocol}://localhost:${port}/user`, res => {
              res.on('data', () => {})
            })

            req.end()
          })
        })
      })

      describe('with validateStatus configuration', () => {
        let config

        beforeEach(() => {
          config = {
            server: false,
            client: {
              validateStatus: status => status < 500
            }
          }

          return agent.load('http', config)
            .then(() => {
              http = require(pluginToBeLoaded)
              express = require('express')
            })
        })

        it('should use the supplied function to decide if a response is an error', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(500).send()
          })

          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('error', 1)
            })
            .then(done)
            .catch(done)

          appListener = server(app, port => {
            const req = http.request(`${protocol}://localhost:${port}/user`, res => {
              res.on('data', () => { })
            })

            req.end()
          })
        })
      })

      describe('with splitByDomain configuration', () => {
        let config
        let serverPort

        beforeEach(() => {
          config = {
            server: false,
            client: {
              splitByDomain: true
            }
          }

          return agent.load('http', config)
            .then(() => {
              http = require(pluginToBeLoaded)
              express = require('express')
            })
        })

        withNamingSchema(
          () => {
            const app = express()
            app.get('/user', (req, res) => {
              res.status(200).send()
            })
            appListener = server(app, port => {
              serverPort = port
              const req = http.request(`${protocol}://localhost:${port}/user`, res => {
                res.on('data', () => {})
              })
              req.end()
            })
          },
          {
            v0: {
              serviceName: () => `localhost:${serverPort}`,
              opName: 'http.request'
            },
            v1: {
              serviceName: () => `localhost:${serverPort}`,
              opName: 'http.client.request'
            }
          }
        )

        it('should use the remote endpoint as the service name', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('service', `localhost:${port}`)
              })
              .then(done)
              .catch(done)

            const req = http.request(`${protocol}://localhost:${port}/user`, res => {
              res.on('data', () => {})
            })

            req.end()
          })
        })
      })

      describe('with headers configuration', () => {
        let config

        beforeEach(() => {
          config = {
            server: false,
            client: {
              headers: ['host', 'x-foo', 'x-bar:http.bar', 'x-baz:http.baz']
            }
          }

          return agent.load('http', config)
            .then(() => {
              http = require(pluginToBeLoaded)
              express = require('express')
            })
        })

        it('should add tags for the configured headers', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.setHeader('x-foo', 'foo')
            res.setHeader('x-bar', 'bar')
            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                const meta = traces[0][0].meta

                expect(meta).to.have.property(`${HTTP_REQUEST_HEADERS}.host`, `localhost:${port}`)
                expect(meta).to.have.property('http.baz', 'baz')
                expect(meta).to.have.property(`${HTTP_RESPONSE_HEADERS}.x-foo`, 'foo')
                expect(meta).to.have.property('http.bar', 'bar')
              })
              .then(done)
              .catch(done)

            const url = `${protocol}://localhost:${port}/user`
            const headers = { 'x-baz': 'baz' }
            const req = http.request(url, { headers }, res => {
              res.on('data', () => {})
            })

            req.end()
          })
        })

        it('should support adding request headers', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          agent
            .assertSomeTraces(traces => {
              const meta = traces[0][0].meta

              expect(meta).to.have.property(`${HTTP_REQUEST_HEADERS}.x-foo`, 'bar')
            })
            .then(done)
            .catch(done)

          appListener = server(app, port => {
            const req = http.request(`${protocol}://localhost:${port}/user`, res => {
              res.on('data', () => {})
            })

            req.setHeader('x-foo', 'bar')
            req.end()
          })
        })

        it('should support adding request headers when header set as an array', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          agent
            .assertSomeTraces(traces => {
              const meta = traces[0][0].meta

              expect(meta).to.have.property(`${HTTP_REQUEST_HEADERS}.x-foo`, 'bar1,bar2')
            })
            .then(done)
            .catch(done)

          appListener = server(app, port => {
            const req = http.request(`${protocol}://localhost:${port}/user`, res => {
              res.on('data', () => { })
            })

            req.setHeader('x-foo', ['bar1', 'bar2'])
            req.end()
          })
        })
      })

      describe('with hooks configuration', () => {
        let config

        beforeEach(() => {
          config = {
            server: false,
            client: {
              hooks: {
                request: (span, req, res) => {
                  span.setTag('resource.name', `${req.method} ${req._route}`)
                }
              }
            }
          }

          return agent.load('http', config)
            .then(() => {
              http = require(pluginToBeLoaded)
              express = require('express')
            })
        })

        it('should run the request hook before the span is finished', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0]).to.have.property('resource', 'GET /user')
            })
            .then(done)
            .catch(done)

          appListener = server(app, port => {
            const req = http.request(`${protocol}://localhost:${port}/user`, res => {
              res.on('data', () => {})
            })

            req._route = '/user'

            req.end()
          })
        })
      })

      describe('with propagationBlocklist configuration', () => {
        let config

        beforeEach(() => {
          config = {
            server: false,
            client: {
              propagationBlocklist: [/\/users/]
            }
          }

          return agent.load('http', config)
            .then(() => {
              http = require(pluginToBeLoaded)
              express = require('express')
            })
        })

        it('should skip injecting if the url matches an item in the propagationBlacklist', done => {
          const app = express()

          app.get('/users', (req, res) => {
            try {
              expect(req.get('x-datadog-trace-id')).to.be.undefined
              expect(req.get('x-datadog-parent-id')).to.be.undefined

              res.status(200).send()

              done()
            } catch (e) {
              done(e)
            }
          })

          appListener = server(app, port => {
            const req = http.request({
              port,
              path: '/users'
            })

            req.end()
          })
        })
      })

      describe('with blocklist configuration', () => {
        let config

        beforeEach(() => {
          config = {
            server: false,
            client: {
              blocklist: [/\/user/]
            }
          }

          return agent.load('http', config)
            .then(() => {
              http = require(pluginToBeLoaded)
              express = require('express')
            })
        })

        it('should skip recording if the url matches an item in the blocklist', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          const timer = setTimeout(done, 100)

          agent
            .assertSomeTraces(() => {
              clearTimeout(timer)
              done(new Error('Blocklisted requests should not be recorded.'))
            })
            .catch(done)

          appListener = server(app, port => {
            const req = http.request(`${protocol}://localhost:${port}/user`, res => {
              res.on('data', () => {})
            })

            req.end()
          })
        })
      })
    })
  })
})
