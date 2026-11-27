'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const http = require('node:http')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')
const sinon = require('sinon')

const { storage } = require('../../datadog-core')
const { ERROR_MESSAGE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const httpRequest = require('../../dd-trace/test/setup/helpers/http-client')
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
    withVersions('router', 'router', (version, _, resolvedVersion) => {
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

        it('preserves native dispatch for a global regexp in an array with a root route', async function () {
          if (semver.lt(resolvedVersion, '2.0.0')) this.skip()

          const router = Router()
          router.get([/^\/items\/[0-9]+$/g, '/'], (_req, res) => res.end())
          appListener = server(router).listen(0, '127.0.0.1')
          await once(appListener, 'listening')
          const url = `http://127.0.0.1:${appListener.address().port}/items/42`

          const first = await fetch(url)
          const second = await fetch(url)
          assert.strictEqual(first.status, 200)
          assert.strictEqual(second.status, 404)
        })

        it('reports the native winner when a global regexp and a string match the same path', async function () {
          if (semver.lt(resolvedVersion, '2.0.0')) this.skip()

          const pattern = /^\/$/g
          const router = Router()
          const lastIndexes = []
          router.get([pattern, '/'], (_req, res) => {
            lastIndexes.push(pattern.lastIndex)
            res.end()
          })
          appListener = server(router).listen(0, '127.0.0.1')
          await once(appListener, 'listening')
          const url = `http://127.0.0.1:${appListener.address().port}/`
          const resources = []
          for (let i = 0; i < 2; i++) {
            const [response] = await Promise.all([
              fetch(url),
              agent.assertFirstTraceSpan(span => {
                resources.push(span.resource)
              }),
            ])
            assert.strictEqual(response.status, 200)
          }
          assert.deepStrictEqual(lastIndexes, [1, 0])
          assert.deepStrictEqual(resources, [`GET (${pattern})`, 'GET'])
        })

        it('keeps the native match across overlapping parameter callbacks', async function () {
          if (semver.lt(resolvedVersion, '2.0.0')) this.skip()

          const pattern = /^(?<item>\/items\/[0-9]+)$/g
          const mount = '/tenants/:tenant'
          const outer = Router()
          const router = Router({ mergeParams: true })
          let waitForSecond
          const firstSelection = new Promise(resolve => { waitForSecond = resolve })
          router.param('item', (req, res, next, value) => {
            if (value === '/items/42') {
              waitForSecond(next)
            } else {
              next()
            }
          })
          router.get([['/unused', '/other'], pattern, '/items/:item', '/health'], (req, res) => {
            res.end(req.params.tenant + ':' + req.params.item)
          })
          outer.use(mount, router)
          appListener = server(outer).listen(0, '127.0.0.1')
          await once(appListener, 'listening')
          const url = `http://127.0.0.1:${appListener.address().port}/tenants/acme/items/42`
          const first = fetch(url)
          const second = (async () => {
            const resume = await firstSelection
            let firstTrace
            try {
              const [response] = await Promise.all([
                fetch(url),
                agent.assertFirstTraceSpan({ resource: `GET ${mount}/items/:item` }),
              ])
              assert.strictEqual(await response.text(), 'acme:42')
              firstTrace = agent.assertFirstTraceSpan({ resource: `GET ${mount}(${pattern})` })
            } finally {
              resume()
            }
            await firstTrace
          })()
          const [response] = await Promise.all([first, second])
          assert.strictEqual(await response.text(), 'acme:/items/42')
        })

        for (const { option, paths, url } of [
          { option: 'caseSensitive', paths: ['/Items/:alternate', '/items/:id//'], url: '/items/42' },
          { option: 'strict', paths: ['/items/:alternate', '/items/:id/'], url: '/items/42/' },
        ]) {
          it(`uses the native ${option} option for a grouped legacy matcher`, async function () {
            if (!semver.satisfies(resolvedVersion, '>=2 <2.3')) this.skip()

            const router = Router({ [option]: true })
            router.get([paths, '/health'], (req, res) => res.end(req.params.id))
            appListener = server(router).listen(0, '127.0.0.1')
            await once(appListener, 'listening')
            const [response] = await Promise.all([
              fetch(`http://127.0.0.1:${appListener.address().port}${url}`),
              agent.assertFirstTraceSpan({ resource: `GET ${paths[1]}` }),
            ])
            assert.strictEqual(await response.text(), '42')
          })
        }

        it('preserves the route when enabled from a parameter callback', async function () {
          if (semver.lt(resolvedVersion, '2.0.0')) this.skip()

          const tracer = require('../../dd-trace')
          tracer.use('router', false)
          const router = Router()
          router.param('id', (req, res, next) => {
            tracer.use('router', { middleware: false })
            next()
          })
          router.get(['/items/:id', '/health'], (req, res) => res.end(req.params.id))
          appListener = server(router).listen(0, '127.0.0.1')
          await once(appListener, 'listening')
          const url = `http://127.0.0.1:${appListener.address().port}/items/42`
          for (let request = 0; request < 2; request++) {
            const [response] = await Promise.all([
              fetch(url),
              agent.assertFirstTraceSpan({ resource: 'GET /items/:id' }),
            ])
            assert.strictEqual(await response.text(), '42')
          }
        })

        it('preserves the native error middleware path for an array of mounts', async function () {
          if (semver.lt(resolvedVersion, '2.0.0')) this.skip()

          const router = Router()
          router.use((req, res, next) => next(new Error('route failure')))
          router.use(['/items/:id', '/health'], (error, req, res, next) => {
            res.statusCode = 500
            res.end(error.message + ':' + req.params.id)
          })
          appListener = server(router).listen(0, '127.0.0.1')
          await once(appListener, 'listening')
          const [response] = await Promise.all([
            fetch(`http://127.0.0.1:${appListener.address().port}/items/42`),
            agent.assertFirstTraceSpan({ resource: 'GET /items/:id' }),
          ])
          assert.strictEqual(response.status, 500)
          assert.strictEqual(await response.text(), 'route failure:42')
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
        const itWithRequestLocalRoutes = semver.gte(resolvedVersion, '2.3.0') ? it : it.skip

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

        itWithRequestLocalRoutes('should keep matched routes local while parameter callbacks overlap', async () => {
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

        itWithRequestLocalRoutes('should use the native case-sensitive pattern for error handlers', async () => {
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
