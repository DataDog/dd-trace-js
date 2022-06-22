'use strict'

const getPort = require('get-port')
const agent = require('../../dd-trace/test/plugins/agent')
const fs = require('fs')
const path = require('path')
const tags = require('../../../ext/tags')
const { expect } = require('chai')
const { storage } = require('../../datadog-core')
const key = fs.readFileSync(path.join(__dirname, './ssl/test.key'))
const cert = fs.readFileSync(path.join(__dirname, './ssl/test.crt'))

const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS

describe('Plugin', () => {
  let express
  let http
  let appListener
  let tracer

  ['http', 'https'].forEach(protocol => {
    describe(protocol, () => {
      function server (app, port, listener) {
        let server
        if (protocol === 'https') {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
          server = require('https').createServer({ key, cert }, app)
        } else {
          server = require('http').createServer(app)
        }
        server.listen(port, 'localhost', listener)
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
              http = require(protocol)
              express = require('express')
            })
        })

        it('should do automatic instrumentation', done => {
          const app = express()
          app.get('/user', (req, res) => {
            res.status(200).send()
          })
          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('service', 'test-http-client')
                expect(traces[0][0]).to.have.property('type', 'http')
                expect(traces[0][0]).to.have.property('resource', 'GET')
                expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
                expect(traces[0][0].meta).to.have.property('http.method', 'GET')
                expect(traces[0][0].meta).to.have.property('http.status_code', '200')
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const req = http.request(`${protocol}://localhost:${port}/user`, res => {
                res.on('data', () => {})
              })

              req.end()
            })
          })
        })

        it(`should also support get()`, done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0].meta).to.have.property('http.status_code', '200')
                expect(traces[0][0]).to.not.be.undefined
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const req = http.get(`${protocol}://localhost:${port}/user`, res => {
                res.on('data', () => {})
              })

              req.end()
            })
          })
        })

        it('should support CONNECT', done => {
          const app = express()
          app.get('/user', (req, res) => {
            res.status(200).send()
          })
          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('service', 'test-http-client')
                expect(traces[0][0]).to.have.property('type', 'http')
                expect(traces[0][0]).to.have.property('resource', 'CONNECT')
                expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
                expect(traces[0][0].meta).to.have.property('http.method', 'CONNECT')
                expect(traces[0][0].meta).to.have.property('http.status_code', '200')
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
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
        })

        it('should support connection upgrades', done => {
          const app = express()
          app.get('/user', (req, res) => {
            res.status(200).send()
          })
          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('service', 'test-http-client')
                expect(traces[0][0]).to.have.property('type', 'http')
                expect(traces[0][0]).to.have.property('resource', 'GET')
                expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
                expect(traces[0][0].meta).to.have.property('http.method', 'GET')
                expect(traces[0][0].meta).to.have.property('http.status_code', '101')
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
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
                  'Connection': 'Upgrade',
                  'Upgrade': 'websocket'
                }
              })

              req.on('upgrade', (res, socket) => socket.end())
              req.on('error', () => {})
              req.end()
            })
          })
        })

        it('should support configuration as an URL object', done => {
          const app = express()
          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
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

            appListener = server(app, port, () => {
              const req = http.request(uri)

              req.end()
            })
          })
        })

        it('should remove the query string from the URL', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0].meta).to.have.property('http.status_code', '200')
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const req = http.request(`${protocol}://localhost:${port}/user?foo=bar`, res => {
                res.on('data', () => {})
              })

              req.end()
            })
          })
        })

        it('should support a string URL and an options object, which merges and takes precedence', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0].meta).to.have.property('http.status_code', '200')
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const req = http.request(`${protocol}://localhost:${port}/another-path`, { path: '/user' })

              req.end()
            })
          })
        })

        it('should support a URL object and an options object, which merges and takes precedence', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
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

            appListener = server(app, port, () => {
              const req = http.request(uri, { path: '/user' })

              req.end()
            })
          })
        })

        it('should support configuration as an WHATWG URL object', async () => {
          const app = express()
          const port = await getPort()
          const url = new URL(`${protocol}://localhost:${port}/user`)

          app.get('/user', (req, res) => res.status(200).send())

          appListener = server(app, port, () => {
            const req = http.request(url)
            req.end()
          })

          await agent.use(traces => {
            expect(traces[0][0].meta).to.have.property('http.status_code', '200')
            expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
          })
        })

        it('should use the correct defaults when not specified', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/`)
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const req = http.request({
                protocol: `${protocol}:`,
                port
              })

              req.end()
            })
          })
        })

        it('should not require consuming the data', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.not.be.undefined
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const req = http.request(`${protocol}://localhost:${port}/user`)

              req.end()
            })
          })
        })

        it('should wait for other listeners before resuming the response stream', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send('OK')
          })

          getPort().then(port => {
            appListener = server(app, port, () => {
              const req = http.request(`${protocol}://localhost:${port}/user`, res => {
                setTimeout(() => {
                  res.on('data', () => done())
                })
              })

              req.end()
            })
          })
        })

        it('should inject its parent span in the headers', done => {
          const app = express()

          app.get('/user', (req, res) => {
            expect(req.get('x-datadog-trace-id')).to.be.a('string')
            expect(req.get('x-datadog-parent-id')).to.be.a('string')

            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0].meta).to.have.property('http.status_code', '200')
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const req = http.request(`${protocol}://localhost:${port}/user`)

              req.end()
            })
          })
        })

        it('should skip injecting if the Authorization header contains an AWS signature', done => {
          const app = express()

          app.get('/', (req, res) => {
            try {
              expect(req.get('x-datadog-trace-id')).to.be.undefined
              expect(req.get('x-datadog-parent-id')).to.be.undefined

              res.status(200).send()

              done()
            } catch (e) {
              done(e)
            }
          })

          getPort().then(port => {
            appListener = server(app, port, () => {
              const req = http.request({
                port,
                headers: {
                  Authorization: 'AWS4-HMAC-SHA256 ...'
                }
              })

              req.end()
            })
          })
        })

        it('should skip injecting if one of the Authorization headers contains an AWS signature', done => {
          const app = express()

          app.get('/', (req, res) => {
            try {
              expect(req.get('x-datadog-trace-id')).to.be.undefined
              expect(req.get('x-datadog-parent-id')).to.be.undefined

              res.status(200).send()

              done()
            } catch (e) {
              done(e)
            }
          })

          getPort().then(port => {
            appListener = server(app, port, () => {
              const req = http.request({
                port,
                headers: {
                  Authorization: ['AWS4-HMAC-SHA256 ...']
                }
              })

              req.end()
            })
          })
        })

        it('should skip injecting if the X-Amz-Signature header is set', done => {
          const app = express()

          app.get('/', (req, res) => {
            try {
              expect(req.get('x-datadog-trace-id')).to.be.undefined
              expect(req.get('x-datadog-parent-id')).to.be.undefined

              res.status(200).send()

              done()
            } catch (e) {
              done(e)
            }
          })

          getPort().then(port => {
            appListener = server(app, port, () => {
              const req = http.request({
                port,
                headers: {
                  'X-Amz-Signature': 'abc123'
                }
              })

              req.end()
            })
          })
        })

        it('should skip injecting if the X-Amz-Signature query param is set', done => {
          const app = express()

          app.get('/', (req, res) => {
            try {
              expect(req.get('x-datadog-trace-id')).to.be.undefined
              expect(req.get('x-datadog-parent-id')).to.be.undefined

              res.status(200).send()

              done()
            } catch (e) {
              done(e)
            }
          })

          getPort().then(port => {
            appListener = server(app, port, () => {
              const req = http.request({
                port,
                path: '/?X-Amz-Signature=abc123'
              })

              req.end()
            })
          })
        })

        it('should run the callback in the parent context', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send('OK')
          })
          getPort().then(port => {
            appListener = server(app, port, () => {
              const req = http.request(`${protocol}://localhost:${port}/user`, res => {
                expect(tracer.scope().active()).to.be.null
                done()
              })

              req.end()
            })
          })
        })

        it('should run the event listeners in the parent context', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send('OK')
          })

          getPort().then(port => {
            appListener = server(app, port, () => {
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
        })

        it('should run the response event in the request context', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send('OK')
          })

          getPort().then(port => {
            appListener = server(app, port, () => {
              const req = http.request(`${protocol}://localhost:${port}/user`, () => {})

              req.on('response', () => {
                expect(tracer.scope().active()).to.not.be.null
                done()
              })

              req.end()
            })
          })
        })

        it('should handle connection errors', done => {
          getPort().then(port => {
            let error

            agent
              .use(traces => {
                expect(traces[0][0].meta).to.have.property('error.type', error.name)
                expect(traces[0][0].meta).to.have.property('error.msg', error.message)
                expect(traces[0][0].meta).to.have.property('error.stack', error.stack)
              })
              .then(done)
              .catch(done)

            const req = http.request(`${protocol}://localhost:${port}/user`)

            req.on('error', err => {
              error = err
            })

            req.end()
          })
        })

        it('should not record HTTP 5XX responses as errors by default', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(500).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('error', 0)
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const req = http.request(`${protocol}://localhost:${port}/user`, res => {
                res.on('data', () => { })
              })

              req.end()
            })
          })
        })

        it('should record HTTP 4XX responses as errors by default', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(400).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('error', 1)
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const req = http.request(`${protocol}://localhost:${port}/user`, res => {
                res.on('data', () => { })
              })

              req.end()
            })
          })
        })

        it('should record destroyed requests as errors', done => {
          const app = express()

          app.get('/user', (req, res) => {})

          getPort().then(port => {
            let error

            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('error', 1)
                expect(traces[0][0].meta).to.have.property('error.msg', error.message)
                expect(traces[0][0].meta).to.have.property('error.type', error.name)
                expect(traces[0][0].meta).to.have.property('error.stack', error.stack)
                expect(traces[0][0].meta).to.not.have.property('http.status_code')
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const req = http.request(`${protocol}://localhost:${port}/user`, res => {
                res.on('data', () => { })
              })

              req.on('error', err => {
                error = err
              })

              req.destroy()
            })
          })
        })

        it('should not record aborted requests as errors', done => {
          const app = express()

          app.get('/user', (req, res) => {})

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('error', 0)
                expect(traces[0][0].meta).to.not.have.property('http.status_code')
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const req = http.request(`${protocol}://localhost:${port}/user`, res => {
                res.on('data', () => { })
              })

              req.on('abort', () => {})

              req.abort()
            })
          })
        })

        it('should record timeouts as errors', done => {
          const app = express()

          app.get('/user', (req, res) => {})

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('error', 1)
                expect(traces[0][0].meta).to.not.have.property('http.status_code')
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const req = http.request(`${protocol}://localhost:${port}/user`, res => {
                res.on('data', () => { })
              })

              req.on('error', () => {})

              req.setTimeout(1)
              req.end()
            })
          })
        })

        it('should only record a request once', done => {
          // Make sure both plugins are loaded, which could cause double-counting.
          require('http')
          require('https')

          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = traces[0]
                expect(spans.length).to.equal(3)
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
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
        })

        it('should record when the request was aborted', done => {
          const app = express()

          app.get('/abort', (req, res) => {
            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('service', 'test-http-client')
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const req = http.request(`${protocol}://localhost:${port}/abort`)

              req.abort()
            })
          })
        })

        it('should use the correct fallback protocol', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0].meta).to.have.property('http.status_code', '200')
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
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
        })

        it('should not update the span after the request is finished', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][1]).to.have.property('error', 0)
                expect(traces[0][1].meta).to.have.property('http.status_code', '200')
                expect(traces[0][1].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
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
        })

        if (protocol === 'http') {
          it('should skip requests marked as noop', done => {
            const app = express()

            app.get('/user', (req, res) => {
              res.status(200).send()
            })

            getPort().then(port => {
              const timer = setTimeout(done, 100)

              agent
                .use(() => {
                  done(new Error('Noop request was traced.'))
                  clearTimeout(timer)
                })

              appListener = server(app, port, () => {
                const store = storage.getStore()

                storage.enterWith({ noop: true })
                const req = http.request(tracer._tracer._url.href)

                req.on('error', () => {})
                req.end()

                storage.enterWith(store)
              })
            })
          })
        }
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
              http = require(protocol)
              express = require('express')
            })
        })

        it('should be configured with the correct values', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('service', 'custom')
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const req = http.request(`${protocol}://localhost:${port}/user`, res => {
                res.on('data', () => {})
              })

              req.end()
            })
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
              http = require(protocol)
              express = require('express')
            })
        })

        it('should use the supplied function to decide if a response is an error', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(500).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('error', 1)
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const req = http.request(`${protocol}://localhost:${port}/user`, res => {
                res.on('data', () => { })
              })

              req.end()
            })
          })
        })
      })

      describe('with splitByDomain configuration', () => {
        let config

        beforeEach(() => {
          config = {
            server: false,
            client: {
              splitByDomain: true
            }
          }

          return agent.load('http', config)
            .then(() => {
              http = require(protocol)
              express = require('express')
            })
        })

        it('should use the remote endpoint as the service name', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('service', `localhost:${port}`)
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const req = http.request(`${protocol}://localhost:${port}/user`, res => {
                res.on('data', () => {})
              })

              req.end()
            })
          })
        })
      })

      describe('with headers configuration', () => {
        let config

        beforeEach(() => {
          config = {
            server: false,
            client: {
              headers: ['host', 'x-foo']
            }
          }

          return agent.load('http', config)
            .then(() => {
              http = require(protocol)
              express = require('express')
            })
        })

        it('should add tags for the configured headers', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.setHeader('x-foo', 'bar')
            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                const meta = traces[0][0].meta

                expect(meta).to.have.property(`${HTTP_REQUEST_HEADERS}.host`, `localhost:${port}`)
                expect(meta).to.have.property(`${HTTP_RESPONSE_HEADERS}.x-foo`, 'bar')
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const req = http.request(`${protocol}://localhost:${port}/user`, res => {
                res.on('data', () => {})
              })

              req.end()
            })
          })
        })

        it('should support adding request headers', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                const meta = traces[0][0].meta

                expect(meta).to.have.property(`${HTTP_REQUEST_HEADERS}.x-foo`, `bar`)
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const req = http.request(`${protocol}://localhost:${port}/user`, res => {
                res.on('data', () => {})
              })

              req.setHeader('x-foo', 'bar')
              req.end()
            })
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
              http = require(protocol)
              express = require('express')
            })
        })

        it('should run the request hook before the span is finished', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', 'GET /user')
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const req = http.request(`${protocol}://localhost:${port}/user`, res => {
                res.on('data', () => {})
              })

              req._route = '/user'

              req.end()
            })
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
              http = require(protocol)
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

          getPort().then(port => {
            appListener = server(app, port, () => {
              const req = http.request({
                port,
                path: '/users'
              })

              req.end()
            })
          })
        })
      })
    })
  })
})
