'use strict'

const assert = require('node:assert/strict')

const semver = require('semver')
const satisfies = require('../../../vendor/dist/semifies')
const tags = require('../../../ext/tags')
const { NODE_MAJOR } = require('../../../version')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { rawExpectedSchema } = require('./naming')
const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS

const SERVICE_NAME = 'test'

// Helper to find an error with a specific type in the caught error's cause chain
// Different undici versions wrap errors differently, so we need to walk the chain
// Returns the matching error object, or null if not found
function findErrorInCauseChain (error, targetErrorType) {
  let current = error
  while (current) {
    if (current.name === targetErrorType) return current
    // Also check errors array in AggregateError
    if (current.errors) {
      for (const e of current.errors) {
        if (e.name === targetErrorType) return e
      }
    }
    current = current.cause
  }
  return null
}

describe('Plugin', () => {
  let express
  let fetch
  let appListener

  describe('undici-fetch', () => {
    withVersions('undici', 'undici', NODE_MAJOR < 20 ? '<7.11.0' : '*', (version, moduleName, resolvedVersion) => {
      function server (app, listener) {
        const server = require('http').createServer(app)
        server.listen(0, 'localhost', () => listener(
          (/** @type {import('net').AddressInfo} */ (server.address())).port)
        )
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
            service: 'test',
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
                assert.strictEqual(traces[0][0].service, 'test')
                assert.strictEqual(traces[0][0].type, 'http')
                assert.strictEqual(traces[0][0].resource, 'GET')
                assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
                assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/user`)
                assert.strictEqual(traces[0][0].meta['http.method'], 'GET')
                assert.strictEqual(traces[0][0].meta['http.status_code'], '200')
                assert.strictEqual(traces[0][0].meta.component, 'undici')
                assert.strictEqual(traces[0][0].meta['_dd.integration'], 'undici')
                assert.strictEqual(traces[0][0].meta['out.host'], 'localhost')
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
                assert.strictEqual(traces[0][0].service, SERVICE_NAME)
                assert.strictEqual(traces[0][0].type, 'http')
                assert.strictEqual(traces[0][0].resource, 'POST')
                assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
                assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/user`)
                assert.strictEqual(traces[0][0].meta['http.method'], 'POST')
                assert.strictEqual(traces[0][0].meta['http.status_code'], '200')
                assert.strictEqual(traces[0][0].meta.component, 'undici')
                assert.strictEqual(traces[0][0].meta['out.host'], 'localhost')
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
                assert.strictEqual(res.status, 200)
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
                assert.strictEqual(traces[0][0].meta['http.status_code'], '200')
                assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/user`)
              })
              .then(done)
              .catch(done)

            fetch.fetch(`http://localhost:${port}/user?foo=bar`)
          })
        })

        it('should inject its parent span in the headers', done => {
          const app = express()

          app.get('/user', (req, res) => {
            assert.strictEqual(typeof req.get('x-datadog-trace-id'), 'string')
            assert.strictEqual(typeof req.get('x-datadog-parent-id'), 'string')

            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].meta['http.status_code'], '200')
              })
              .then(done)
              .catch(done)

            fetch.fetch(`http://localhost:${port}/user?foo=bar`)
          })
        })

        it('should inject its parent span in the existing headers', done => {
          const app = express()

          app.get('/user', (req, res) => {
            assert.strictEqual(typeof req.get('foo'), 'string')
            assert.strictEqual(typeof req.get('x-datadog-trace-id'), 'string')
            assert.strictEqual(typeof req.get('x-datadog-parent-id'), 'string')

            res.status(200).send()
          })

          appListener = server(app, port => {
            agent
              .assertSomeTraces(traces => {
                assert.strictEqual(traces[0][0].meta['http.status_code'], '200')
              })
              .then(done)
              .catch(done)

            fetch.fetch(`http://localhost:${port}/user?foo=bar`, { headers: { foo: 'bar' } })
          })
        })

        it('should handle connection errors', done => {
          let caughtError

          agent
            .assertSomeTraces(traces => {
              const spanErrorType = traces[0][0].meta[ERROR_TYPE]

              // The error in the span should match either the thrown error or something in its cause chain
              // For fetch with native DC (>= 4.7.0), the DC error becomes caught.cause
              // For fetch wrapper (< 4.7.0), it records the thrown error directly
              const error = findErrorInCauseChain(caughtError, spanErrorType)
              assert.ok(error, `Error type ${spanErrorType} should match thrown error or be in cause chain`)

              assertObjectContains(traces, [[{
                error: 1,
                meta: {
                  [ERROR_TYPE]: error.name,
                  [ERROR_MESSAGE]: error.message || error.code,
                  [ERROR_STACK]: error.stack,
                  component: 'undici',
                },
              }]])
            })
            .then(done)
            .catch(done)

          fetch.fetch('http://localhost:7357/user').catch(err => {
            caughtError = err
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
                assert.strictEqual(traces[0][0].error, 0)
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
                assert.strictEqual(traces[0][0].error, 1)
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
                assert.strictEqual(traces[0][0].error, 0)
                assert.ok(!('http.status_code' in traces[0][0].meta))
              })
              .then(done)
              .catch(done)

            const controller = new AbortController()

            fetch.fetch(`http://localhost:${port}/user`, {
              signal: controller.signal,
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
                assert.strictEqual(traces[0][0].service, SERVICE_NAME)
              })
              .then(done)
              .catch(done)

            const controller = new AbortController()

            fetch.fetch(`http://localhost:${port}/user`, {
              signal: controller.signal,
            }).catch(() => {})

            controller.abort()
          })
        })

        // Tests for undici.request() using native diagnostic channels
        // Only run for undici >= 4.7.0 where diagnostic channels were added
        if (semver.satisfies(resolvedVersion, '>=4.7.0')) {
          it('should do automatic instrumentation for undici.request()', function (done) {
            const app = express()
            app.get('/user', (req, res) => {
              res.status(200).send('OK')
            })
            appListener = server(app, port => {
              agent
                .assertFirstTraceSpan({
                  service: 'test',
                  type: 'http',
                  resource: 'GET',
                  meta: {
                    'span.kind': 'client',
                    'http.url': `http://localhost:${port}/user`,
                    'http.method': 'GET',
                    'http.status_code': '200',
                    component: 'undici',
                    'out.host': 'localhost',
                  },
                })
                .then(done)
                .catch(done)

              fetch.request(`http://localhost:${port}/user`, { method: 'GET' })
                .then(({ body }) => body.dump())
                .catch(() => {})
            })
          })

          it('should support POST requests with undici.request()', done => {
            const app = express()
            app.post('/user', (req, res) => {
              res.status(201).send('Created')
            })
            appListener = server(app, port => {
              agent
                .assertFirstTraceSpan({
                  resource: 'POST',
                  meta: {
                    'http.method': 'POST',
                    'http.status_code': '201',
                  },
                })
                .then(done)
                .catch(done)

              fetch.request(`http://localhost:${port}/user`, { method: 'POST' })
                .then(({ body }) => body.dump())
                .catch(() => {})
            })
          })

          it('should inject trace headers in undici.request()', done => {
            const app = express()

            app.get('/user', (req, res) => {
              assert.strictEqual(typeof req.get('x-datadog-trace-id'), 'string')
              assert.strictEqual(typeof req.get('x-datadog-parent-id'), 'string')

              res.status(200).send('OK')
            })

            appListener = server(app, port => {
              agent
                .assertFirstTraceSpan({
                  meta: {
                    'http.status_code': '200',
                  },
                })
                .then(done)
                .catch(done)

              fetch.request(`http://localhost:${port}/user`)
                .then(({ body }) => body.dump())
                .catch(() => {})
            })
          })

          it('should handle connection errors in undici.request()', done => {
            let error

            agent
              .assertSomeTraces(traces => {
                assertObjectContains(traces[0][0], {
                  meta: {
                    [ERROR_TYPE]: error.name,
                    [ERROR_STACK]: error.stack,
                    component: 'undici',
                  },
                })
                assert.ok(traces[0][0].meta[ERROR_MESSAGE])
              })
              .then(done)
              .catch(done)

            fetch.request('http://localhost:7357/user')
              .catch(err => {
                error = err
              })
          })

          it('should record HTTP 4XX responses as errors in undici.request()', done => {
            const app = express()

            app.get('/user', (req, res) => {
              res.status(400).send('Bad Request')
            })

            appListener = server(app, port => {
              agent
                .assertFirstTraceSpan({
                  error: 1,
                })
                .then(done)
                .catch(done)

              fetch.request(`http://localhost:${port}/user`)
                .then(({ body }) => body.dump())
                .catch(() => {})
            })
          })

          it('should not record HTTP 5XX responses as errors in undici.request()', done => {
            const app = express()

            app.get('/user', (req, res) => {
              res.status(500).send('Server Error')
            })

            appListener = server(app, port => {
              agent
                .assertFirstTraceSpan({
                  error: 0,
                })
                .then(done)
                .catch(done)

              fetch.request(`http://localhost:${port}/user`)
                .then(({ body }) => body.dump())
                .catch(() => {})
            })
          })
        }
      })
      describe('with service configuration', () => {
        let config

        beforeEach(() => {
          config = {
            service: 'custom',
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
                assert.strictEqual(traces[0][0].service, 'custom')
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
            headers: ['x-baz', 'x-foo'],
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
                assert.strictEqual(meta[`${HTTP_REQUEST_HEADERS}.x-baz`], 'qux')
                assert.strictEqual(meta[`${HTTP_RESPONSE_HEADERS}.x-foo`], 'bar')
              })
              .then(done)
              .catch(done)

            fetch.fetch(`http://localhost:${port}/user`, {
              headers: {
                'x-baz': 'qux',
              },
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
              },
            },
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
                assert.strictEqual(traces[0][0].meta.foo, '/foo')
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
            propagationBlocklist: [/\/users/],
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
              assert.strictEqual(req.get('x-datadog-trace-id'), undefined)
              assert.strictEqual(req.get('x-datadog-parent-id'), undefined)

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
            blocklist: [/\/user/],
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

      describe('with custom dispatcher', () => {
        beforeEach(() => {
          return agent.load('undici', {
            service: 'test',
          })
            .then(() => {
              express = require('express')
              fetch = require(`../../../versions/undici@${version}`, {}).get()
            })
        })

        afterEach(() => {
          express = null
        })

        it('should preserve custom dispatcher option and trace the request', function (done) {
          // Skip for versions that use fetch wrapping instead of native DC
          // Those versions have the dispatcher issue described in #6439
          if (!satisfies(resolvedVersion, '>=4.7.0 <5.0.0 || >=5.1.0')) {
            this.skip()
            return
          }

          const app = express()
          app.get('/user', (req, res) => {
            res.status(200).send('OK')
          })

          appListener = server(app, port => {
            // Create a custom Agent with specific settings
            // This is the use case from issue #6439
            const customAgent = new fetch.Agent({
              connect: { keepAlive: false },
            })

            agent
              .assertSomeTraces(traces => {
                const span = traces[0][0]
                assert.strictEqual(span.service, 'test')
                assert.strictEqual(span.type, 'http')
                assert.strictEqual(span.resource, 'GET')
              })
              .then(done)
              .catch(done)

            // Make request with custom dispatcher
            // For native DC versions, dispatcher is preserved because we don't wrap fetch at all
            fetch.fetch(`http://localhost:${port}/user`, {
              dispatcher: customAgent,
            }).then(res => {
              assert.strictEqual(res.status, 200)
              return res.text()
            }).then(body => {
              assert.strictEqual(body, 'OK')
            }).catch(done)
          })
        })
      })
    })
  })
})
