'use strict'

const axios = require('axios')
const getPort = require('get-port')
const agent = require('./agent')
const plugin = require('../../src/plugins/hapi')

wrapIt()

describe('Plugin', () => {
  let tracer
  let Hapi
  let server
  let port

  describe('hapi', () => {
    withVersions(plugin, 'hapi', version => {
      beforeEach(() => {
        tracer = require('../..')
      })

      afterEach(() => {
        return Promise.all([
          agent.close(),
          server.stop()
        ])
      })

      beforeEach(() => {
        return agent.load(plugin, 'hapi')
          .then(() => {
            Hapi = require(`./versions/hapi@${version}`).get()
          })
      })

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

      it('should do automatic instrumentation on routes', done => {
        server.route({
          method: 'GET',
          path: '/user/{id}',
          handler: () => ''
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
          handler: () => {
            expect(tracer.scopeManager().active()).to.not.be.null
            done()
            return ''
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
                expect(tracer.scopeManager().active()).to.not.be.null
                done()
                return ''
              }
            ],
            handler: () => ''
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
          handler: () => ''
        })

        server.ext('onRequest', (request, h) => {
          expect(tracer.scopeManager().active()).to.not.be.null
          done()
          return h.continue
        })

        axios
          .get(`http://localhost:${port}/user/123`)
          .catch(done)
      })

      it('should extract its parent span from the headers', done => {
        server.route({
          method: 'GET',
          path: '/user/{id}',
          handler: () => ''
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
          handler: () => {
            throw new Error()
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
