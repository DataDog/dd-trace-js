'use strict'

const getPort = require('get-port')
const agent = require('../../dd-trace/test/plugins/agent')
const tags = require('../../../ext/tags')
const { expect } = require('chai')
const { storage } = require('../../datadog-core')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { DD_MAJOR } = require('../../../version')

const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS

const SERVICE_NAME = DD_MAJOR < 3 ? 'test-http-client' : 'test'
const describe = globalThis.fetch ? globalThis.describe : globalThis.describe.skip

describe('Plugin', () => {
  let express
  let fetch
  let appListener

  describe('fetch', () => {
    function server (app, port, listener) {
      const server = require('http').createServer(app)
      server.listen(port, 'localhost', listener)
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
        return agent.load('fetch')
          .then(() => {
            express = require('express')
            fetch = globalThis.fetch
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
              expect(traces[0][0]).to.have.property('service', SERVICE_NAME)
              expect(traces[0][0]).to.have.property('type', 'http')
              expect(traces[0][0]).to.have.property('resource', 'GET')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
              expect(traces[0][0].meta).to.have.property('http.method', 'GET')
              expect(traces[0][0].meta).to.have.property('http.status_code', '200')
              expect(traces[0][0].meta).to.have.property('component', 'fetch')
              expect(traces[0][0].meta).to.have.property('out.host', 'localhost')
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            fetch(`http://localhost:${port}/user`)
          })
        })
      })

      it('should support URL input', done => {
        const app = express()
        app.post('/user', (req, res) => {
          res.status(200).send()
        })
        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', SERVICE_NAME)
              expect(traces[0][0]).to.have.property('type', 'http')
              expect(traces[0][0]).to.have.property('resource', 'POST')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
              expect(traces[0][0].meta).to.have.property('http.method', 'POST')
              expect(traces[0][0].meta).to.have.property('http.status_code', '200')
              expect(traces[0][0].meta).to.have.property('component', 'fetch')
              expect(traces[0][0].meta).to.have.property('out.host', 'localhost')
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            fetch(new URL(`http://localhost:${port}/user`), { method: 'POST' })
          })
        })
      })

      it('should support Request input', done => {
        const app = express()
        app.get('/user', (req, res) => {
          res.status(200).send()
        })
        getPort().then(port => {
          agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('service', SERVICE_NAME)
              expect(traces[0][0]).to.have.property('type', 'http')
              expect(traces[0][0]).to.have.property('resource', 'GET')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
              expect(traces[0][0].meta).to.have.property('http.method', 'GET')
              expect(traces[0][0].meta).to.have.property('http.status_code', '200')
              expect(traces[0][0].meta).to.have.property('component', 'fetch')
              expect(traces[0][0].meta).to.have.property('out.host', 'localhost')
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            fetch(new globalThis.Request(`http://localhost:${port}/user`))
          })
        })
      })

      it('should return the response', done => {
        const app = express()
        app.get('/user', (req, res) => {
          res.status(200).send()
        })
        getPort().then(port => {
          appListener = server(app, port, () => {
            fetch(new globalThis.Request(`http://localhost:${port}/user`))
              .then(res => {
                expect(res).to.have.property('status', 200)
                done()
              })
              .catch(done)
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
              expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            fetch(`http://localhost:${port}/user?foo=bar`)
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
            fetch(`http://localhost:${port}/user?foo=bar`)
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
            fetch(`http://localhost:${port}/`, {
              headers: {
                Authorization: 'AWS4-HMAC-SHA256 ...'
              }
            })
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
            fetch(`http://localhost:${port}/`, {
              headers: {
                Authorization: ['AWS4-HMAC-SHA256 ...']
              }
            })
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
            fetch(`http://localhost:${port}/`, {
              headers: {
                'X-Amz-Signature': 'abc123'
              }
            })
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
            fetch(`http://localhost:${port}/?X-Amz-Signature=abc123`)
          })
        })
      })

      it('should handle connection errors', done => {
        getPort().then(port => {
          let error

          agent
            .use(traces => {
              expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
              expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message || error.code)
              expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
              expect(traces[0][0].meta).to.have.property('component', 'fetch')
            })
            .then(done)
            .catch(done)

          fetch(`http://localhost:${port}/user`).catch(err => {
            error = err
          })
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
            fetch(`http://localhost:${port}/user`)
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
            fetch(`http://localhost:${port}/user`)
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
            const controller = new AbortController()

            fetch(`http://localhost:${port}/user`, {
              signal: controller.signal
            }).catch(e => {})

            controller.abort()
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
              expect(traces[0][0]).to.have.property('service', SERVICE_NAME)
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            const controller = new AbortController()

            fetch(`http://localhost:${port}/user`, {
              signal: controller.signal
            }).catch(e => {})

            controller.abort()
          })
        })
      })

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

            fetch(`http://localhost:${port}/user`).catch(() => {})

            storage.enterWith(store)
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

        return agent.load('fetch', config)
          .then(() => {
            express = require('express')
            fetch = globalThis.fetch
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
            fetch(`http://localhost:${port}/user`).catch(() => {})
          })
        })
      })
    })

    describe('with validateStatus configuration', () => {
      let config

      beforeEach(() => {
        config = {
          validateStatus: status => status < 500
        }

        return agent.load('fetch', config)
          .then(() => {
            express = require('express')
            fetch = globalThis.fetch
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
            fetch(`http://localhost:${port}/user`).catch(() => {})
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

        return agent.load('fetch', config)
          .then(() => {
            express = require('express')
            fetch = globalThis.fetch
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
            fetch(`http://localhost:${port}/user`).catch(() => {})
          })
        })
      })
    })

    describe('with headers configuration', () => {
      let config

      beforeEach(() => {
        config = {
          headers: ['x-baz', 'x-foo']
        }

        return agent.load('fetch', config)
          .then(() => {
            express = require('express')
            fetch = globalThis.fetch
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

              expect(meta).to.have.property(`${HTTP_REQUEST_HEADERS}.x-baz`, `qux`)
              expect(meta).to.have.property(`${HTTP_RESPONSE_HEADERS}.x-foo`, 'bar')
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            fetch(`http://localhost:${port}/user`, {
              headers: {
                'x-baz': 'qux'
              }
            }).catch(() => {})
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
              span.setTag('foo', '/foo')
            }
          }
        }

        return agent.load('fetch', config)
          .then(() => {
            express = require('express')
            fetch = globalThis.fetch
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
              expect(traces[0][0].meta).to.have.property('foo', '/foo')
            })
            .then(done)
            .catch(done)

          appListener = server(app, port, () => {
            fetch(`http://localhost:${port}/user`).catch(() => {})
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

        return agent.load('fetch', config)
          .then(() => {
            express = require('express')
            fetch = globalThis.fetch
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
            fetch(`http://localhost:${port}/users`).catch(() => {})
          })
        })
      })
    })

    describe('with blocklist configuration', () => {
      let config

      beforeEach(() => {
        config = {
          blocklist: [/\/user/]
        }

        return agent.load('fetch', config)
          .then(() => {
            express = require('express')
            fetch = globalThis.fetch
          })
      })

      it('should skip recording if the url matches an item in the blocklist', done => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        getPort().then(port => {
          const timer = setTimeout(done, 100)

          agent
            .use(() => {
              clearTimeout(timer)
              done(new Error('Blocklisted requests should not be recorded.'))
            })
            .catch(done)

          appListener = server(app, port, () => {
            fetch(`http://localhost:${port}/users`).catch(() => {})
          })
        })
      })
    })
  })
})
