'use strict'

const axios = require('axios')
const getPort = require('get-port')
const agent = require('../../dd-trace/test/plugins/agent')
const plugin = require('../src')

wrapIt()

const sort = spans => spans.sort((a, b) => a.start.toString() >= b.start.toString() ? 1 : -1)

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
          return agent.load(plugin, 'fastify')
        })

        after(() => {
          return agent.close()
        })

        beforeEach(() => {
          fastify = require(`../../../versions/fastify@${version}`).get()
        })

        it('should do automatic instrumentation on the app routes', done => {
          app = fastify()

          app.get('/user', (request, reply) => {
            reply.send()
          })

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

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
          app = fastify()

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
                const spans = sort(traces[0])

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

        it('should run handlers in the request scope', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

          const app = fastify()

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

          const app = fastify()

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

        it('should run hooks in the request scope', done => {
          if (process.env.DD_CONTEXT_PROPAGATION === 'false') return done()

          const app = fastify()

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

          app = fastify()

          app.get('/user', (request, reply) => {
            reply.send(error = new Error('boom'))
          })

          getPort().then(port => {
            agent
              .use(traces => {
                const spans = sort(traces[0])

                expect(spans[0]).to.have.property('name', 'fastify.request')
                expect(spans[0]).to.have.property('resource', 'GET /user')
                expect(spans[0].meta).to.have.property('error.type', error.name)
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
      })
    })
  })
})
