'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')

const tags = require('../../../ext/tags')
const { storage } = require('../../datadog-core')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema } = require('../../dd-trace/test/setup/mocha')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { rawExpectedSchema } = require('./naming')
const HTTP_REQUEST_HEADERS = tags.HTTP_REQUEST_HEADERS
const HTTP_RESPONSE_HEADERS = tags.HTTP_RESPONSE_HEADERS

const SERVICE_NAME = 'test'

describe('Plugin', function () {
  this.timeout(0)

  let express
  let fetch
  let appListener

  describe('fetch', () => {
    function server (app, listener) {
      const server = require('http').createServer(app)
      server.listen(0, 'localhost', () => listener((/** @type {import('net').AddressInfo} */ (server.address())).port))
      return server
    }

    beforeEach(() => {
      appListener = null
    })

    afterEach(() => {
      if (appListener) {
        appListener.close()
      }
      return agent.close()
    })

    describe('with OTel semantics enabled', () => {
      beforeEach(() => {
        process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED = 'true'
        return agent.load('fetch')
          .then(() => {
            express = require('express')
            fetch = globalThis.fetch
          })
      })

      afterEach(() => {
        delete process.env.DD_TRACE_OTEL_SEMANTICS_ENABLED
      })

      // fetch passes a URL object, whose query lives in `search` (not `path`);
      // url.full must still retain the (obfuscated) query under OTel semantics.
      it('retains the query string in url.full', done => {
        const app = express()
        app.get('/user', (req, res) => {
          res.status(200).send()
        })
        appListener = server(app, port => {
          agent.assertFirstTraceSpan({
            meta: {
              'span.kind': 'client',
              'http.request.method': 'GET',
              'url.full': `http://localhost:${port}/user?foo=bar`,
            },
            metrics: {
              'http.response.status_code': 200,
            },
          })
            .then(done)
            .catch(done)

          fetch(`http://localhost:${port}/user?foo=bar`)
        })
      })
    })

    describe('without configuration', () => {
      beforeEach(() => {
        return agent.load('fetch')
          .then(() => {
            express = require('express')
            fetch = globalThis.fetch
          })
      })

      withNamingSchema(
        () => {
          const app = express()
          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = server(app, port => {
            fetch(`http://localhost:${port}/user`)
          })
        },
        rawExpectedSchema.client
      )

      it('should do automatic instrumentation', done => {
        const app = express()
        app.get('/user', (req, res) => {
          res.status(200).send()
        })
        appListener = server(app, port => {
          agent.assertFirstTraceSpan({
            service: SERVICE_NAME,
            type: 'http',
            resource: 'GET',
            meta: {
              'span.kind': 'client',
              'http.url': `http://localhost:${port}/user`,
              'http.method': 'GET',
              'http.status_code': '200',
              component: 'fetch',
              '_dd.integration': 'fetch',
              'out.host': 'localhost',
            },
          })
            .then(done)
            .catch(done)

          fetch(`http://localhost:${port}/user`)
        })
      })

      it('should support URL input', done => {
        const app = express()
        app.post('/user', (req, res) => {
          res.status(200).send()
        })
        appListener = server(app, port => {
          agent.assertFirstTraceSpan({
            service: SERVICE_NAME,
            type: 'http',
            resource: 'POST',
            meta: {
              'span.kind': 'client',
              'http.url': `http://localhost:${port}/user`,
              'http.method': 'POST',
              'http.status_code': '200',
              component: 'fetch',
              'out.host': 'localhost',
            },
          })
            .then(done)
            .catch(done)

          fetch(new URL(`http://localhost:${port}/user`), { method: 'POST' })
        })
      })

      it('should support Request input', done => {
        const app = express()
        app.get('/user', (req, res) => {
          res.status(200).send()
        })
        appListener = server(app, port => {
          agent.assertFirstTraceSpan({
            service: SERVICE_NAME,
            type: 'http',
            resource: 'GET',
            meta: {
              'span.kind': 'client',
              'http.url': `http://localhost:${port}/user`,
              'http.method': 'GET',
              'http.status_code': '200',
              component: 'fetch',
              'out.host': 'localhost',
            },
          })
            .then(done)
            .catch(done)

          fetch(new globalThis.Request(`http://localhost:${port}/user`))
        })
      })

      it('should return the response', done => {
        const app = express()
        app.get('/user', (req, res) => {
          res.status(200).send()
        })
        appListener = server(app, port => {
          fetch(new globalThis.Request(`http://localhost:${port}/user`))
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
          agent.assertFirstTraceSpan({
            meta: {
              'http.status_code': '200',
              'http.url': `http://localhost:${port}/user`,
            },
          })
            .then(done)
            .catch(done)

          fetch(`http://localhost:${port}/user?foo=bar`)
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
          agent.assertFirstTraceSpan({
            meta: {
              'http.status_code': '200',
            },
          })
            .then(done)
            .catch(done)

          fetch(`http://localhost:${port}/user?foo=bar`)
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
          agent.assertFirstTraceSpan({
            meta: {
              'http.status_code': '200',
            },
          })
            .then(done)
            .catch(done)

          fetch(`http://localhost:${port}/user?foo=bar`, { headers: { foo: 'bar' } })
        })
      })

      it('should handle connection errors', done => {
        let error

        agent
          .assertSomeTraces(traces => {
            assertObjectContains(traces[0][0].meta, {
              [ERROR_TYPE]: error.name,
              [ERROR_MESSAGE]: error.message || error.code,
              [ERROR_STACK]: error.stack,
              component: 'fetch',
            })
          })
          .then(done)
          .catch(done)

        fetch('http://localhost:7357/user').catch(err => {
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
              assert.strictEqual(traces[0][0].error, 0)
            })
            .then(done)
            .catch(done)

          fetch(`http://localhost:${port}/user`)
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

          fetch(`http://localhost:${port}/user`)
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

          fetch(`http://localhost:${port}/user`, {
            signal: controller.signal,
          }).catch(e => {})

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

          fetch(`http://localhost:${port}/user`, {
            signal: controller.signal,
          }).catch(e => {})

          controller.abort()
        })
      })

      it('should abort an in-flight response body after garbage collection', async function () {
        if (typeof globalThis.gc !== 'function') this.skip()

        // Without the fix the read never settles, so fail fast instead of hanging.
        this.timeout(5000)

        const app = express()

        app.get('/stream', (req, res) => {
          res.write('chunk')
        })

        const port = await new Promise(resolve => {
          appListener = server(app, resolve)
        })

        const controller = new AbortController()
        const res = await fetch(`http://localhost:${port}/stream`, { signal: controller.signal })
        const reader = res.body.getReader()

        await reader.read()

        // The signal of the intermediate request must not be collected while the user's signal can still abort.
        for (let i = 0; i < 5; i++) {
          globalThis.gc()
          await new Promise(resolve => setImmediate(resolve))
        }

        const read = assert.rejects(reader.read(), { name: 'AbortError' })

        controller.abort()

        await read
      })

      for (const initType of ['object', 'Request', 'function']) {
        it(`should preserve body, headers and referrer policy with a signal in ${initType} init`, async () => {
          const app = express()
          const received = {}

          app.post('/echo', express.text(), (req, res) => {
            received.body = req.body
            received.traceparent = req.headers.traceparent
            received.referrer = req.headers.referer
            received.contentType = req.headers['content-type']
            res.status(200).send()
          })

          const port = await new Promise(resolve => {
            appListener = server(app, resolve)
          })

          const controller = new AbortController()
          const origin = `http://localhost:${port}/`
          const referrer = `${origin}source?foo=bar`
          const url = `${origin}echo`
          const options = {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: 'payload',
            signal: controller.signal,
            referrer,
            referrerPolicy: 'origin',
          }
          const init = initType === 'Request'
            ? new globalThis.Request(url, options)
            : initType === 'function' ? Object.assign(() => {}, options) : options
          Object.freeze(init)

          const [res] = await Promise.all([
            fetch(url, init),
            agent.assertFirstTraceSpan({
              resource: 'POST',
              meta: { component: 'fetch', 'http.status_code': '200' },
            }),
          ])

          assert.strictEqual(received.referrer, origin)
          assert.strictEqual(res.status, 200)
          assert.strictEqual(received.body, 'payload')
          assert.strictEqual(received.contentType, 'text/plain')
          assert.match(received.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/)
        })
      }

      it('should preserve validation of primitive init', () => {
        assert.throws(() => fetch('http://localhost/', 1), { name: 'TypeError' })
      })

      it('should reject with AbortError when the signal is already aborted', async () => {
        const app = express()

        app.get('/user', (req, res) => res.status(200).send())

        const port = await new Promise(resolve => {
          appListener = server(app, resolve)
        })

        await assert.rejects(
          fetch(`http://localhost:${port}/user`, { signal: AbortSignal.abort() }),
          { name: 'AbortError' }
        )
      })

      it('should skip requests marked as noop', done => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        appListener = server(app, port => {
          agent
            .assertNoTraces(() => {
              throw new Error('Noop request was traced.')
            }, { timeoutMs: 100 })
            .then(done, done)

          const store = storage('legacy').getStore()

          storage('legacy').enterWith({ noop: true })

          fetch(`http://localhost:${port}/user`).catch(() => {})

          storage('legacy').enterWith(store)
        })
      })
    })

    describe('with service configuration', () => {
      let config

      beforeEach(() => {
        config = {
          service: 'custom',
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

        appListener = server(app, port => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].service, 'custom')
            })
            .then(done)
            .catch(done)

          fetch(`http://localhost:${port}/user`).catch(() => {})
        })
      })
    })

    describe('with validateStatus configuration', () => {
      let config

      beforeEach(() => {
        config = {
          validateStatus: status => status < 500,
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

        appListener = server(app, port => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].error, 1)
            })
            .then(done)
            .catch(done)

          fetch(`http://localhost:${port}/user`).catch(() => {})
        })
      })
    })

    describe('with splitByDomain configuration', () => {
      let config

      beforeEach(() => {
        config = {
          splitByDomain: true,
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

        appListener = server(app, port => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].service, `localhost:${port}`)
              assert.strictEqual(traces[0][0].meta['_dd.svc_src'], 'opt.split_by_domain')
            })
            .then(done)
            .catch(done)

          fetch(`http://localhost:${port}/user`).catch(() => {})
        })
      })
    })

    describe('with headers configuration', () => {
      let config

      beforeEach(() => {
        config = {
          headers: ['x-baz', 'x-foo'],
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

        appListener = server(app, port => {
          agent
            .assertSomeTraces(traces => {
              const meta = traces[0][0].meta

              assert.strictEqual(meta[`${HTTP_REQUEST_HEADERS}.x-baz`], 'qux')
              assert.strictEqual(meta[`${HTTP_RESPONSE_HEADERS}.x-foo`], 'bar')
            })
            .then(done)
            .catch(done)

          fetch(`http://localhost:${port}/user`, {
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
              span.setTag('service.name', 'override')
            },
          },
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

        appListener = server(app, port => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].meta.foo, '/foo')
            })
            .then(done)
            .catch(done)

          fetch(`http://localhost:${port}/user`).catch(() => {})
        })
      })

      it('should have manual stamp when doing an override through config hook', done => {
        const app = express()

        app.get('/user', (req, res) => {
          res.status(200).send()
        })

        appListener = server(app, port => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].meta['_dd.svc_src'], 'm')
            })
            .then(done)
            .catch(done)

          fetch(`http://localhost:${port}/user`).catch(() => {})
        })
      })
    })

    describe('with propagationBlocklist configuration', () => {
      let config

      beforeEach(() => {
        config = {
          propagationBlocklist: [/\/users/],
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
            assert.strictEqual(req.get('x-datadog-trace-id'), undefined)
            assert.strictEqual(req.get('x-datadog-parent-id'), undefined)

            res.status(200).send()

            done()
          } catch (e) {
            done(e)
          }
        })

        appListener = server(app, port => {
          fetch(`http://localhost:${port}/users`).catch(() => {})
        })
      })
    })

    describe('with blocklist configuration', () => {
      let config

      beforeEach(() => {
        config = {
          blocklist: [/\/user/],
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

        appListener = server(app, port => {
          agent
            .assertNoTraces(() => {
              throw new Error('Blocklisted requests should not be recorded.')
            }, { timeoutMs: 100 })
            .then(done, done)

          fetch(`http://localhost:${port}/users`).catch(() => {})
        })
      })
    })

    describe('in serverless', () => {
      beforeEach(() => {
        process.env.DD_TRACE_EXPERIMENTAL_EXPORTER = 'agent'
        process.env.AWS_LAMBDA_FUNCTION_NAME = 'test'
      })

      beforeEach(() => {
        return agent.load('fetch')
          .then(() => {
            express = require('express')
            fetch = globalThis.fetch
          })
      })

      beforeEach(() => {
        delete process.env.DD_TRACE_EXPERIMENTAL_EXPORTER
        delete process.env.AWS_LAMBDA_FUNCTION_NAME
      })

      withNamingSchema(
        () => {
          const app = express()
          app.get('/user', (req, res) => {
            res.status(200).send()
          })

          appListener = server(app, port => {
            fetch(`http://localhost:${port}/user`)
          })
        },
        rawExpectedSchema.client
      )

      it('should do automatic instrumentation', done => {
        const app = express()
        app.get('/user', (req, res) => {
          res.status(200).send()
        })
        appListener = server(app, port => {
          agent.assertFirstTraceSpan({
            service: SERVICE_NAME,
            type: 'http',
            resource: 'GET',
            meta: {
              'span.kind': 'client',
              'http.url': `http://localhost:${port}/user`,
              'http.method': 'GET',
              'http.status_code': '200',
              component: 'fetch',
              'out.host': 'localhost',
            },
          })
            .then(done)
            .catch(done)

          fetch(`http://localhost:${port}/user`)
        })
      })
    })
  })
})
