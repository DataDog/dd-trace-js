'use strict'

const axios = require('axios')
const getPort = require('get-port')
const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')

describe('Plugin', () => {
  let tracer
  let Hapi
  let server
  let port
  let handler
  let reply

  describe('hapi', () => {
    withVersions('hapi', ['hapi', '@hapi/hapi'], (version, module) => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
        handler = (request, h, body) => h.response ? h.response(body) : h(body)
        reply = (request, h) => {
          if (h.continue) {
            return typeof h.continue === 'function'
              ? h.continue()
              : h.continue
          } else {
            return h()
          }
        }
      })

      after(() => {
        return agent.close({ ritmReset: false })
      })

      before(() => {
        return agent.load(['hapi', 'http'], [{}, { client: false }])
          .then(() => {
            Hapi = require(`../../../versions/${module}@${version}`).get()
          })
      })

      if (semver.intersects(version, '>=17 <=20')) {
        beforeEach(() => {
          return getPort()
            .then(_port => {
              port = _port
              server = Hapi.server({
                address: '127.0.0.1',
                port
              })
              return server.start()
            })
        })

        afterEach(() => {
          return server.stop()
        })
      } else {
        beforeEach(done => {
          getPort()
            .then(_port => {
              port = _port

              if (Hapi.Server.prototype.connection) {
                server = new Hapi.Server()
                server.connection({ address: '127.0.0.1', port })
              } else {
                server = new Hapi.Server('127.0.0.1', port)
              }

              server.start(done)
            })
        })

        afterEach(done => {
          try {
            server.stop()
          } finally {
            done()
          }
        })
      }

      it('should do automatic instrumentation on routes', done => {
        server.route({
          method: 'GET',
          path: '/user/{id}',
          handler
        })

        agent
          .use(traces => {
            expect(traces[0][0]).to.have.property('name', 'hapi.request')
            expect(traces[0][0]).to.have.property('service', 'test')
            expect(traces[0][0]).to.have.property('type', 'web')
            expect(traces[0][0]).to.have.property('resource', 'GET /user/{id}')
            expect(traces[0][0].meta).to.have.property('span.kind', 'server')
            expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user/123`)
            expect(traces[0][0].meta).to.have.property('http.method', 'GET')
            expect(traces[0][0].meta).to.have.property('http.status_code')
            expect(Number(traces[0][0].meta['http.status_code'])).to.be.within(200, 299)
          })
          .then(done)
          .catch(done)

        axios
          .get(`http://localhost:${port}/user/123`)
          .catch(done)
      })

      it('should run the request handler in the request scope', done => {
        server.route({
          method: 'GET',
          path: '/user/{id}',
          handler: (request, h) => {
            expect(tracer.scope().active()).to.not.be.null
            done()
            return handler(request, h)
          }
        })

        axios
          .get(`http://localhost:${port}/user/123`)
          .catch(done)
      })

      it('should run the request handler in the request scope with a payload', done => {
        server.route({
          method: 'POST',
          path: '/user/{id}',
          handler: (request, h) => {
            try {
              expect(tracer.scope().active()).to.not.be.null
              done()
            } catch (e) {
              done(e)
            }

            return handler(request, h)
          }
        })

        axios
          .post(`http://localhost:${port}/user/123`, {})
          .catch(done)
      })

      it('should run pre-handlers in the request scope', done => {
        server.route({
          method: 'GET',
          path: '/user/{id}',
          config: {
            pre: [
              (request, h) => {
                expect(tracer.scope().active()).to.not.be.null
                done()
                return handler(request, h)
              }
            ],
            handler
          }
        })

        axios
          .get(`http://localhost:${port}/user/123`)
          .catch(done)
      })

      it('should run extension methods in the request scope', done => {
        server.route({
          method: 'POST',
          path: '/user/{id}',
          config: {
            handler
          }
        })

        server.ext('onPostAuth', (request, h) => {
          return tracer.scope().activate(null, reply(request, h))
        })

        server.ext('onPreHandler', (request, h) => {
          expect(tracer.scope().active()).to.not.be.null
          done()

          return reply(request, h)
        })

        axios
          .post(`http://localhost:${port}/user/123`, {})
          .catch(done)
      })

      if (semver.intersects(version, '>=11 <=20')) {
        it('should run extension events in the request scope', done => {
          server.route({
            method: 'POST',
            path: '/user/{id}',
            config: {
              handler
            }
          })

          server.ext({
            type: 'onPostAuth',
            method: (request, h) => {
              return tracer.scope().activate(null, reply(request, h))
            }
          })

          server.ext({
            type: 'onPreHandler',
            method: (request, h) => {
              expect(tracer.scope().active()).to.not.be.null
              done()

              return reply(request, h)
            }
          })

          axios
            .post(`http://localhost:${port}/user/123`, {})
            .catch(done)
        })
      }

      it('should run request extensions in the request scope', done => {
        server.route({
          method: 'GET',
          path: '/user/{id}',
          handler
        })

        server.ext('onRequest', (request, h) => {
          expect(tracer.scope().active()).to.not.be.null
          done()

          return reply(request, h)
        })

        axios
          .get(`http://localhost:${port}/user/123`)
          .catch(done)
      })

      it('should extract its parent span from the headers', done => {
        server.route({
          method: 'GET',
          path: '/user/{id}',
          handler
        })

        agent
          .use(traces => {
            expect(traces[0][0].trace_id.toString()).to.equal('1234')
            expect(traces[0][0].parent_id.toString()).to.equal('5678')
          })
          .then(done)
          .catch(done)

        axios
          .get(`http://localhost:${port}/user/123`, {
            headers: {
              'x-datadog-trace-id': '1234',
              'x-datadog-parent-id': '5678',
              'ot-baggage-foo': 'bar'
            }
          })
          .catch(done)
      })

      it('should instrument the default route handler', done => {
        agent
          .use(traces => {
            expect(traces[0][0]).to.have.property('name', 'hapi.request')
          })
          .then(done)
          .catch(done)

        axios
          .get(`http://localhost:${port}/user/123`)
          .catch(() => {})
      })

      it('should handle errors', done => {
        const error = new Error()

        server.route({
          method: 'GET',
          path: '/user/{id}',
          handler: (request, h) => {
            if (typeof h === 'function') {
              h(error)
            } else {
              throw error
            }
          }
        })

        agent
          .use(traces => {
            expect(traces[0][0]).to.have.property('error', 1)
            expect(traces[0][0].meta).to.have.property('error.type', error.name)
            expect(traces[0][0].meta).to.have.property('error.msg', error.message)
            expect(traces[0][0].meta).to.have.property('error.stack', error.stack)
          })
          .then(done)
          .catch(done)

        axios
          .get(`http://localhost:${port}/user/123`)
          .catch(() => {})
      })
    })
  })
})
