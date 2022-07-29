'use strict'

// TODO: move tests from express since it uses the router plugin now

const axios = require('axios')
const http = require('http')
const getPort = require('get-port')
const agent = require('../../dd-trace/test/plugins/agent')
const web = require('../../dd-trace/src/plugins/util/web')

const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

describe('Plugin', () => {
  let tracer
  let Router
  let appListener

  function server (router) {
    return http.createServer((req, res) => {
      const config = web.normalizeConfig({})

      web.instrument(tracer, config, req, res, 'http.request')

      return router(req, res, err => {
        res.writeHead(err ? 500 : 404)
        res.end()
      })
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
              axios
                .get(`http://localhost:${port}/parent/child/123`)
                .catch(done)
            })
          })
        })
      })
    })
  })
})
