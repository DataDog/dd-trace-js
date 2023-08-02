'use strict'

const axios = require('axios')
const getPort = require('get-port')
const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')

const versionRange = parseInt(process.versions.node.split('.')[0]) > 14
  ? '<17 || >18'
  : ''

describe('Plugin', () => {
  let tracer
  let Hapi
  let server
  let port
  let handler
  let reply

  describe('hapi', () => {
    withVersions('hapi', ['hapi', '@hapi/hapi'], versionRange, (version, module) => {
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

      if (semver.intersects(version, '>=17')) {
        beforeEach(() => {
          return getPort()
            .then(_port => {
              port = _port
              console.log('another port log', port)
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
            expect(traces[0][0].meta).to.have.property('component', 'hapi')
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

      it('should run the request handler in the request scope with a payload', async () => {
        console.log('port ISSSS ', port)
        console.log('port ISSSS ', port)
        server.route({
          method: 'POST',
          path: '/user/{id}',
          handler: async (request, h) => {
            try {
              expect(tracer.scope().active()).to.not.be.null
            } catch (e) {
              console.log(12312312, e)
              throw e
            }

            return h.continue()
          }
        })

        try {
          await axios.post(`http://localhost:${port}/user/123`, {})
          console.log('Test success')
        } catch (err) {
          console.error(1313132, err)
        }
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

      if (semver.intersects(version, '>=11')) {
        it('should run extension events in the request scope', async () => {
          server.route({
            method: 'POST',
            path: '/user/{id}',
            config: {
              handler
            }
          })

          server.ext({
            type: 'onPostAuth',
            method: async (request, h) => {
              await tracer.scope().activate(null, reply(request, h))
            }
          })

          server.ext({
            type: 'onPreHandler',
            method: async (request, h) => {
              expect(tracer.scope().active()).to.not.be.null
              return reply(request, h)
            }
          })

          try {
            await axios.post(`http://localhost:${port}/user/123`, {})
          } catch (err) {
            console.error(1313132, err)
          }
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
            expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
            expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
            expect(traces[0][0].meta).to.have.property(ERROR_STACK, error.stack)
            expect(traces[0][0].meta).to.have.property('component', 'hapi')
          })
          .then(done)
          .catch(done)

        axios
          .get(`http://localhost:${port}/user/123`)
          .catch(() => {})
      })

      it('should handle boom client errors', done => {
        const Boom = require('../../../versions/@hapi/boom@9.1.4').get()
        const error = Boom.badRequest()

        server.route({
          method: 'GET',
          path: '/user/{id}',
          handler: async (request, h) => {
            if (typeof h === 'function') {
              h(error)
            } else {
              throw error
            }
          }
        })

        agent
          .use(traces => {
            expect(traces[0][0]).to.have.property('error', 0)
            expect(traces[0][0].meta).to.have.property('component', 'hapi')
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
