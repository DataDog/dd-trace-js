'use strict'

const { AsyncResource } = require('node:async_hooks')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const http = require('node:http')

const axios = require('axios')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { storage } = require('../../datadog-core')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

describe('Plugin', () => {
  let Router
  let appListener

  function defaultErrorHandler (req, res) {
    return err => {
      res.writeHead(err ? 500 : 404)
      res.end()
    }
  }

  function server (router, errorHandler = defaultErrorHandler) {
    return http.createServer((req, res) => {
      return router(req, res, errorHandler(req, res))
    })
  }

  describe('router', () => {
    withVersions('router', 'router', version => {
      afterEach(() => {
        appListener && appListener.close()
      })

      describe('with middleware disabled', () => {
        before(() => {
          return agent.load(['http', 'router'], [{}, { middleware: false }])
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          Router = require(`../../../versions/router@${version}`).get()
        })

        it('should still set the route on the request span with nested routers', done => {
          const router = Router()
          const childRouter = Router()

          childRouter.use('/child/:id', (req, res) => {
            res.writeHead(200)
            res.end()
          })

          router.use('/parent', childRouter)

          appListener = server(router).listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])
                const requestSpan = spans[0]

                // Route tracking should still work — resource includes the route
                assert.strictEqual(requestSpan.resource, 'GET /parent/child/:id')
                assert.strictEqual(requestSpan.type, 'web')
                assert.strictEqual(requestSpan.meta['http.route'], '/parent/child/:id')
                assert.strictEqual(requestSpan.meta['http.method'], 'GET')
                assert.strictEqual(requestSpan.meta['http.status_code'], '200')

                // No router.middleware spans should be created
                for (const span of spans) {
                  assert.notStrictEqual(span.name, 'router.middleware')
                }
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/parent/child/123`)
              .catch(done)
          })
        })
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load(['http', 'router'])
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          Router = require(`../../../versions/router@${version}`).get()
        })

        it('should copy custom prototypes on routers', () => {
          const router = Router()
          class ChildRouter extends Router {
            get foo () {
              return 'bar'
            }
          }
          const childRouter = new ChildRouter()
          childRouter.hello = 'goodbye'

          childRouter.use('/child/:id', (req, res) => {
            res.writeHead(200)
            res.end()
          })

          router.use('/parent', childRouter)
          const index = router.stack.length - 1
          assert.strictEqual(router.stack[index].handle.hello, 'goodbye')
          assert.strictEqual(router.stack[index].handle.foo, 'bar')
        })

        it('should add the route to the request span', done => {
          const router = Router()
          const childRouter = Router()

          childRouter.use('/child/:id', (req, res) => {
            res.writeHead(200)
            res.end()
          })

          router.use('/parent', childRouter)

          appListener = server(router).listen(0, 'localhost', () => {
            const port = appListener.address().port

            agent
              .assertSomeTraces(traces => {
                const spans = sort(traces[0])

                assert.strictEqual(spans[0].resource, 'GET /parent/child/:id')
              })
              .then(done)
              .catch(done)

            axios
              .get(`http://localhost:${port}/parent/child/123`)
              .catch(done)
          })
        })

        it('should release finished middleware spans from the store captured in-request', async () => {
          // Regression test for unbounded router.middleware span retention.
          //
          // dd-trace activates each middleware span with
          // `AsyncLocalStorage.enterWith({ ...store, span })`. Any async resource
          // created while that store is active snapshots the frame and keeps the
          // store — and its `span` — reachable for the resource's whole lifetime,
          // even after the span finishes. A never-released resource therefore
          // pins the finished span (and its parent chain) forever. The fix nulls
          // the store's `span` when the request finishes.
          //
          // Here we mimic a never-released resource by capturing, from inside a
          // middleware, the exact store object the middleware span was entered
          // into. After the request completes we assert that store no longer
          // references the (now finished) span.
          const router = Router()

          let capturedStore

          router.use((req, res, next) => {
            // The store active here is the one the middleware span was entered
            // into; a real async resource created now would capture it.
            capturedStore = storage('legacy').getStore()
            assert.ok(capturedStore)
            assert.ok(capturedStore.span, 'middleware span should be active in-request')

            // A concrete async resource that snapshots the same frame, standing
            // in for the never-released handles seen in production.
            const resource = new AsyncResource('test-resource')
            resource.runInAsyncScope(() => {})

            next()
          })
          router.get('/foo', (req, res) => {
            res.end()
          })

          const httpd = server(router).listen(0, 'localhost')
          await once(httpd, 'listening')
          const port = httpd.address().port
          await axios.get(`http://localhost:${port}/foo`)

          // Once the request has finished, the span reference must have been
          // released from the captured store so the finished span is collectable
          // even though the captured store (and any resource holding it) lives on.
          assert.strictEqual(capturedStore.span, null)
        })

        it('should keep the active span for async work scheduled after next() while in-flight', async () => {
          // Continuity regression test. `middleware:finish` is published BEFORE
          // `next.apply(...)`, so releasing the entered store at middleware finish
          // would clobber the active span for any callback the middleware
          // schedules to run after `next()` — orphaning its spans and breaking
          // log correlation. Releasing only at request finish preserves it.
          //
          // Here a middleware schedules a `setImmediate` after calling `next()`;
          // the route handler waits for that callback before ending the response,
          // so the assertion runs while the request is still in-flight (after
          // middleware finish, before request finish).
          const tracer = require('../../dd-trace')
          const router = Router()

          let activeInDeferredWork = 'unset'
          let deferredDone
          const deferred = new Promise(resolve => { deferredDone = resolve })

          router.use((req, res, next) => {
            next()

            // Runs after next() returns, i.e. after this middleware's
            // `middleware:finish` has already fired, but while the request is
            // still being handled.
            setImmediate(() => {
              activeInDeferredWork = tracer.scope().active()
              deferredDone()
            })
          })
          router.get('/foo', async (req, res) => {
            await deferred
            res.end()
          })

          const httpd = server(router).listen(0, 'localhost')
          await once(httpd, 'listening')
          const port = httpd.address().port
          await axios.get(`http://localhost:${port}/foo`)

          // The deferred callback must still have seen an active span (the
          // request/middleware span), not null.
          assert.notStrictEqual(activeInDeferredWork, 'unset', 'deferred work should have run')
          assert.ok(activeInDeferredWork, 'deferred work after next() should still have an active span')
        })

        it('should not error a span when using next("route") with a string', async () => {
          const router = Router()

          router.use((req, res, next) => {
            return next('route')
          })
          router.get('/foo', [[[(_req, _res, next) => { next() }]]], (req, res) => {
            res.end()
          })

          const agentPromise = agent.assertSomeTraces(traces => {
            for (const span of traces[0]) {
              assert.strictEqual(span.error, 0)
            }
          }, { rejectFirst: true })

          const httpd = server(router).listen(0, 'localhost')
          await once(httpd, 'listening')
          const port = httpd.address().port
          const reqPromise = axios.get(`http://localhost:${port}/foo`)

          return Promise.all([agentPromise, reqPromise])
        })

        it('should not error a span when using next("router") with a string', async () => {
          const router = Router()

          router.use((req, res, next) => {
            return next('router')
          })
          router.get('/foo', (req, res) => {
            res.end()
          })

          const agentPromise = agent.assertSomeTraces(traces => {
            for (const span of traces[0]) {
              assert.strictEqual(span.error, 0)
            }
          }, { rejectFirst: true })

          const httpd = server(router, (req, res) => err => res.end()).listen(0, 'localhost')
          await once(httpd, 'listening')
          const port = httpd.address().port
          const reqPromise = axios.get(`http://localhost:${port}/foo`)

          return Promise.all([agentPromise, reqPromise])
        })
      })
    })
  })
})
