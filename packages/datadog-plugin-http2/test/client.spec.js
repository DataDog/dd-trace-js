'use strict'

const getPort = require('get-port')
const agent = require('../../dd-trace/test/plugins/agent')
const fs = require('fs')
const path = require('path')
const tags = require('../../../ext/tags')
const key = fs.readFileSync(path.join(__dirname, './ssl/test.key'))
const cert = fs.readFileSync(path.join(__dirname, './ssl/test.crt'))

const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS

describe('Plugin', () => {
  let http2
  let appListener
  let tracer

  ['http', 'https'].forEach(protocol => {
    describe(`http2/client, protocol ${protocol}`, () => {
      function server (app, port, listener) {
        let server
        if (protocol === 'https') {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
          server = require('http2').createSecureServer({ key, cert })
        } else {
          server = require('http2').createServer()
        }
        server.on('stream', app)
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
          return agent.load('http2', { server: false })
            .then(() => {
              http2 = require('http2')
            })
        })

        it('should do automatic instrumentation', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('service', 'test')
                expect(traces[0][0]).to.have.property('type', 'http')
                expect(traces[0][0]).to.have.property('resource', 'GET')
                expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
                expect(traces[0][0].meta).to.have.property('http.method', 'GET')
                expect(traces[0][0].meta).to.have.property('http.status_code', '200')
                expect(traces[0][0].meta).to.have.property('component', 'http2')
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const client = http2
                .connect(`${protocol}://localhost:${port}`)
                .on('error', done)

              const req = client.request({ ':path': '/user', ':method': 'GET' })
              req.on('error', done)

              req.end()
            })
          })
        })

        it('should support request configuration without a path and method', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/`)
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const client = http2
                .connect(`${protocol}://localhost:${port}`)
                .on('error', done)

              const req = client.request({})
                .on('error', done)

              req.end()
            })
          })
        })

        it('should support connect configuration with a URL object', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

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
              port
            }

            appListener = server(app, port, () => {
              const client = http2
                .connect(uri)
                .on('error', done)

              const req = client.request({ ':path': '/user' })
              req.on('error', done)

              req.end()
            })
          })
        })

        it('should remove the query string from the URL', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const client = http2
                .connect(`${protocol}://localhost:${port}`)
                .on('error', done)

              const req = client.request({ ':path': '/user?foo=bar' })
              req.on('error', done)

              req.end()
            })
          })
        })

        // TODO this breaks on node 12+ (maybe before?)
        it.skip('should support a URL object and an options object, with the string URL taking precedence', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
              })
              .then(done)
              .catch(done)

            const correctConfig = {
              protocol: `${protocol}:`,
              host: 'localhost',
              port
            }

            const incorrectConfig = {
              protocol: `${protocol}:`,
              host: 'remotehost',
              port: 1337
            }

            appListener = server(app, port, () => {
              let client
              if (protocol === 'https') {
                client = http2.connect(incorrectConfig, correctConfig)
              } else {
                client = http2.connect(correctConfig, incorrectConfig)
              }

              client.on('error', done)

              const req = client.request({ ':path': '/user' })
              req.on('error', done)

              req.end()
            })
          })
        })

        // TODO this breaks on node 12+ (maybe before?)
        it.skip('should support a string URL and an options object, with the string URL taking precedence', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
              })
              .then(done)
              .catch(done)

            const correctConfig = {
              protocol: `${protocol}:`,
              host: 'localhost',
              port
            }

            const incorrectConfig = {
              protocol: `${protocol}:`,
              host: 'remotehost',
              port: 1337
            }

            appListener = server(app, port, () => {
              let client
              if (protocol === 'https') {
                client = http2.connect(`${protocol}://remotehost:1337`, correctConfig)
              } else {
                client = http2.connect(`${protocol}://localhost:${port}`, incorrectConfig)
              }

              client.on('error', done)

              const req = client.request({ ':path': '/user' })
              req.on('error', done)

              req.end()
            })
          })
        })

        it('should use the correct defaults when not specified', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/`)
              })
              .then(done)
              .catch(done)

            const uri = {
              protocol: `${protocol}:`,
              port
            }

            appListener = server(app, port, () => {
              const client = http2
                .connect(uri)
                .on('error', done)

              const req = client.request({})
              req.on('error', done)

              req.end()
            })
          })
        })

        it('should inject its parent span in the headers', done => {
          const app = (stream, headers) => {
            expect(headers['x-datadog-trace-id']).to.be.a('string')
            expect(headers['x-datadog-parent-id']).to.be.a('string')

            stream.respond({
              ':status': 200
            })
            stream.end()
          }

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0].meta).to.have.property('http.status_code', '200')
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const client = http2
                .connect(`${protocol}://localhost:${port}`)
                .on('error', done)

              const req = client.request({})
              req.on('error', done)

              req.end()
            })
          })
        })

        it('should skip injecting if the Authorization header contains an AWS signature', done => {
          const app = (stream, headers) => {
            try {
              expect(headers['x-datadog-trace-id']).to.be.undefined
              expect(headers['x-datadog-parent-id']).to.be.undefined

              stream.respond({
                ':status': 200
              })
              stream.end()

              done()
            } catch (e) {
              done(e)
            }
          }

          getPort().then(port => {
            appListener = server(app, port, () => {
              const headers = {
                Authorization: 'AWS4-HMAC-SHA256 ...'
              }
              const client = http2
                .connect(`${protocol}://localhost:${port}`)
                .on('error', done)

              const req = client.request(headers)
              req.on('error', done)

              req.end()
            })
          })
        })

        it('should skip injecting if one of the Authorization headers contains an AWS signature', done => {
          const app = (stream, headers) => {
            try {
              expect(headers['x-datadog-trace-id']).to.be.undefined
              expect(headers['x-datadog-parent-id']).to.be.undefined

              stream.respond({
                ':status': 200
              })
              stream.end()

              done()
            } catch (e) {
              done(e)
            }
          }

          getPort().then(port => {
            appListener = server(app, port, () => {
              const headers = {
                Authorization: ['AWS4-HMAC-SHA256 ...']
              }
              const client = http2
                .connect(`${protocol}://localhost:${port}`)
                .on('error', done)

              const req = client.request(headers)
              req.on('error', done)

              req.end()
            })
          })
        })

        it('should skip injecting if the X-Amz-Signature header is set', done => {
          const app = (stream, headers) => {
            try {
              expect(headers['x-datadog-trace-id']).to.be.undefined
              expect(headers['x-datadog-parent-id']).to.be.undefined

              stream.respond({
                ':status': 200
              })
              stream.end()

              done()
            } catch (e) {
              done(e)
            }
          }

          getPort().then(port => {
            appListener = server(app, port, () => {
              const headers = {
                'X-Amz-Signature': 'abc123'
              }
              const client = http2
                .connect(`${protocol}://localhost:${port}`)
                .on('error', done)

              const req = client.request(headers)
              req.on('error', done)

              req.end()
            })
          })
        })

        it('should skip injecting if the X-Amz-Signature query param is set', done => {
          const app = (stream, headers) => {
            try {
              expect(headers['x-datadog-trace-id']).to.be.undefined
              expect(headers['x-datadog-parent-id']).to.be.undefined

              stream.respond({
                ':status': 200
              })
              stream.end()

              done()
            } catch (e) {
              done(e)
            }
          }

          getPort().then(port => {
            appListener = server(app, port, () => {
              const client = http2
                .connect(`${protocol}://localhost:${port}`)
                .on('error', done)

              const req = client.request({ ':path': '/?X-Amz-Signature=abc123' })
              req.on('error', done)

              req.end()
            })
          })
        })

        it('should run the callback in the parent context', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

          getPort().then(port => {
            appListener = server(app, port, () => {
              const client = http2
                .connect(`${protocol}://localhost:${port}`)
                .on('error', done)

              const span = {}

              tracer.scope().activate(span, () => {
                const req = client.request({ ':path': '/user' })
                req.on('response', (headers, flags) => {
                  expect(tracer.scope().active()).to.equal(span)
                  done()
                })

                req.on('error', done)

                req.end()
              })
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
                expect(traces[0][0].meta).to.have.property('component', 'http2')
              })
              .then(done)
              .catch(done)

            const client = http2.connect(`${protocol}://localhost:${port}`)
              .on('error', (err) => {})

            const req = client.request({ ':path': '/user' })
              .on('error', (err) => { error = err })

            req.end()
          })
        })

        it('should not record HTTP 5XX responses as errors by default', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 500
            })
            stream.end()
          }

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('error', 0)
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const client = http2
                .connect(`${protocol}://localhost:${port}`)
                .on('error', done)

              const req = client.request({ ':path': '/' })
              req.on('error', done)

              req.end()
            })
          })
        })

        it('should record HTTP 4XX responses as errors by default', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 400
            })
            stream.end()
          }

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('error', 1)
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const client = http2
                .connect(`${protocol}://localhost:${port}`)
                .on('error', done)

              const req = client.request({ ':path': '/' })
              req.on('error', done)

              req.end()
            })
          })
        })

        it('should only record a request once', done => {
          require('http2')
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

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
                const client = http2.connect(`${protocol}://localhost:${port}`)
                  .on('error', done)

                client.request({ ':path': '/test-1' })
                  .on('error', done)
                  .end()

                client.request({ ':path': `/user?test=2` })
                  .on('error', done)
                  .end()

                span.finish()
              })
            })
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

          return agent.load('http2', config)
            .then(() => {
              http2 = require('http2')
            })
        })

        it('should be configured with the correct values', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('service', 'custom')
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const client = http2
                .connect(`${protocol}://localhost:${port}`)
                .on('error', done)

              const req = client.request({ ':path': '/user' })
              req.on('error', done)

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

          return agent.load('http2', config)
            .then(() => {
              http2 = require('http2')
            })
        })

        it('should use the supplied function to decide if a response is an error', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 500
            })
            stream.end()
          }

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('error', 1)
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const client = http2
                .connect(`${protocol}://localhost:${port}`)
                .on('error', done)

              const req = client.request({ ':path': '/user' })
              req.on('error', done)

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

          return agent.load('http2', config)
            .then(() => {
              http2 = require('http2')
            })
        })

        it('should use the remote endpoint as the service name', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('service', `localhost:${port}`)
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const client = http2.connect(`${protocol}://localhost:${port}`)
                .on('error', done)

              client.request({ ':path': '/user' })
                .on('error', done)
                .end()
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
              headers: [':path', 'x-foo']
            }
          }

          return agent.load('http2', config)
            .then(() => {
              http2 = require('http2')
            })
        })

        it('should add tags for the configured headers', done => {
          const app = (stream, headers) => {
            stream.respond({
              'x-foo': 'bar',
              ':status': 200
            })
            stream.end()
          }

          getPort().then(port => {
            agent
              .use(traces => {
                const meta = traces[0][0].meta

                expect(meta).to.have.property(`${HTTP_REQUEST_HEADERS}.:path`, '/user')
                expect(meta).to.have.property(`${HTTP_RESPONSE_HEADERS}.x-foo`, 'bar')
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const client = http2.connect(`${protocol}://localhost:${port}`)
                .on('error', done)

              client.request({ ':path': '/user' })
                .on('error', done)
                .end()
            })
          })
        })
      })
    })
  })
})
