'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const http = require('node:http')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { storage } = require('../../datadog-core')
const { ERROR_MESSAGE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const httpRequest = require('../../dd-trace/test/setup/helpers/http-client')
const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

/** @param {string} version */
function hasRequestLocalRoutes (version) {
  try {
    return typeof require(`../../../versions/router@${version}`).get('router/lib/symbols').matchedRoute === 'symbol'
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' || !error.message.includes("'router/lib/symbols'")) throw error
    return false
  }
}

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
          return agent.close()
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

            httpRequest
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

            httpRequest
              .get(`http://localhost:${port}/parent/child/123`)
              .catch(done)
          })
        })

        for (const { childPaths, route } of [
          { childPaths: ['/child/:id', '/kid/:id'], route: '/guardian/kid/:id' },
          {
            childPaths: [/^\/child\/([^/]+)/, /^\/kid\/([^/]+)/],
            route: '/guardian(/^\\/kid\\/([^/]+)/)',
          },
        ]) {
          it(`should add the matching route from ${childPaths} to the request span`, async () => {
            const router = Router()
            const childRouter = Router()
            childRouter.use(childPaths, (req, res) => res.end('matched'))
            router.use(['/parent', '/guardian'], childRouter)

            appListener = server(router).listen(0, 'localhost')
            await once(appListener, 'listening')
            const [, response] = await Promise.all([
              agent.assertSomeTraces(traces => {
                const root = sort(traces[0])[0]
                assert.strictEqual(root.resource, `GET ${route}`)
                assert.strictEqual(root.meta['http.route'], route)
              }),
              httpRequest.get(`http://localhost:${appListener.address().port}/guardian/kid/123`),
            ])
            assert.strictEqual(response.data, 'matched')
          })
        }

        it('should keep matched routes local while parameter callbacks overlap', async function () {
          if (!hasRequestLocalRoutes(version)) this.skip()

          const router = Router()
          const gates = new Map()
          let allEntered
          const entered = new Promise(resolve => { allEntered = resolve })
          router.param('id', async (req, res, next, id) => {
            await new Promise(resolve => {
              gates.set(id, resolve)
              if (gates.size === 2) allEntered()
            })
            next()
          })
          router.use(['/first/:id', '/second/:id'], (req, res) => res.end(req.params.id))
          appListener = server(router).listen(0, 'localhost')
          await once(appListener, 'listening')

          const routes = new Set()
          const traces = agent.assertSomeTraces(batch => {
            for (const trace of batch) {
              routes.add(sort(trace)[0].resource)
            }
            assert.deepStrictEqual(routes, new Set(['GET /first/:id', 'GET /second/:id']))
          })
          const responses = Promise.all([
            httpRequest.get(`http://localhost:${appListener.address().port}/first/1`),
            httpRequest.get(`http://localhost:${appListener.address().port}/second/2`),
          ])
          const [results] = await Promise.all([
            responses,
            traces,
            (async () => {
              await entered
              for (const id of ['2', '1']) {
                const resume = gates.get(id)
                resume()
              }
            })(),
          ])
          assert.deepStrictEqual(results.map(response => response.data), [1, 2])
        })

        it('should use the native case-sensitive pattern for error handlers', async function () {
          if (!hasRequestLocalRoutes(version)) this.skip()
          const router = Router({ caseSensitive: true })
          const failure = new Error('failure')
          router.use((req, res, next) => next(failure))
          router.use(['/KID/:id', '/kid/:id'], (error, req, res, next) => {
            assert.strictEqual(error, failure)
            res.end(error.message)
          })
          appListener = server(router).listen(0, 'localhost')
          await once(appListener, 'listening')
          const [, response] = await Promise.all([
            agent.assertSomeTraces(traces => {
              const root = sort(traces[0])[0]
              assert.strictEqual(root.resource, 'GET /kid/:id')
              assert.strictEqual(root.meta['http.route'], '/kid/:id')
            }),
            httpRequest.get(`http://localhost:${appListener.address().port}/kid/123`),
          ])
          assert.strictEqual(response.data, 'failure')
        })

        it('should keep req.next equal to the next passed to middleware', async () => {
          const router = Router()
          const childRouter = Router()
          const seen = []

          router.use((req, res, next) => {
            seen.push(next === req.next)
            next()
          })
          childRouter.use((req, res, next) => {
            seen.push(next === req.next)
            next()
          })
          router.use(childRouter)
          router.use((req, res, next) => {
            seen.push(next === req.next)
            res.end()
          })

          const httpd = server(router).listen(0, 'localhost')
          await once(httpd, 'listening')
          await httpRequest.get(`http://localhost:${httpd.address().port}/`)
          httpd.close()

          assert.deepStrictEqual(seen, [true, true, true])
        })

        it('should keep req.next at the router level inside route handlers', async () => {
          const router = Router()

          // `req.next` advances to the next route, not to the current route's next handler.
          router.get('/next', (req, res) => req.next(), (req, res) => res.end('same route'))
          router.get('/next', (req, res) => res.end('next route'))

          const httpd = server(router).listen(0, 'localhost')
          await once(httpd, 'listening')
          const response = await httpRequest.get(`http://localhost:${httpd.address().port}/next`)
          httpd.close()

          assert.strictEqual(response.data, 'next route')
        })

        it('should finish middleware spans when req.next() is called', async () => {
          const router = Router()
          let span

          router.use((req, res, next) => {
            span = storage('legacy').getStore()?.span
            sinon.spy(span, 'finish')
            req.next()
          })
          router.use((req, res) => {
            sinon.assert.called(span.finish)
            res.end()
          })

          const httpd = server(router).listen(0, 'localhost')
          await once(httpd, 'listening')
          const response = await httpRequest.get(`http://localhost:${httpd.address().port}/`)
          httpd.close()

          assert.strictEqual(response.status, 200)
        })

        it('should tag the middleware span with errors forwarded through req.next', async () => {
          const router = Router()
          const error = new Error('forwarded')

          router.use(function forward (req, res) {
            req.next(error)
          })

          const tracePromise = agent.assertSomeTraces(traces => {
            const span = traces[0].find(span => span.name === 'router.middleware' && span.resource === 'forward')
            assert.ok(span, 'the forwarding middleware should have a span')
            assert.strictEqual(span.error, 1)
            assert.strictEqual(span.meta[ERROR_MESSAGE], 'forwarded')
          })

          const httpd = server(router).listen(0, 'localhost')
          await once(httpd, 'listening')
          const responsePromise = httpRequest.get(`http://localhost:${httpd.address().port}/`, {
            validateStatus: () => true,
          })
          const [, response] = await Promise.all([tracePromise, responsePromise])
          httpd.close()

          assert.strictEqual(response.status, 500)
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
          const reqPromise = httpRequest.get(`http://localhost:${port}/foo`)

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
          const reqPromise = httpRequest.get(`http://localhost:${port}/foo`)

          return Promise.all([agentPromise, reqPromise])
        })
      })
    })
  })
})
