'use strict'

const { AsyncLocalStorage } = require('async_hooks')
const axios = require('axios')
const getPort = require('get-port')
const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')

describe('Plugin', () => {
  let tracer
  let restify
  let appListener

  describe('restify', () => {
    withVersions('restify', 'restify', version => {
      const pkgVersion = require(`../../../versions/restify@${version}`).version()

      // Some internal code of older versions is not compatible with Node >6
      if (semver.intersects(pkgVersion, '<5')) return

      beforeEach(() => {
        tracer = require('../../dd-trace')
        restify = require(`../../../versions/restify@${version}`).get()
      })

      afterEach(() => {
        appListener.close()
      })

      describe('without configuration', () => {
        before(() => agent.load(['restify', 'find-my-way', 'http'], [{}, {}, { client: false }]))
        after(() => agent.close({ ritmReset: false }))

        it('should do automatic instrumentation', done => {
          const server = restify.createServer()

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('name', 'restify.request')
                expect(traces[0][0]).to.have.property('service', 'test')
                expect(traces[0][0]).to.have.property('type', 'web')
                expect(traces[0][0]).to.have.property('resource', 'GET')
                expect(traces[0][0].meta).to.have.property('span.kind', 'server')
                expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
                expect(traces[0][0].meta).to.have.property('http.method', 'GET')
                expect(traces[0][0].meta).to.have.property('http.status_code', '404')
              })
              .then(done)
              .catch(done)

            appListener = server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`)
                .catch(() => {})
            })
          })
        })

        it('should support routing', done => {
          const server = restify.createServer()

          server.get('/user/:id', (req, res, next) => {
            res.send(200)
            return next()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', 'GET /user/:id')
                expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user/123`)
              })
              .then(done)
              .catch(done)

            appListener = server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user/123`)
                .catch(done)
            })
          })
        })

        it('should run handlers in the request scope', done => {
          const server = restify.createServer()
          const interval = setInterval(() => {
            if (next) {
              next()
              clearInterval(interval)
            }
          })

          let next

          server.pre((req, res, next) => {
            expect(tracer.scope().active()).to.not.be.null
            next()
          })

          // break the async context
          server.use((req, res, _next) => {
            next = _next
          })

          server.use((req, res, next) => {
            expect(tracer.scope().active()).to.not.be.null
            next()
          })

          server.get('/user', (req, res, next) => {
            expect(tracer.scope().active()).to.not.be.null
            res.send(200)
            done()
            next()
          })

          getPort().then(port => {
            appListener = server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })
        })

        it('should support array middleware', done => {
          const server = restify.createServer()

          server.get('/user/:id', [(req, res, next) => {
            res.send(200)
            return next()
          }])

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', 'GET /user/:id')
                expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user/123`)
              })
              .then(done)
              .catch(done)

            appListener = server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user/123`)
                .catch(done)
            })
          })
        })

        it('should keep user stores untouched', done => {
          const server = restify.createServer()
          const storage = new AsyncLocalStorage()
          const store = {}

          server.use((req, res, next) => {
            storage.run(store, () => next())
          })

          server.get('/user', (req, res, next) => {
            try {
              expect(storage.getStore()).to.equal(store)
              done()
            } catch (e) {
              done(e)
            }

            res.end()
          })

          getPort().then(port => {
            appListener = server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })
        })

        it('should allow handleUncaughtException', done => {
          const server = restify.createServer({
            handleUncaughtExceptions: true,
            log: {
              trace: function () {},
              warn: function () {}
            }
          })
          server.on('uncaughtException', function (req, res, route, err) {
            res.send(599)
          })

          server.get('/error', [(req, res, next) => {
            throw new Error('uncaught')
          }])

          getPort().then(port => {
            agent
              .use(traces => {
                expect(traces[0][0]).to.have.property('resource', 'GET /error')
                expect(traces[0][0].meta).to.have.property('error.msg', 'uncaught')
                expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/error`)
                expect(traces[0][0].meta).to.have.property('http.status_code', '599')
              })
              .then(done)
              .catch(done)

            appListener = server.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/error`, {
                  validateStatus: status => status === 599
                })
                .catch(done)
            })
          })
        })
      })
    })
  })
})
