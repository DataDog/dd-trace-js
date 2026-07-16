'use strict'

const assert = require('node:assert/strict')
const { AsyncResource } = require('node:async_hooks')
const { once } = require('node:events')
const http = require('node:http')

const axios = require('axios')
const dc = require('dc-polyfill')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

describe('Plugin', () => {
  let Router
  let appListener
  let tracer

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
        before(async () => {
          tracer = await agent.load(['http', 'router'])
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

        it('should ignore postfinish for an untracked request', () => {
          dc.channel('apm:http:server:request:postfinish').publish({ req: {} })
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

        it('should preserve the parent context after the response finishes', async () => {
          const router = Router()
          let continueHandler
          let finishActiveSpan
          let handlerActiveSpan
          let lateSpan
          let rootContext
          let requestSpan
          const gate = new Promise(resolve => {
            continueHandler = resolve
          })
          let finishHandler
          const handlerFinished = new Promise(resolve => {
            finishHandler = resolve
          })

          router.get('/late', async (req, res) => {
            requestSpan = tracer.scope().active()
            rootContext = requestSpan.context()._trace.started[0].context()
            res.once('finish', () => {
              finishActiveSpan = tracer.scope().active()
            })
            res.end()

            await gate

            handlerActiveSpan = tracer.scope().active()
            tracer.trace('late.operation', span => {
              lateSpan = span
            })
            finishHandler()
          })

          appListener = server(router).listen(0, 'localhost')
          await once(appListener, 'listening')
          const port = appListener.address().port

          await axios.get(`http://localhost:${port}/late`)
          continueHandler()
          await handlerFinished

          assert.strictEqual(finishActiveSpan, requestSpan)
          assert.notStrictEqual(handlerActiveSpan, requestSpan)
          assert.strictEqual(handlerActiveSpan.context()._traceId, rootContext._traceId)
          assert.strictEqual(handlerActiveSpan.context()._spanId, rootContext._spanId)
          assert.strictEqual(lateSpan.context()._traceId, requestSpan.context()._traceId)
          assert.strictEqual(lateSpan.context()._parentId, rootContext._spanId)
        })

        it('should release the finished span from a retained async resource', async function () {
          if (!global.gc) this.skip()

          const router = Router()
          let context
          let resource
          let spanReference

          router.get('/retained', (req, res) => {
            const span = tracer.scope().active()
            context = span.context()._trace.started[0].context()
            spanReference = new WeakRef(span)
            resource = new AsyncResource('router-retirement', { requireManualDestroy: true })
            res.end()
          })

          appListener = server(router).listen(0, 'localhost')
          await once(appListener, 'listening')
          const port = appListener.address().port
          await axios.get(`http://localhost:${port}/retained`)

          for (let i = 0; i < 10; i++) {
            global.gc()
            await new Promise(resolve => setImmediate(resolve))
          }

          assert.strictEqual(spanReference.deref(), undefined)
          resource.runInAsyncScope(() => {
            const activeSpan = tracer.scope().active()
            assert.strictEqual(activeSpan.context()._traceId, context._traceId)
            assert.strictEqual(activeSpan.context()._spanId, context._spanId)
          })
          resource.emitDestroy()
        })

        it('should release the restored span from work scheduled after next', async function () {
          if (!global.gc) this.skip()

          const router = Router()
          let context
          let resource
          let spanReference

          router.use((req, res, next) => {
            const span = tracer.scope().active()
            context = span.context()._trace.started[0].context()
            next()
            spanReference = new WeakRef(span)
            resource = new AsyncResource('router-after-next', { requireManualDestroy: true })
          })
          router.get('/after-next', (req, res) => {
            res.end()
          })

          appListener = server(router).listen(0, 'localhost')
          await once(appListener, 'listening')
          const port = appListener.address().port
          await axios.get(`http://localhost:${port}/after-next`)

          for (let i = 0; i < 10; i++) {
            global.gc()
            await new Promise(resolve => setImmediate(resolve))
          }

          assert.strictEqual(spanReference.deref(), undefined)
          resource.runInAsyncScope(() => {
            const activeSpan = tracer.scope().active()
            assert.strictEqual(activeSpan.context()._traceId, context._traceId)
            assert.strictEqual(activeSpan.context()._spanId, context._spanId)
          })
          resource.emitDestroy()
        })
      })
    })
  })
})
