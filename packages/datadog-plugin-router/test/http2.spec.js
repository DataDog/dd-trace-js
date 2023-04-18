'use strict'

// TODO: move tests from express since it uses the router plugin now

/**
 * Axios doesn't support http2. It relies on the server supporting http1 fallback
 * Node uses ALPN, which is a TLS extension, to handle fallback
 * so fallback / allowHTTP1:true is only supported when doing http2.createSecureServer
 *
 * We explicitly want to test for http2 and not worry about keys and certs
 * so we create a h2c server using http2.createServer and use fetch-h2 instead
 */
const fetchH2 = require('fetch-h2').fetch
const http2 = require('http2')
const { once } = require('events')
const getPort = require('get-port')
const agent = require('../../dd-trace/test/plugins/agent')
const web = require('../../dd-trace/src/plugins/util/web')

const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

describe('Plugin with http2 (h2c) server', () => {
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
    return http2.createServer((req, res) => {
      const config = web.normalizeConfig({})

      web.instrument(tracer, config, req, res, 'web.request')

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
          return agent.load(['http2', 'router'])
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(() => {
          /**
           * KLUDGE: Force loading of the http2 server plugin
           * Router internally uses methods, which internally requires http
           * so the http2 plugin was not being loaded
           */
          require('http2')
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
          expect(router.stack[0].handle.hello).to.equal('goodbye')
          expect(router.stack[0].handle.foo).to.equal('bar')
        })

        it('should add the route to the request span', done => {
          const router = Router()
          const childRouter = Router()

          childRouter.use('/child/:id', (req, res) => {
            res.writeHead(200)
            res.end()
          })

          router.use('/parent', childRouter)

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('resource', 'GET /parent/child/:id')
              })
              .then(done)
              .catch(done)

            appListener = server(router).listen(port, 'localhost', () => {
              fetchH2(`http2://localhost:${port}/parent/child/123`)
                .catch(done)
            })
          })
        })

        it('should not error a span when using next("route") with a string', async () => {
          const router = Router()

          router.use((req, res, next) => {
            return next('route')
          })
          router.get('/foo', (req, res) => {
            res.end()
          })

          const port = await getPort()
          const agentPromise = agent.use(traces => {
            for (const span of traces[0]) {
              expect(span.error).to.equal(0)
            }
          }, { rejectFirst: true })

          const httpd = server(router).listen(port, 'localhost')
          await once(httpd, 'listening')
          const reqPromise = fetchH2(`http2://localhost:${port}/foo`)

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

          const port = await getPort()
          const agentPromise = agent.use(traces => {
            for (const span of traces[0]) {
              expect(span.error).to.equal(0)
            }
          }, { rejectFirst: true })

          const httpd = server(router, (req, res) => err => res.end()).listen(port, 'localhost')
          await once(httpd, 'listening')
          const reqPromise = fetchH2(`http2://localhost:${port}/foo`)

          return Promise.all([agentPromise, reqPromise])
        })
      })
    })
  })
})
