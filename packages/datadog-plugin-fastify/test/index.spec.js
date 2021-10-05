'use strict'

const axios = require('axios')
const getPort = require('get-port')
const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

describe('Plugin', () => {
  let tracer
  let fastify
  let app

  describe('fastify', () => {
    withVersions(plugin, 'fastify', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
      })

      afterEach(() => {
        app.close()
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load('fastify')
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          fastify = require(`../../../versions/fastify@${version}`).get()
          app = fastify()

          if (semver.intersects(version, '>=3')) {
            return app.register(require('../../../versions/middie').get())
          }
        })

        it('should do automatic instrumentation on the app routes', done => {
          app.get('/user', (request, reply) => {
            reply.send()
          })

          getPort().then(port => {
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
              })
              .then(done)
              .catch(done)

            app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`)
                .catch(done)
            })
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

          getPort().then(port => {
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
              })
              .then(done)
              .catch(done)

            app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user/123`)
                .catch(done)
            })
          })
        })

        if (semver.intersects(version, '>=1.2')) {
          it('should do automatic instrumentation on route with handler in options', done => {
            app.get('/user/:id', {
              handler: (request, reply) => {
                reply.send()
              }
            })

            getPort().then(port => {
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
                })
                .then(done)
                .catch(done)

              app.listen(port, 'localhost', () => {
                axios
                  .get(`http://localhost:${port}/user/123`)
                  .catch(done)
              })
            })
          })
        }

        it('should run handlers in the request scope', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

          app.use((req, res, next) => {
            expect(tracer.scope().active()).to.not.be.null
            next()
          })

          app.get('/user', (request, reply) => {
            expect(tracer.scope().active()).to.not.be.null
            reply.send()
          })

          getPort().then(port => {
            app.listen(port, 'localhost', () => {
              axios.get(`http://localhost:${port}/user`)
                .then(() => done())
                .catch(done)
            })
          })
        })

        it('should run middleware in the request scope', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

          app.use((req, res, next) => {
            expect(tracer.scope().active()).to.not.be.null
            next()
          })

          app.get('/user', (request, reply) => reply.send())

          getPort().then(port => {
            app.listen(port, 'localhost', () => {
              axios.get(`http://localhost:${port}/user`)
                .then(() => done())
                .catch(done)
            })
          })
        })

        it('should run POST handlers in the request scope', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

          app.post('/user', (request, reply) => {
            expect(tracer.scope().active()).to.not.be.null
            reply.send()
          })

          getPort().then(port => {
            app.listen(port, 'localhost', () => {
              axios.post(`http://localhost:${port}/user`, { foo: 'bar' })
                .then(() => done())
                .catch(done)
            })
          })
        })

        it('should run routes in the request scope', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

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

          getPort().then(port => {
            app.listen(port, 'localhost', () => {
              axios.post(`http://localhost:${port}/user`, { foo: 'bar' })
                .then(() => done())
                .catch(done)
            })
          })
        })

        it('should run hooks in the request scope', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

          app.addHook('onRequest', (request, reply, next) => {
            expect(tracer.scope().active()).to.not.be.null
            next()
          })

          app.addHook('onResponse', (request, reply, next) => {
            expect(tracer.scope().active()).to.not.be.null
            next ? next() : reply()
          })

          app.get('/user', (request, reply) => reply.send())

          getPort().then(port => {
            app.listen(port, 'localhost', () => {
              axios.get(`http://localhost:${port}/user`)
                .then(() => done())
                .catch(done)
            })
          })
        })

        it('should handle reply errors', done => {
          let error

          app.get('/user', (request, reply) => {
            reply.send(error = new Error('boom'))
          })

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[0]).to.have.property('name', 'fastify.request')
                expect(spans[0]).to.have.property('resource', 'GET /user')
                expect(spans[0].meta).to.have.property('error.type', error.name)
                expect(spans[0].meta).to.have.property('error.msg', error.message)
                expect(spans[0].meta).to.have.property('error.stack', error.stack)
              })
              .then(done)
              .catch(done)

            app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`)
                .catch(() => {})
            })
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

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = traces[0]

                expect(spans[0]).to.have.property('name', 'fastify.request')
                expect(spans[0]).to.have.property('resource', 'GET /user')
                expect(spans[0]).to.have.property('error', 1)
                expect(spans[0].meta).to.have.property('error.type', error.name)
                expect(spans[0].meta).to.have.property('error.msg', error.message)
                expect(spans[0].meta).to.have.property('error.stack', error.stack)
              })
              .then(done)
              .catch(done)

            app.listen(port, 'localhost', () => {
              axios
                .get(`http://localhost:${port}/user`)
                .catch(() => {})
            })
          })
        })

        // fastify doesn't have all application hooks in older versions
        if (semver.intersects(version, '>=2.15')) {
          it('should support hooks with a single parameter', done => {
            app.addHook('onReady', done => done())

            app.get('/user', (request, reply) => {
              reply.send()
            })

            getPort().then(port => {
              agent
                .use(traces => {
                  const spans = traces[0]

                  expect(spans[0]).to.have.property('name', 'fastify.request')
                  expect(spans[0]).to.have.property('resource', 'GET /user')
                  expect(spans[0]).to.have.property('error', 0)
                })
                .then(done)
                .catch(done)

              app.listen(port, 'localhost', () => {
                axios
                  .get(`http://localhost:${port}/user`)
                  .catch(() => {})
              })
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

            getPort().then(port => {
              agent
                .use(traces => {
                  const spans = traces[0]

                  expect(spans[0]).to.have.property('name', 'fastify.request')
                  expect(spans[0]).to.have.property('resource', 'GET /user')
                  expect(spans[0].meta).to.have.property('error.type', error.name)
                  expect(spans[0].meta).to.have.property('error.msg', error.message)
                  expect(spans[0].meta).to.have.property('error.stack', error.stack)
                })
                .then(done)
                .catch(done)

              app.listen(port, 'localhost', () => {
                axios
                  .get(`http://localhost:${port}/user`)
                  .catch(() => {})
              })
            })
          })

          it('should handle reply exceptions', done => {
            let error

            app.setErrorHandler((error, request, reply) => {
              reply.send()
            })
            app.get('/user', (request, reply) => {
              throw (error = new Error('boom'))
            })

            getPort().then(port => {
              agent
                .use(traces => {
                  const spans = traces[0]

                  expect(spans[0]).to.have.property('name', 'fastify.request')
                  expect(spans[0]).to.have.property('resource', 'GET /user')
                  expect(spans[0].meta).to.have.property('error.type', error.name)
                  expect(spans[0].meta).to.have.property('error.msg', error.message)
                  expect(spans[0].meta).to.have.property('error.stack', error.stack)
                })
                .then(done)
                .catch(done)

              app.listen(port, 'localhost', () => {
                axios
                  .get(`http://localhost:${port}/user`)
                  .catch(() => {})
              })
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

            getPort().then(port => {
              agent
                .use(traces => {
                  const spans = traces[0]

                  expect(spans[0]).to.have.property('name', 'fastify.request')
                  expect(spans[0]).to.have.property('resource', 'GET /user')
                  expect(spans[0]).to.have.property('error', 1)
                  expect(spans[0].meta).to.have.property('error.type', error.name)
                  expect(spans[0].meta).to.have.property('error.msg', error.message)
                  expect(spans[0].meta).to.have.property('error.stack', error.stack)
                })
                .then(done)
                .catch(done)

              app.listen(port, 'localhost', () => {
                axios
                  .get(`http://localhost:${port}/user`)
                  .catch(() => {})
              })
            })
          })
        }
      })
    })
  })
})
