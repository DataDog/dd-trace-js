'use strict'

// TODO: move tests from express since it uses the router plugin now

const axios = require('axios')
const http = require('http')
const { once } = require('events')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

describe('Plugin', () => {
  let tracer
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
      const web = tracer._pluginManager._pluginsByName.router

      web.instrument(req, res, 'web.request')

      return router(req, res, errorHandler(req, res))
    })
  }

  describe('router', () => {
    withVersions('router', 'router', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      afterEach(() => {
        appListener && appListener.close()
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load(['http', 'router'])
        })

        after(() => {
          return agent.close({ ritmReset: false })
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
          expect(router.stack[index].handle.hello).to.equal('goodbye')
          expect(router.stack[index].handle.foo).to.equal('bar')
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

                expect(spans[0]).to.have.property('resource', 'GET /parent/child/:id')
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
              expect(span.error).to.equal(0)
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
              expect(span.error).to.equal(0)
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
