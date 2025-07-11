'use strict'

const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const agent = require('../../dd-trace/test/plugins/agent')
const tags = require('../../../ext/tags')
const { expect } = require('chai')
const { rawExpectedSchema } = require('./naming')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { NODE_MAJOR } = require('../../../version')

const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS

const SERVICE_NAME = 'test'

describe('Plugin', () => {
  let express
  let fetch
  let appListener

  describe('undici-fetch', () => {
    withVersions('undici', 'undici', NODE_MAJOR < 20 ? '<7.11.0' : '*', (version) => {
      function server (app, listener) {
        const server = require('http').createServer(app)
        server.listen(0, 'localhost', () => listener(server.address().port))
        return server
      }

      beforeEach(() => {
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
          return agent.load('undici', {
            service: 'test'
          })
            .then(() => {
              express = require('express')
              fetch = require(`../../../versions/undici@${version}`, {}).get()
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
                expect(traces[0][0]).to.have.property('service', 'test')
                expect(traces[0][0]).to.have.property('type', 'http')
                expect(traces[0][0]).to.have.property('resource', 'GET')
                expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
                expect(traces[0][0].meta).to.have.property('http.method', 'GET')
                expect(traces[0][0].meta).to.have.property('http.status_code', '200')
                expect(traces[0][0].meta).to.have.property('component', 'undici')
                expect(traces[0][0].meta).to.have.property('_dd.integration', 'undici')
                expect(traces[0][0].meta).to.have.property('out.host', 'localhost')
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
                expect(traces[0][0]).to.have.property('service', SERVICE_NAME)
                expect(traces[0][0]).to.have.property('type', 'http')
                expect(traces[0][0]).to.have.property('resource', 'POST')
                expect(traces[0][0].meta).to.have.property('span.kind', 'client')
                expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
                expect(traces[0][0].meta).to.have.property('http.method', 'POST')
                expect(traces[0][0].meta).to.have.property('http.status_code', '200')
                expect(traces[0][0].meta).to.have.property('component', 'undici')
                expect(traces[0][0].meta).to.have.property('out.host', 'localhost')
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
                expect(res).to.have.property('status', 200)
                done()
              })
              .catch(done)
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
                expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
              })
              .then(done)
              .catch(done)

            fetch.fetch(`http://localhost:${port}/user?foo=bar`)
          })
        })

        it('should inject its parent span in the headers', done => {
          const app = express()

          app.get('/user', (req, res) => {
            expect(req.get('x-datadog-trace-id')).to.be.a('string')
            expect(req.get('x-datadog-parent-id')).to.be.a('string')

            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0].meta).to.have.property('http.status_code', '200')
              })
              .then(done)
              .catch(done)

            fetch.fetch(`http://localhost:${port}/user?foo=bar`)
          })
        })

        it('should inject its parent span in the existing headers', done => {
          const app = express()

          app.get('/user', (req, res) => {
            expect(req.get('foo')).to.be.a('string')
            expect(req.get('x-datadog-trace-id')).to.be.a('string')
            expect(req.get('x-datadog-parent-id')).to.be.a('string')

            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0].meta).to.have.property('http.status_code', '200')
              })
              .then(done)
              .catch(done)

            fetch.fetch(`http://localhost:${port}/user?foo=bar`, { headers: { foo: 'bar' } })
          })
        })

        it('should handle connection errors', done => {
          let error

          agent
            .assertSomeTraces(traces => {
              expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message || error.code)
              expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
              expect(traces[0][0].meta).to.have.property('component', 'undici')
            })
            .then(done)
            .catch(done)

          fetch.fetch('http://localhost:7357/user').catch(err => {
            error = err
          })
        })

        it('should not record HTTP 5XX responses as errors by default', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(500).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                expect(traces[0][0]).to.have.property('error', 0)
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
                expect(traces[0][0]).to.have.property('error', 1)
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
                expect(traces[0][0]).to.have.property('error', 0)
                expect(traces[0][0].meta).to.not.have.property('http.status_code')
              })
              .then(done)
              .catch(done)

            const controller = new AbortController()

            fetch.fetch(`http://localhost:${port}/user`, {
              signal: controller.signal
            }).catch(() => {})

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
                expect(traces[0][0]).to.have.property('service', SERVICE_NAME)
              })
              .then(done)
              .catch(done)

            const controller = new AbortController()

            fetch.fetch(`http://localhost:${port}/user`, {
              signal: controller.signal
            }).catch(() => {})

            controller.abort()
          })
        })
      })
      describe('with service configuration', () => {
        let config

        beforeEach(() => {
          config = {
            service: 'custom'
          }

          return agent.load('undici', config)
            .then(() => {
              express = require('express')
              fetch = require(`../../../versions/undici@${version}`, {}).get()
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
                expect(traces[0][0]).to.have.property('service', 'custom')
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
            headers: ['x-baz', 'x-foo']
          }

          return agent.load('undici', config)
            .then(() => {
              express = require('express')
              fetch = require(`../../../versions/undici@${version}`, {}).get()
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
                expect(meta).to.have.property(`${HTTP_REQUEST_HEADERS}.x-baz`, 'qux')
                expect(meta).to.have.property(`${HTTP_RESPONSE_HEADERS}.x-foo`, 'bar')
              })
              .then(done)
              .catch(done)

            fetch.fetch(`http://localhost:${port}/user`, {
              headers: {
                'x-baz': 'qux'
              }
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
              }
            }
          }

          return agent.load('undici', config)
            .then(() => {
              express = require('express')
              fetch = require(`../../../versions/undici@${version}`, {}).get()
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
                expect(traces[0][0].meta).to.have.property('foo', '/foo')
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
            propagationBlocklist: [/\/users/]
          }

          return agent.load('undici', config)
            .then(() => {
              express = require('express')
              fetch = require(`../../../versions/undici@${version}`, {}).get()
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
            fetch.fetch(`http://localhost:${port}/users`).catch(() => {})
          })
        })
      })

      describe('with blocklist configuration', () => {
        let config

        beforeEach(() => {
          config = {
            blocklist: [/\/user/]
          }

          return agent.load('undici', config)
            .then(() => {
              express = require('express')
              fetch = require(`../../../versions/undici@${version}`, {}).get()
            })
        })

        it('should skip recording if the url matches an item in the blocklist', done => {
          const app = express()

          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = server(app, port => {
            const timer = setTimeout(done, 100)

            agent
              .assertSomeTraces(() => {
                clearTimeout(timer)
                done(new Error('Blocklisted requests should not be recorded.'))
              })
              .catch(done)

            fetch.fetch(`http://localhost:${port}/users`).catch(() => {})
          })
        })
      })
    })
  })
})
