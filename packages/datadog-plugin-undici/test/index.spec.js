'use strict'

const AbortController = require('abort-controller')
const getPort = require('get-port')
const agent = require('../../dd-trace/test/plugins/agent')
const tags = require('../../../ext/tags')
const { expect } = require('chai')

const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS
const plugin = require('../src')

describe('undici', () => {
  let express
  let undici
  let appListener
  let tracer

  withVersions(plugin, 'undici', (version) => {
    function server (app, port, listener) {
      const server = require('http').createServer(app)
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
      return agent.close()
    })

    describe('without configuration', () => {
      beforeEach(() => {
        return agent.load('undici').then(() => {
          undici = require(`../../../versions/undici@${version}`).get()
          express = require('express')
        })
      })

      it('should do automatic instrumentation', (done) => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        getPort().then((port) => {
          agent
            .use((traces) => {
              expect(traces[0][0]).to.have.property(
                'service',
                'test-http-client'
              )
              expect(traces[0][0]).to.have.property('type', 'http')
              expect(traces[0][0]).to.have.property('resource', 'GET')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property(
                'http.url',
                `http://localhost:${port}/user`
              )
              expect(traces[0][0].meta).to.have.property('http.method', 'GET')
              expect(traces[0][0].meta).to.have.property(
                'http.status_code',
                '200'
              )
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            undici.request(`http://localhost:${port}/user`)
          })
        })
      })

      it('should support configuration as an URL object', (done) => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        getPort().then((port) => {
          agent
            .use((traces) => {
              expect(traces[0][0].meta).to.have.property(
                'http.url',
                `http://localhost:${port}/user`
              )
            })
            .then(done)
            .catch(done)

          const uri = {
            protocol: `http:`,
            hostname: 'localhost',
            port,
            path: '/user'
          }

          appListener = server(app, port, () => {
            undici.request(uri)
          })
        })
      })

      it('should remove the query string from the URL', (done) => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        getPort().then((port) => {
          agent
            .use((traces) => {
              expect(traces[0][0].meta).to.have.property(
                'http.status_code',
                '200'
              )
              expect(traces[0][0].meta).to.have.property(
                'http.url',
                `http://localhost:${port}/user`
              )
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            undici.request(`http://localhost:${port}/user?foo=bar`)
          })
        })
      })

      it('should support configuration as an WHATWG URL object', async () => {
        const app = express()
        const port = await getPort()
        const url = new URL(`http://localhost:${port}/user`)

        app.get('/user', (req, res) => res.status(200).send())

        appListener = server(app, port, () => {
          undici.request(url)
        })

        await agent.use((traces) => {
          expect(traces[0][0].meta).to.have.property('http.status_code', '200')
          expect(traces[0][0].meta).to.have.property(
            'http.url',
            `http://localhost:${port}/user`
          )
        })
      })

      it('should not require consuming the data', (done) => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        getPort().then((port) => {
          agent
            .use((traces) => {
              expect(traces[0][0]).to.not.be.undefined
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            undici.request(`http://localhost:${port}/user`)
          })
        })
      })

      it('should inject its parent span in the headers', (done) => {
        const app = express()

        app.get('/user', (req, res) => {
          expect(req.get('x-datadog-trace-id')).to.be.a('string')
          expect(req.get('x-datadog-parent-id')).to.be.a('string')

          res.status(200).send()
        })

        getPort().then((port) => {
          agent
            .use((traces) => {
              expect(traces[0][0].meta).to.have.property(
                'http.status_code',
                '200'
              )
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            undici.request(`http://localhost:${port}/user`)
          })
        })
      })

      it('should skip injecting if the Authorization header contains an AWS signature', (done) => {
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

        getPort().then((port) => {
          appListener = server(app, port, () => {
            undici.request(`http://localhost:${port}/`, {
              headers: {
                Authorization: 'AWS4-HMAC-SHA256 ...'
              }
            })
          })
        })
      })

      it('should skip injecting if one of the Authorization headers contains an AWS signature', (done) => {
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

        getPort().then((port) => {
          appListener = server(app, port, () => {
            undici.request(`http://localhost:${port}/`, {
              headers: {
                Authorization: 'AWS4-HMAC-SHA256 ...'
              }
            })
          })
        })
      })

      it('should skip injecting if the X-Amz-Signature header is set', (done) => {
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

        getPort().then((port) => {
          appListener = server(app, port, () => {
            undici.request(`http://localhost:${port}/`, {
              headers: {
                Authorization: 'AWS4-HMAC-SHA256 ...'
              }
            })
          })
        })
      })

      it('should skip injecting if the X-Amz-Signature query param is set', (done) => {
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

        getPort().then((port) => {
          appListener = server(app, port, () => {
            undici.request(`http://localhost:${port}/?X-Amz-Signature=abc123`, {
              headers: {
                Authorization: 'AWS4-HMAC-SHA256 ...'
              }
            })
          })
        })
      })

      // TODO: the callbacks is run after the scope ends
      it.skip('should run the callback in the parent context', (done) => {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send('OK')
        })

        getPort().then((port) => {
          appListener = server(app, port, () => {
            undici.request(`http://localhost:${port}/user`, (res) => {
              expect(tracer.scope().active()).to.be.null
              done()
            })
          })
        })
      })

      // TODO: There is no event listener yet
      it.skip('should run the event listeners in the parent context', (done) => {
        if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send('OK')
        })

        getPort().then((port) => {
          appListener = server(app, port, () => {
            undici.request(`http://localhost:${port}/user`, (res) => {
              done()
            })
          })
        })
      })

      it('should handle connection errors', (done) => {
        getPort().then((port) => {
          let error

          agent
            .use((traces) => {
              expect(traces[0][0].meta).to.have.property(
                'error.type',
                error.name
              )
              expect(traces[0][0].meta).to.have.property(
                'error.msg',
                error.message
              )
              expect(traces[0][0].meta).to.have.property(
                'error.stack',
                error.stack
              )
            })
            .then(done)
            .catch(done)

          undici.request(`http://localhost:${port}/user`, (err) => {
            error = err
          })
        })
      })

      it('should not record HTTP 5XX responses as errors by default', (done) => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(500).send()
        })

        getPort().then((port) => {
          agent
            .use((traces) => {
              expect(traces[0][0]).to.have.property('error', 0)
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            undici.request(`http://localhost:${port}/user`)
          })
        })
      })

      it('should record HTTP 4XX responses as errors by default', (done) => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(400).send()
        })

        getPort().then((port) => {
          agent
            .use((traces) => {
              expect(traces[0][0]).to.have.property('error', 1)
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            undici.request(`http://localhost:${port}/user`)
          })
        })
      })

      it('should record destroyed requests as errors', (done) => {
        const app = express()

        app.get('/user', (req, res) => {})

        getPort().then((port) => {
          let error

          agent
            .use((traces) => {
              expect(traces[0][0]).to.have.property('error', 1)
              expect(traces[0][0].meta).to.have.property(
                'error.msg',
                error.message
              )
              expect(traces[0][0].meta).to.have.property(
                'error.type',
                error.name
              )
              expect(traces[0][0].meta).to.have.property(
                'error.stack',
                error.stack
              )
              expect(traces[0][0].meta).to.not.have.property(
                'http.status_code'
              )
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            const client = new undici.Client(`http://localhost:${port}`)
            client.request(
              {
                path: '/user',
                method: 'GET'
              },
              (err, data) => {
                error = err
              }
            )
            client.destroy()
          })
        })
      })

      it('should record aborted requests as errors', (done) => {
        const app = express()

        app.get('/user', (req, res) => {})

        getPort().then((port) => {
          agent
            .use((traces) => {
              expect(traces[0][0]).to.have.property('error', 1)
              expect(traces[0][0].meta).to.not.have.property(
                'http.status_code'
              )
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            const abort = new AbortController()
            undici.request(`http://localhost:${port}/user`, {
              signal: abort.signal
            })
            abort.abort()
          })
        })
      })

      // TODO: Get timeout working
      it.skip('should record timeouts as errors', (done) => {
        const app = express()

        app.get('/user', (req, res) => {})

        getPort().then((port) => {
          agent
            .use((traces) => {
              expect(traces[0][0]).to.have.property('error', 1)
              expect(traces[0][0].meta).to.not.have.property(
                'http.status_code'
              )
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            undici.request(`http://localhost:${port}/user`, {
              bodyTimeout: 0,
              headersTimeout: 0
            })
          })
        })
      })

      it('should record when the request was aborted', (done) => {
        const app = express()

        app.get('/abort', (req, res) => {
          res.status(200).send()
        })

        getPort().then((port) => {
          agent
            .use((traces) => {
              expect(traces[0][0]).to.have.property(
                'service',
                'test-http-client'
              )
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            const ac = new AbortController()
            undici.request(`http://localhost:${port}/abort`, {
              signal: ac.signal
            })

            ac.abort()
          })
        })
      })

      it('should skip requests to the agent', (done) => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        getPort().then((port) => {
          const timer = setTimeout(done, 100)

          agent.use(() => {
            done(new Error('Request to the agent was traced.'))
            clearTimeout(timer)
          })

          appListener = server(app, port, () => {
            undici.request(tracer._tracer._url.href)
          })
        })
      })
    })

    describe('with service configuration', () => {
      let config

      beforeEach(() => {
        config = {
          service: 'custom'
        }

        return agent.load('undici', config).then(() => {
          undici = require(`../../../versions/undici@${version}`).get()
          express = require('express')
        })
      })

      it('should be configured with the correct values', (done) => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        getPort().then((port) => {
          agent
            .use((traces) => {
              expect(traces[0][0]).to.have.property('service', 'custom')
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            undici.request(`http://localhost:${port}/user`)
          })
        })
      })
    })

    describe('with validateStatus configuration', () => {
      let config

      beforeEach(() => {
        config = {
          validateStatus: (status) => status < 500
        }

        return agent.load('undici', config).then(() => {
          undici = require(`../../../versions/undici@${version}`).get()
          express = require('express')
        })
      })

      it('should use the supplied function to decide if a response is an error', (done) => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(500).send()
        })

        getPort().then((port) => {
          agent
            .use((traces) => {
              expect(traces[0][0]).to.have.property('error', 1)
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            undici.request(`http://localhost:${port}/user`)
          })
        })
      })
    })

    describe('with splitByDomain configuration', () => {
      let config

      beforeEach(() => {
        config = {
          splitByDomain: true
        }
        return agent.load('undici', config).then(() => {
          undici = require(`../../../versions/undici@${version}`).get()
          express = require('express')
        })
      })

      it('should use the remote endpoint as the service name', (done) => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        getPort().then((port) => {
          agent
            .use((traces) => {
              expect(traces[0][0]).to.have.property(
                'service',
                `localhost:${port}`
              )
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            undici.request(`http://localhost:${port}/user`)
          })
        })
      })
    })

    describe('with headers configuration', () => {
      let config

      beforeEach(() => {
        config = {
          headers: ['host', 'x-foo']
        }
        return agent.load('undici', config).then(() => {
          undici = require(`../../../versions/undici@${version}`).get()
          express = require('express')
        })
      })

      describe('host header', () => {
        // TODO: Injected headers are not available yet
        // for request
        it('should add tags for the host header', (done) => {
          const app = express()

          app.get('/user', (req, res) => {
            res.setHeader('x-foo', 'bar')
            res.status(200).send()
          })

          getPort().then((port) => {
            agent
              .use((traces) => {
                const meta = traces[0][0].meta
                expect(meta).to.have.property(
                  `${HTTP_REQUEST_HEADERS}.host`,
                  `localhost:${port}`
                )
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              undici.request(`http://localhost:${port}/user`)
            })
          })
        })

        it('should add tags for the host header through Client', (done) => {
          const app = express()

          app.get('/user', (req, res) => {
            res.setHeader('x-foo', 'bar')
            res.status(200).send()
          })

          getPort().then((port) => {
            agent
              .use((traces) => {
                const meta = traces[0][0].meta
                expect(meta).to.have.property(
                  `${HTTP_REQUEST_HEADERS}.host`,
                  `localhost:${port}`
                )
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              const client = new undici.Client(`http://localhost:${port}`)

              client.request({
                path: '/user',
                method: 'GET'
              })
            })
          })
        })

        it('should pass overwritten host header', (done) => {
          const app = express()

          app.get('/user', (req, res) => {
            res.setHeader('x-foo', 'bar')
            res.status(200).send()
          })

          getPort().then((port) => {
            agent
              .use((traces) => {
                const meta = traces[0][0].meta
                expect(meta).to.have.property(
                  `${HTTP_REQUEST_HEADERS}.host`,
                  `my-service`
                )
              })
              .then(done)
              .catch(done)

            appListener = server(app, port, () => {
              undici.request(`http://localhost:${port}/user`, {
                headers: {
                  host: 'my-service'
                }
              })
            })
          })
        })
      })

      it('should add tags for the configured headers', (done) => {
        const app = express()

        app.get('/user', (req, res) => {
          res.setHeader('x-foo', 'bar')
          res.status(200).send()
        })

        getPort().then((port) => {
          agent
            .use((traces) => {
              const meta = traces[0][0].meta
              expect(meta).to.have.property(
                `${HTTP_RESPONSE_HEADERS}.x-foo`,
                'bar'
              )
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            undici.request(`http://localhost:${port}/user`)
          })
        })
      })

      it('should support adding request headers', (done) => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        getPort().then((port) => {
          agent
            .use((traces) => {
              const meta = traces[0][0].meta
              expect(meta).to.have.property(
                `${HTTP_REQUEST_HEADERS}.x-foo`,
                `bar`
              )
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            undici.request(`http://localhost:${port}/user`, {
              headers: { 'x-foo': 'bar' }
            })
          })
        })
      })
    })

    describe('with hooks configuration', () => {
      let config

      beforeEach(() => {
        config = {
          hooks: {
            request: (span, req, res) => {
              span.setTag('resource.name', `${req.method} -- ${req.path}`)
            }
          }
        }
        return agent.load('undici', config).then(() => {
          undici = require(`../../../versions/undici@${version}`).get()
          express = require('express')
        })
      })

      it('should run the request hook before the span is finished', (done) => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        getPort().then((port) => {
          agent
            .use((traces) => {
              expect(traces[0][0]).to.have.property('resource', 'GET -- /user')
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            undici.request(`http://localhost:${port}/user`)
          })
        })
      })
    })

    describe('with propagationBlocklist configuration', () => {
      let config

      beforeEach(() => {
        config = {
          propagationBlocklist: [/\/users/]
        }
        return agent.load('undici', config).then(() => {
          undici = require(`../../../versions/undici@${version}`).get()
          express = require('express')
        })
      })

      it('should skip injecting if the url matches an item in the propagationBlacklist', (done) => {
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

        getPort().then((port) => {
          appListener = server(app, port, () => {
            undici.request(`http://localhost:${port}/users`)
          })
        })
      })
    })
  })
})
