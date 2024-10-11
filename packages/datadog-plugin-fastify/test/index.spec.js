'use strict'

const { AsyncLocalStorage } = require('async_hooks')
const axios = require('axios')
const semver = require('semver')
const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { NODE_MAJOR } = require('../../../version')

const host = 'localhost'

describe('Plugin', () => {
  let tracer
  let fastify
  let app

  describe('fastify', () => {
    withVersions('fastify', 'fastify', (version, _, specificVersion) => {
      if (NODE_MAJOR <= 18 && semver.satisfies(specificVersion, '>=5')) return

      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      afterEach(() => {
        app.close()
      })

      withExports('fastify', version, ['default', 'fastify'], '>=3', getExport => {
        describe('without configuration', () => {
          before(() => {
            return agent.load(['fastify', 'find-my-way', 'http'], [{}, {}, { client: false }])
          })

          after(() => {
            return agent.close({ ritmReset: false, wipe: true })
          })

          beforeEach(() => {
            fastify = getExport()
            app = fastify()

            if (semver.intersects(version, '>=3')) {
              return app.register(require('../../../versions/middie').get())
            }
          })

          it('should do automatic instrumentation on the app routes', done => {
            app.get('/user', (request, reply) => {
              reply.send()
            })

            app.listen({ host, port: 0 }, () => {
              const port = app.server.address().port

              agent
                .use(traces => {
                  const spans = traces[0]

                  expect(spans[0]).to.have.property('name', 'fastify.request')
                  expect(spans[0]).to.have.property('service', 'test')
                  expect(spans[0]).to.have.property('type', 'web')
                  expect(spans[0]).to.have.property('resource', 'GET /user')
                  expect(spans[0].meta).to.have.property('span.kind', 'server')
                  expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user`)
                  expect(spans[0].meta).to.have.property('http.method', 'GET')
                  expect(spans[0].meta).to.have.property('http.status_code', '200')
                  expect(spans[0].meta).to.have.property('component', 'fastify')
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })

          it('should do automatic instrumentation on route full syntax', done => {
            app.route({
              method: 'GET',
              url: '/user/:id',
              handler: (request, reply) => {
                reply.send()
              }
            })

            app.listen({ host, port: 0 }, () => {
              const port = app.server.address().port

              agent
                .use(traces => {
                  const spans = traces[0]

                  expect(spans[0]).to.have.property('name', 'fastify.request')
                  expect(spans[0]).to.have.property('service', 'test')
                  expect(spans[0]).to.have.property('type', 'web')
                  expect(spans[0]).to.have.property('resource', 'GET /user/:id')
                  expect(spans[0].meta).to.have.property('span.kind', 'server')
                  expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user/123`)
                  expect(spans[0].meta).to.have.property('http.method', 'GET')
                  expect(spans[0].meta).to.have.property('http.status_code', '200')
                  expect(spans[0].meta).to.have.property('component', 'fastify')
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/user/123`)
                .catch(done)
            })
          })

          if (semver.intersects(version, '>=1.2')) {
            it('should do automatic instrumentation on route with handler in options', done => {
              app.get('/user/:id', {
                handler: (request, reply) => {
                  reply.send()
                }
              })

              app.listen({ host, port: 0 }, () => {
                const port = app.server.address().port

                agent
                  .use(traces => {
                    const spans = traces[0]

                    expect(spans[0]).to.have.property('name', 'fastify.request')
                    expect(spans[0]).to.have.property('service', 'test')
                    expect(spans[0]).to.have.property('type', 'web')
                    expect(spans[0]).to.have.property('resource', 'GET /user/:id')
                    expect(spans[0].meta).to.have.property('span.kind', 'server')
                    expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/user/123`)
                    expect(spans[0].meta).to.have.property('http.method', 'GET')
                    expect(spans[0].meta).to.have.property('http.status_code', '200')
                    expect(spans[0].meta).to.have.property('component', 'fastify')
                  })
                  .then(done)
                  .catch(done)

                axios
                  .get(`http://localhost:${port}/user/123`)
                  .catch(done)
              })
            })
          }

          it('should run handlers in the request scope', done => {
            app.use((req, res, next) => {
              expect(tracer.scope().active()).to.not.be.null
              next()
            })

            app.get('/user', (request, reply) => {
              expect(tracer.scope().active()).to.not.be.null
              reply.send()
            })

            app.listen({ host, port: 0 }, () => {
              const port = app.server.address().port

              axios.get(`http://localhost:${port}/user`)
                .then(() => done())
                .catch(done)
            })
          })

          it('should run middleware in the request scope', done => {
            app.use((req, res, next) => {
              expect(tracer.scope().active()).to.not.be.null
              next()
            })

            app.get('/user', (request, reply) => reply.send())

            app.listen({ host, port: 0 }, () => {
              const port = app.server.address().port

              axios.get(`http://localhost:${port}/user`)
                .then(() => done())
                .catch(done)
            })
          })

          it('should run POST handlers in the request scope', done => {
            app.post('/user', (request, reply) => {
              expect(tracer.scope().active()).to.not.be.null
              reply.send()
            })

            app.listen({ host, port: 0 }, () => {
              const port = app.server.address().port

              axios.post(`http://localhost:${port}/user`, { foo: 'bar' })
                .then(() => done())
                .catch(done)
            })
          })

          it('should run routes in the request scope', done => {
            app.use((req, res, next) => {
              expect(tracer.scope().active()).to.not.be.null
              next()
            })

            app.route({
              method: 'POST',
              url: '/user',
              handler: (request, reply) => {
                expect(tracer.scope().active()).to.not.be.null
                reply.send()
              }
            })

            app.listen({ host, port: 0 }, () => {
              const port = app.server.address().port

              axios.post(`http://localhost:${port}/user`, { foo: 'bar' })
                .then(() => done())
                .catch(done)
            })
          })

          it('should run hooks in the request scope', done => {
            app.addHook('onRequest', (request, reply, next) => {
              expect(tracer.scope().active()).to.not.be.null
              next()
            })

            app.addHook('preHandler', (request, reply, next) => {
              expect(tracer.scope().active()).to.not.be.null
              next ? next() : reply()
            })

            app.addHook('onResponse', (request, reply, next) => {
              expect(tracer.scope().active()).to.not.be.null
              next ? next() : reply()
            })

            app.use((req, res, next) => {
              next()
            })

            app.route({
              method: 'POST',
              url: '/user',
              handler: (request, reply) => {
                reply.send()
              }
            })

            app.listen({ host, port: 0 }, () => {
              const port = app.server.address().port

              axios.post(`http://localhost:${port}/user`, { foo: 'bar' })
                .then(() => done())
                .catch(done)
            })
          })

          it('should handle reply errors', done => {
            let error

            app.get('/user', (request, reply) => {
              reply.send(error = new Error('boom'))
            })

            app.listen({ host, port: 0 }, () => {
              const port = app.server.address().port

              agent
                .use(traces => {
                  const spans = traces[0]

                  expect(spans[0]).to.have.property('name', 'fastify.request')
                  expect(spans[0]).to.have.property('resource', 'GET /user')
                  expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
                  expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
                  expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
                  expect(spans[0].meta).to.have.property('component', 'fastify')
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/user`)
                .catch(() => {})
            })
          })

          // This is a regression test for https://github.com/DataDog/dd-trace-js/issues/2047
          it('should not time out on async hooks', (done) => {
            app.addHook('onRequest', async (request, reply) => {})

            app.get('/user', (request, reply) => {
              reply.send()
            })

            app.listen({ host, port: 0 }, async () => {
              const port = app.server.address().port

              await axios.get(`http://localhost:${port}/user`)
              done()
            })
          })

          it('should keep user stores untouched', done => {
            const storage = new AsyncLocalStorage()
            const store = {}

            global.getStore = () => storage.getStore()

            app.addHook('onRequest', (request, reply, next) => {
              storage.run(store, () => next())
            })

            app.get('/user', (request, reply) => {
              try {
                expect(storage.getStore()).to.equal(store)
                done()
              } catch (e) {
                done(e)
              }

              reply.send()
            })

            app.listen({ host, port: 0 }, () => {
              const port = app.server.address().port

              axios.get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })

          it('should handle hook errors', done => {
            let error

            app.addHook('onRequest', (request, reply, next) => {
              next(error = new Error('boom'))
            })

            app.get('/user', (request, reply) => {
              reply.send()
            })

            app.listen({ host, port: 0 }, () => {
              const port = app.server.address().port

              agent
                .use(traces => {
                  const spans = traces[0]

                  expect(spans[0]).to.have.property('name', 'fastify.request')
                  expect(spans[0]).to.have.property('resource', 'GET /user')
                  expect(spans[0]).to.have.property('error', 1)
                  expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
                  expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
                  expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
                  expect(spans[0].meta).to.have.property('component', 'fastify')
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/user`)
                .catch(() => {})
            })
          })

          // fastify doesn't have all application hooks in older versions
          if (semver.intersects(version, '>=2.15')) {
            it('should support hooks with a single parameter', done => {
              app.addHook('onReady', done => done())

              app.get('/user', (request, reply) => {
                reply.send()
              })

              app.listen({ host, port: 0 }, () => {
                const port = app.server.address().port

                agent
                  .use(traces => {
                    const spans = traces[0]

                    expect(spans[0]).to.have.property('name', 'fastify.request')
                    expect(spans[0]).to.have.property('resource', 'GET /user')
                    expect(spans[0]).to.have.property('error', 0)
                    expect(spans[0].meta).to.have.property('component', 'fastify')
                  })
                  .then(done)
                  .catch(done)

                axios
                  .get(`http://localhost:${port}/user`)
                  .catch(() => {})
              })
            })
          }

          // fastify crashes the process on reply exceptions in older versions
          if (semver.intersects(version, '>=3')) {
            it('should handle reply rejections', done => {
              let error

              app.get('/user', (request, reply) => {
                return Promise.reject(error = new Error('boom'))
              })

              app.listen({ host, port: 0 }, () => {
                const port = app.server.address().port

                agent
                  .use(traces => {
                    const spans = traces[0]

                    expect(spans[0]).to.have.property('name', 'fastify.request')
                    expect(spans[0]).to.have.property('resource', 'GET /user')
                    expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
                    expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
                    expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
                    expect(spans[0].meta).to.have.property('component', 'fastify')
                  })
                  .then(done)
                  .catch(done)

                axios
                  .get(`http://localhost:${port}/user`)
                  .catch(() => {})
              })
            })

            it('should handle reply exceptions', done => {
              let error

              // eslint-disable-next-line n/handle-callback-err
              app.setErrorHandler((error, request, reply) => {
                reply.statusCode = 500
                reply.send()
              })
              app.get('/user', (request, reply) => {
                throw (error = new Error('boom'))
              })

              app.listen({ host, port: 0 }, () => {
                const port = app.server.address().port

                agent
                  .use(traces => {
                    const spans = traces[0]

                    expect(spans[0]).to.have.property('name', 'fastify.request')
                    expect(spans[0]).to.have.property('resource', 'GET /user')
                    expect(spans[0]).to.have.property('error', 1)
                    expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
                    expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
                    expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
                    expect(spans[0].meta).to.have.property('component', 'fastify')
                  })
                  .then(done)
                  .catch(done)

                axios
                  .get(`http://localhost:${port}/user`)
                  .catch(() => {})
              })
            })

            it('should ignore reply exceptions if the request succeeds', done => {
              // eslint-disable-next-line n/handle-callback-err
              app.setErrorHandler((error, request, reply) => {
                reply.statusCode = 200
                reply.send()
              })
              app.get('/user', (request, reply) => {
                throw new Error('boom')
              })

              app.listen({ host, port: 0 }, () => {
                const port = app.server.address().port

                agent
                  .use(traces => {
                    const spans = traces[0]

                    expect(spans[0]).to.have.property('name', 'fastify.request')
                    expect(spans[0]).to.have.property('resource', 'GET /user')
                    expect(spans[0]).to.have.property('error', 0)
                    expect(spans[0].meta).to.not.have.property(ERROR_TYPE)
                    expect(spans[0].meta).to.not.have.property(ERROR_MESSAGE)
                    expect(spans[0].meta).to.not.have.property(ERROR_STACK)
                    expect(spans[0].meta).to.have.property('component', 'fastify')
                  })
                  .then(done)
                  .catch(done)

                axios
                  .get(`http://localhost:${port}/user`)
                  .catch(() => {})
              })
            })
          }

          // fastify crashes the process on hook exceptions in older versions
          // which was fixed in https://github.com/fastify/fastify/pull/2695
          if (semver.intersects(version, '>=3.9.2')) {
            it('should handle hook exceptions', done => {
              let error

              app.addHook('onRequest', (request, reply, next) => {
                throw (error = new Error('boom'))
              })

              app.get('/user', (request, reply) => {
                reply.send()
              })

              app.listen({ host, port: 0 }, () => {
                const port = app.server.address().port

                agent
                  .use(traces => {
                    const spans = traces[0]

                    expect(spans[0]).to.have.property('name', 'fastify.request')
                    expect(spans[0]).to.have.property('resource', 'GET /user')
                    expect(spans[0]).to.have.property('error', 1)
                    expect(spans[0].meta).to.have.property(ERROR_TYPE, error.name)
                    expect(spans[0].meta).to.have.property(ERROR_MESSAGE, error.message)
                    expect(spans[0].meta).to.have.property(ERROR_STACK, error.stack)
                    expect(spans[0].meta).to.have.property('component', 'fastify')
                  })
                  .then(done)
                  .catch(done)

                axios
                  .get(`http://localhost:${port}/user`)
                  .catch(() => {})
              })
            })
          }
        })

        describe('with tracer config codeOriginForSpansEnabled', () => {
          if (semver.satisfies(specificVersion, '<4')) return // TODO: Why doesn't it work on older versions?

          before(() => {
            return agent.load(
              ['fastify', 'find-my-way', 'http'],
              [{}, {}, { client: false }],
              { codeOriginForSpansEnabled: true }
            )
          })

          after(() => {
            return agent.close({ ritmReset: false, wipe: true })
          })

          beforeEach(() => {
            fastify = getExport()
            app = fastify()

            if (semver.intersects(version, '>=3')) {
              return app.register(require('../../../versions/middie').get())
            }
          })

          it('should add code_origin tag on entry spans when feature is enabled', done => {
            let routeRegisterLine

            // Wrap in a named function to have at least one frame with a function name
            function wrapperFunction () {
              routeRegisterLine = getNextLineNumber()
              app.get('/user', function userHandler (request, reply) {
                reply.send()
              })
            }

            const callWrapperLine = getNextLineNumber()
            wrapperFunction()

            app.listen(() => {
              const port = app.server.address().port

              agent
                .use(traces => {
                  const spans = traces[0]
                  const tags = spans[0].meta

                  expect(tags).to.have.property('_dd.code_origin.type', 'entry')

                  expect(tags).to.have.property('_dd.code_origin.frames.0.file', __filename)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.line', routeRegisterLine)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.column').to.match(/^\d+$/)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.method', 'wrapperFunction')
                  expect(tags).to.not.have.property('_dd.code_origin.frames.0.type')

                  expect(tags).to.have.property('_dd.code_origin.frames.1.file', __filename)
                  expect(tags).to.have.property('_dd.code_origin.frames.1.line', callWrapperLine)
                  expect(tags).to.have.property('_dd.code_origin.frames.1.column').to.match(/^\d+$/)
                  expect(tags).to.not.have.property('_dd.code_origin.frames.1.method')
                  expect(tags).to.have.property('_dd.code_origin.frames.1.type', 'Context')

                  expect(tags).to.not.have.property('_dd.code_origin.frames.2.file')
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })

          it('should point to where actual route handler is configured, not the prefix', done => {
            let routeRegisterLine

            app.register(function v1Handler (app, opts, done) {
              routeRegisterLine = getNextLineNumber()
              app.get('/user', function userHandler (request, reply) {
                reply.send()
              })
              done()
            }, { prefix: '/v1' })

            app.listen(() => {
              const port = app.server.address().port

              agent
                .use(traces => {
                  const spans = traces[0]
                  const tags = spans[0].meta

                  expect(tags).to.have.property('_dd.code_origin.type', 'entry')

                  expect(tags).to.have.property('_dd.code_origin.frames.0.file', __filename)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.line', routeRegisterLine)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.column').to.match(/^\d+$/)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.method', 'v1Handler')
                  expect(tags).to.not.have.property('_dd.code_origin.frames.0.type')

                  expect(tags).to.not.have.property('_dd.code_origin.frames.1.file')
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/v1/user`)
                .catch(done)
            })
          })

          it('should point to route handler even if passed through a middleware', function testCase (done) {
            app.use(function middleware (req, res, next) {
              next()
            })

            const routeRegisterLine = getNextLineNumber()
            app.get('/user', function userHandler (request, reply) {
              reply.send()
            })

            app.listen({ host, port: 0 }, () => {
              const port = app.server.address().port

              agent
                .use(traces => {
                  const spans = traces[0]
                  const tags = spans[0].meta

                  expect(tags).to.have.property('_dd.code_origin.type', 'entry')

                  expect(tags).to.have.property('_dd.code_origin.frames.0.file', __filename)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.line', routeRegisterLine)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.column').to.match(/^\d+$/)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.method', 'testCase')
                  expect(tags).to.have.property('_dd.code_origin.frames.0.type', 'Context')

                  expect(tags).to.not.have.property('_dd.code_origin.frames.1.file')
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })

          // TODO: In Fastify, the route is resolved before the middleware is called, so we actually can get the line
          // number of where the route handler is defined. However, this might not be the right choice and it might be
          // better to point to the middleware.
          it.skip('should point to middleware if middleware responds early', function testCase (done) {
            const middlewareRegisterLine = getNextLineNumber()
            app.use(function middleware (req, res, next) {
              res.end()
            })

            app.get('/user', function userHandler (request, reply) {
              reply.send()
            })

            app.listen({ host, port: 0 }, () => {
              const port = app.server.address().port

              agent
                .use(traces => {
                  const spans = traces[0]
                  const tags = spans[0].meta

                  expect(tags).to.have.property('_dd.code_origin.type', 'entry')

                  expect(tags).to.have.property('_dd.code_origin.frames.0.file', __filename)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.line', middlewareRegisterLine)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.column').to.match(/^\d+$/)
                  expect(tags).to.have.property('_dd.code_origin.frames.0.method', 'testCase')
                  expect(tags).to.have.property('_dd.code_origin.frames.0.type', 'Context')

                  expect(tags).to.not.have.property('_dd.code_origin.frames.1.file')
                })
                .then(done)
                .catch(done)

              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
          })
        })
      })
    })
  })
})

function getNextLineNumber () {
  return String(Number(new Error().stack.split('\n')[2].match(/:(\d+):/)[1]) + 1)
}
