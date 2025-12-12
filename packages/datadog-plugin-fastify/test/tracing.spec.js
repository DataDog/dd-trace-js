'use strict'

const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')

const axios = require('axios')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')

const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withExports, withVersions } = require('../../dd-trace/test/setup/mocha')
const host = 'localhost'

describe('Plugin', () => {
  let tracer
  let fastify
  let app

  describe('fastify', () => {
    withVersions('fastify', 'fastify', (version, _, specificVersion) => {
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
            return agent.close({ ritmReset: false })
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
                .assertSomeTraces(traces => {
                  const spans = traces[0]

                  assert.strictEqual(spans[0].name, 'fastify.request')
                  assert.strictEqual(spans[0].service, 'test')
                  assert.strictEqual(spans[0].type, 'web')
                  assert.strictEqual(spans[0].resource, 'GET /user')
                  assert.strictEqual(spans[0].meta['span.kind'], 'server')
                  assert.strictEqual(spans[0].meta['http.url'], `http://localhost:${port}/user`)
                  assert.strictEqual(spans[0].meta['http.method'], 'GET')
                  assert.strictEqual(spans[0].meta['http.status_code'], '200')
                  assert.strictEqual(spans[0].meta.component, 'fastify')
                  assert.strictEqual(spans[0].meta['_dd.integration'], 'fastify')
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
                .assertSomeTraces(traces => {
                  const spans = traces[0]

                  assert.strictEqual(spans[0].name, 'fastify.request')
                  assert.strictEqual(spans[0].service, 'test')
                  assert.strictEqual(spans[0].type, 'web')
                  assert.strictEqual(spans[0].resource, 'GET /user/:id')
                  assert.strictEqual(spans[0].meta['span.kind'], 'server')
                  assert.strictEqual(spans[0].meta['http.url'], `http://localhost:${port}/user/123`)
                  assert.strictEqual(spans[0].meta['http.method'], 'GET')
                  assert.strictEqual(spans[0].meta['http.status_code'], '200')
                  assert.strictEqual(spans[0].meta.component, 'fastify')
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
                  .assertSomeTraces(traces => {
                    const spans = traces[0]

                    assert.strictEqual(spans[0].name, 'fastify.request')
                    assert.strictEqual(spans[0].service, 'test')
                    assert.strictEqual(spans[0].type, 'web')
                    assert.strictEqual(spans[0].resource, 'GET /user/:id')
                    assert.strictEqual(spans[0].meta['span.kind'], 'server')
                    assert.strictEqual(spans[0].meta['http.url'], `http://localhost:${port}/user/123`)
                    assert.strictEqual(spans[0].meta['http.method'], 'GET')
                    assert.strictEqual(spans[0].meta['http.status_code'], '200')
                    assert.strictEqual(spans[0].meta.component, 'fastify')
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
              assert.notStrictEqual(tracer.scope().active(), null)
              next()
            })

            app.get('/user', (request, reply) => {
              assert.notStrictEqual(tracer.scope().active(), null)
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
              assert.notStrictEqual(tracer.scope().active(), null)
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
              assert.notStrictEqual(tracer.scope().active(), null)
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
              assert.notStrictEqual(tracer.scope().active(), null)
              next()
            })

            app.route({
              method: 'POST',
              url: '/user',
              handler: (request, reply) => {
                assert.notStrictEqual(tracer.scope().active(), null)
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
              assert.notStrictEqual(tracer.scope().active(), null)
              next()
            })

            app.addHook('preHandler', (request, reply, next) => {
              assert.notStrictEqual(tracer.scope().active(), null)
              next ? next() : reply()
            })

            app.addHook('onResponse', (request, reply, next) => {
              assert.notStrictEqual(tracer.scope().active(), null)
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
                .assertSomeTraces(traces => {
                  const spans = traces[0]

                  assert.strictEqual(spans[0].name, 'fastify.request')
                  assert.strictEqual(spans[0].resource, 'GET /user')
                  assert.strictEqual(spans[0].meta[ERROR_TYPE], error.name)
                  assert.strictEqual(spans[0].meta[ERROR_MESSAGE], error.message)
                  assert.strictEqual(spans[0].meta[ERROR_STACK], error.stack)
                  assert.strictEqual(spans[0].meta.component, 'fastify')
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

            global.getStore = () => storage('legacy').getStore()

            app.addHook('onRequest', (request, reply, next) => {
              storage.run(store, () => next())
            })

            app.get('/user', (request, reply) => {
              try {
                assert.strictEqual(storage.getStore(), store)
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
                .assertSomeTraces(traces => {
                  const spans = traces[0]

                  assert.strictEqual(spans[0].name, 'fastify.request')
                  assert.strictEqual(spans[0].resource, 'GET /user')
                  assert.strictEqual(spans[0].error, 1)
                  assert.strictEqual(spans[0].meta[ERROR_TYPE], error.name)
                  assert.strictEqual(spans[0].meta[ERROR_MESSAGE], error.message)
                  assert.strictEqual(spans[0].meta[ERROR_STACK], error.stack)
                  assert.strictEqual(spans[0].meta.component, 'fastify')
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
                  .assertSomeTraces(traces => {
                    const spans = traces[0]

                    assert.strictEqual(spans[0].name, 'fastify.request')
                    assert.strictEqual(spans[0].resource, 'GET /user')
                    assert.strictEqual(spans[0].error, 0)
                    assert.strictEqual(spans[0].meta.component, 'fastify')
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
                  .assertSomeTraces(traces => {
                    const spans = traces[0]

                    assert.strictEqual(spans[0].name, 'fastify.request')
                    assert.strictEqual(spans[0].resource, 'GET /user')
                    assert.strictEqual(spans[0].meta[ERROR_TYPE], error.name)
                    assert.strictEqual(spans[0].meta[ERROR_MESSAGE], error.message)
                    assert.strictEqual(spans[0].meta[ERROR_STACK], error.stack)
                    assert.strictEqual(spans[0].meta.component, 'fastify')
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
                  .assertSomeTraces(traces => {
                    const spans = traces[0]

                    assert.strictEqual(spans[0].name, 'fastify.request')
                    assert.strictEqual(spans[0].resource, 'GET /user')
                    assert.strictEqual(spans[0].error, 1)
                    assert.strictEqual(spans[0].meta[ERROR_TYPE], error.name)
                    assert.strictEqual(spans[0].meta[ERROR_MESSAGE], error.message)
                    assert.strictEqual(spans[0].meta[ERROR_STACK], error.stack)
                    assert.strictEqual(spans[0].meta.component, 'fastify')
                  })
                  .then(done)
                  .catch(done)

                axios
                  .get(`http://localhost:${port}/user`)
                  .catch(() => {})
              })
            })

            it('should ignore reply exceptions if the request succeeds', done => {
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
                  .assertSomeTraces(traces => {
                    const spans = traces[0]

                    assert.strictEqual(spans[0].name, 'fastify.request')
                    assert.strictEqual(spans[0].resource, 'GET /user')
                    assert.strictEqual(spans[0].error, 0)
                    assert.ok(!(ERROR_TYPE in spans[0].meta))
                    assert.ok(!(ERROR_MESSAGE in spans[0].meta))
                    assert.ok(!(ERROR_STACK in spans[0].meta))
                    assert.strictEqual(spans[0].meta.component, 'fastify')
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
                  .assertSomeTraces(traces => {
                    const spans = traces[0]

                    assert.strictEqual(spans[0].name, 'fastify.request')
                    assert.strictEqual(spans[0].resource, 'GET /user')
                    assert.strictEqual(spans[0].error, 1)
                    assert.strictEqual(spans[0].meta[ERROR_TYPE], error.name)
                    assert.strictEqual(spans[0].meta[ERROR_MESSAGE], error.message)
                    assert.strictEqual(spans[0].meta[ERROR_STACK], error.stack)
                    assert.strictEqual(spans[0].meta.component, 'fastify')
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
      })
    })
  })
})
