'use strict'

const { withNamingSchema, withPeerService } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const fs = require('fs')
const path = require('path')
const tags = require('../../../ext/tags')
const key = fs.readFileSync(path.join(__dirname, './ssl/test.key'))
const cert = fs.readFileSync(path.join(__dirname, './ssl/test.crt'))
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { rawExpectedSchema } = require('./naming')

const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS
const SERVICE_NAME = 'test'

describe('Plugin', () => {
  let http2
  let appListener
  let tracer

  ['http', 'https', 'node:http', 'node:https'].forEach(pluginToBeLoaded => {
    const protocol = pluginToBeLoaded.split(':')[1] || pluginToBeLoaded
    const loadPlugin = pluginToBeLoaded.includes('node:') ? 'node:http2' : 'http2'
    describe(`http2/client, protocol ${pluginToBeLoaded}`, () => {
      function server (app, listener) {
        let server
        if (pluginToBeLoaded === 'https' || pluginToBeLoaded === 'node:https') {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
          server = require(loadPlugin).createSecureServer({ key, cert })
        } else {
          server = require(loadPlugin).createServer()
        }
        server.on('stream', app)
        server.listen(0, 'localhost', () => listener(server.address().port))
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
              http2 = require(loadPlugin)
            })
        })

        const spanProducerFn = (done) => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

          appListener = server(app, port => {
            const client = http2
              .connect(`${protocol}://localhost:${port}`)
              .on('error', done)

            const req = client.request({ ':path': '/user', ':method': 'GET' })
            req.on('error', done)

            req.end()
            setTimeout(done, 10)
          })
        }

        withPeerService(
          () => tracer,
          'http2',
          spanProducerFn,
          'localhost',
          'out.host'
        )

        withNamingSchema(
          (done) => spanProducerFn((err) => err && done(err)),
          rawExpectedSchema.client
        )

        it('should do automatic instrumentation', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

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
                expect(traces[0][0].meta).to.have.property('component', 'http2')
                expect(traces[0][0].meta).to.have.property('_dd.integration', 'http2')
                expect(traces[0][0].meta).to.have.property('out.host', 'localhost')
                expect(traces[0][0].metrics).to.have.property('network.destination.port', port)
              })
              .then(done)
              .catch(done)

            const client = http2
              .connect(`${protocol}://localhost:${port}`)
              .on('error', done)

            const req = client.request({ ':path': '/user', ':method': 'GET' })
            req.on('error', done)

            req.end()
          })
        })

        it('should support request configuration without a path and method', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/`)
              })
              .then(done)
              .catch(done)

            const client = http2
              .connect(`${protocol}://localhost:${port}`)
              .on('error', done)

            const req = client.request({})
              .on('error', done)

            req.end()
          })
        })

        it('should support connect configuration with a URL object', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

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
              port
            }

            const client = http2
              .connect(uri)
              .on('error', done)

            const req = client.request({ ':path': '/user' })
            req.on('error', done)

            req.end()
          })
        })

        it('should remove the query string from the URL', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/user`)
              })
              .then(done)
              .catch(done)

            const client = http2
              .connect(`${protocol}://localhost:${port}`)
              .on('error', done)

            const req = client.request({ ':path': '/user?foo=bar' })
            req.on('error', done)

            req.end()
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

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
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

        // TODO this breaks on node 12+ (maybe before?)
        it.skip('should support a string URL and an options object, with the string URL taking precedence', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
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

        it('should use the correct defaults when not specified', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0].meta).to.have.property('http.url', `${protocol}://localhost:${port}/`)
              })
              .then(done)
              .catch(done)

            const uri = {
              protocol: `${protocol}:`,
              port
            }

            const client = http2
              .connect(uri)
              .on('error', done)

            const req = client.request({})
            req.on('error', done)

            req.end()
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

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0].meta).to.have.property('http.status_code', '200')
              })
              .then(done)
              .catch(done)

            const client = http2
              .connect(`${protocol}://localhost:${port}`)
              .on('error', done)

            const req = client.request({})
            req.on('error', done)

            req.end()
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

          appListener = server(app, port => {
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

          appListener = server(app, port => {
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

          appListener = server(app, port => {
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

          appListener = server(app, port => {
            const client = http2
              .connect(`${protocol}://localhost:${port}`)
              .on('error', done)

            const req = client.request({ ':path': '/?X-Amz-Signature=abc123' })
            req.on('error', done)

            req.end()
          })
        })

        it('should run the callback in the parent context', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

          appListener = server(app, port => {
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

        it('should handle connection errors', done => {
          let error

          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
              expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
              expect(traces[0][0].meta).to.have.property('component', 'http2')
              expect(traces[0][0].metrics).to.have.property('network.destination.port', 7357)
            })
            .then(done)
            .catch(done)

          const client = http2.connect(`${protocol}://localhost:7357`)
            .on('error', (err) => {})

          const req = client.request({ ':path': '/user' })
            .on('error', (err) => { error = err })

          req.end()
        })

        it('should not record HTTP 5XX responses as errors by default', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 500
            })
            stream.end()
          }

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('error', 0)
              })
              .then(done)
              .catch(done)

            const client = http2
              .connect(`${protocol}://localhost:${port}`)
              .on('error', done)

            const req = client.request({ ':path': '/' })
            req.on('error', done)

            req.end()
          })
        })

        it('should record HTTP 4XX responses as errors by default', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 400
            })
            stream.end()
          }

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('error', 1)
              })
              .then(done)
              .catch(done)

            const client = http2
              .connect(`${protocol}://localhost:${port}`)
              .on('error', done)

            const req = client.request({ ':path': '/' })
            req.on('error', done)

            req.end()
          })
        })

        it('should only record a request once', done => {
          require(loadPlugin)
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                const spans = traces[0]
                expect(spans.length).to.equal(3)
              })
              .then(done)
              .catch(done)

            // Activate a new parent span so we capture any double counting that may happen, otherwise double-counts
            // would be siblings and our test would only capture 1 as a false positive.
            const span = tracer.startSpan('http-test')
            tracer.scope().activate(span, () => {
              const client = http2.connect(`${protocol}://localhost:${port}`)
                .on('error', done)

              client.request({ ':path': '/test-1' })
                .on('error', done)
                .end()

              client.request({ ':path': '/user?test=2' })
                .on('error', done)
                .end()

              span.finish()
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
              http2 = require(loadPlugin)
            })
        })

        it('should be configured with the correct values', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('service', 'custom')
              })
              .then(done)
              .catch(done)

            const client = http2
              .connect(`${protocol}://localhost:${port}`)
              .on('error', done)

            const req = client.request({ ':path': '/user' })
            req.on('error', done)

            req.end()
          })
        })
      })

      describe('with late plugin initialization and an external subscriber', () => {
        let ch
        let sub

        beforeEach(() => {
          return agent.load('http2', { server: false })
            .then(() => {
              ch = require('dc-polyfill').channel('apm:http2:client:request:start')
              sub = () => {}
              tracer = require('../../dd-trace')
              http2 = require('http2')
            })
        })

        afterEach(() => {
          ch.unsubscribe(sub)
        })

        it('should not crash', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

          appListener = server(app, port => {
            ch.subscribe(sub)

            const client = http2
              .connect(`${protocol}://localhost:${port}`)
              .on('error', done)

            tracer.use('http2', false)

            const req = client.request({ ':path': '/user', ':method': 'GET' })
            req.on('error', done)
            req.on('response', () => done())

            tracer.use('http2', true)

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

          return agent.load('http2', config)
            .then(() => {
              http2 = require(loadPlugin)
            })
        })

        it('should use the supplied function to decide if a response is an error', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 500
            })
            stream.end()
          }

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('error', 1)
              })
              .then(done)
              .catch(done)

            const client = http2
              .connect(`${protocol}://localhost:${port}`)
              .on('error', done)

            const req = client.request({ ':path': '/user' })
            req.on('error', done)

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

          return agent.load('http2', config)
            .then(() => {
              http2 = require(loadPlugin)
            })
        })

        withNamingSchema(
          (done) => {
            const app = (stream, headers) => {
              stream.respond({
                ':status': 200
              })
              stream.end()
            }
            appListener = server(app, port => {
              serverPort = port

              const client = http2
                .connect(`${protocol}://localhost:${port}`)
                .on('error', done)

              const req = client.request({ ':path': '/user', ':method': 'GET' })
              req.on('error', done)

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
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('service', `localhost:${port}`)
              })
              .then(done)
              .catch(done)

            const client = http2.connect(`${protocol}://localhost:${port}`)
              .on('error', done)

            client.request({ ':path': '/user' })
              .on('error', done)
              .end()
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
              http2 = require(loadPlugin)
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

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                const meta = traces[0][0].meta

                expect(meta).to.have.property(`${HTTP_REQUEST_HEADERS}.:path`, '/user')
                expect(meta).to.have.property(`${HTTP_RESPONSE_HEADERS}.x-foo`, 'bar')
              })
              .then(done)
              .catch(done)

            const client = http2.connect(`${protocol}://localhost:${port}`)
              .on('error', done)

            client.request({ ':path': '/user' })
              .on('error', done)
              .end()
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

          return agent.load('http2', config)
            .then(() => {
              http2 = require(loadPlugin)
            })
        })

        it('should skip recording if the url matches an item in the blocklist', done => {
          const app = (stream, headers) => {
            stream.respond({
              ':status': 200
            })
            stream.end()
          }

          appListener = server(app, port => {
            const timer = setTimeout(done, 100)

            agent
              .assertSomeTraces(() => {
                clearTimeout(timer)
                done(new Error('Blocklisted requests should not be recorded.'))
              })
              .catch(done)

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
