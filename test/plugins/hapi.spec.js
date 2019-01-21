'use strict'

const axios = require('axios')
const getPort = require('get-port')
const semver = require('semver')
const agent = require('./agent')
const plugin = require('../../src/plugins/hapi')

wrapIt()

describe('Plugin', () => {
  let tracer
  let Hapi
  let server
  let port
  let handler

  describe('hapi', () => {
    withVersions(plugin, 'hapi', version => {
      beforeEach(() => {
        tracer = require('../..')
        handler = (request, h, body) => h.response ? h.response(body) : h(body)
      })

      after(() => {
        return agent.close()
      })

      before(() => {
        return agent.load(plugin, 'hapi')
          .then(() => {
            Hapi = require(`../../versions/hapi@${version}`).get()
          })
      })

      if (semver.intersects(version, '>=17')) {
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
            expect(traces[0][0]).to.have.property('type', 'http')
            expect(traces[0][0]).to.have.property('resource', 'GET /user/{id}')
            expect(traces[0][0].meta).to.have.property('span.kind', 'server')
            expect(traces[0][0].meta).to.have.property('http.url', `http://localhost:${port}/user/123`)
            expect(traces[0][0].meta).to.have.property('http.method', 'GET')
            expect(traces[0][0].meta).to.have.property('http.status_code', '200')
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

      it('should run request extensions in the request scope', done => {
        server.route({
          method: 'GET',
          path: '/user/{id}',
          handler
        })

        server.ext('onRequest', (request, h) => {
          expect(tracer.scope().active()).to.not.be.null
          done()

          if (typeof h === 'function') {
            return h()
          } else if (typeof h.continue === 'function') {
            return h.continue()
          } else {
            return h.continue
          }
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
        server.route({
          method: 'GET',
          path: '/user/{id}',
          handler: (request, h) => {
            const error = new Error()

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
