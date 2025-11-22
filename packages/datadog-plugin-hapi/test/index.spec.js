'use strict'

const assert = require('node:assert/strict')
const { AsyncLocalStorage } = require('node:async_hooks')

const axios = require('axios')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')

const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
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
          server = Hapi.server({
            address: 'localhost',
            port: 0
          })
          return server.start().then(() => {
            port = server.listener.address().port
          })
        })

        afterEach(() => {
          return server.stop()
        })
      } else {
        beforeEach(done => {
          if (Hapi.Server.prototype.connection) {
            server = new Hapi.Server()
            server.connection({ address: 'localhost', port })
          } else {
            server = new Hapi.Server('localhost', port)
          }

          server.start(err => {
            if (!err) {
              port = server.listener.address().port
            }
            done(err)
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
          .assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, 'hapi.request')
            assert.strictEqual(traces[0][0].service, 'test')
            assert.strictEqual(traces[0][0].type, 'web')
            assert.strictEqual(traces[0][0].resource, 'GET /user/{id}')
            assert.strictEqual(traces[0][0].meta['span.kind'], 'server')
            assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/user/123`)
            assert.strictEqual(traces[0][0].meta['http.method'], 'GET')
            assert.ok(Object.hasOwn(traces[0][0].meta, 'http.status_code'))
            assert.strictEqual(traces[0][0].meta.component, 'hapi')
            assert.strictEqual(traces[0][0].meta['_dd.integration'], 'hapi')
            assert.ok(((Number(traces[0][0].meta['http.status_code'])) >= (200) && (Number(traces[0][0].meta['http.status_code'])) <= (299)))
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
            assert.notStrictEqual(tracer.scope().active(), null)
            done()
            return handler(request, h)
          }
        })

        axios
          .get(`http://localhost:${port}/user/123`)
          .catch(done)
      })

      // Hapi does not reply to POST requests on Node <=16
      if (semver.intersects(version, '>=17')) {
        it('should run the request handler in the request scope with a payload', done => {
          server.route({
            method: 'POST',
            path: '/user/{id}',
            handler: (request, h) => {
              try {
                assert.notStrictEqual(tracer.scope().active(), null)
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
      }

      it('should run pre-handlers in the request scope', done => {
        server.route({
          method: 'GET',
          path: '/user/{id}',
          config: {
            pre: [
              (request, h) => {
                assert.notStrictEqual(tracer.scope().active(), null)
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
          method: 'GET',
          path: '/user/{id}',
          config: {
            handler
          }
        })

        server.ext('onPostAuth', (request, h) => {
          return tracer.scope().activate(null, reply(request, h))
        })

        server.ext('onPreHandler', (request, h) => {
          assert.notStrictEqual(tracer.scope().active(), null)
          done()

          return reply(request, h)
        })

        axios
          .get(`http://localhost:${port}/user/123`)
          .catch(done)
      })

      if (semver.intersects(version, '>=11')) {
        it('should run extension events in the request scope', done => {
          server.route({
            method: 'GET',
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
              assert.notStrictEqual(tracer.scope().active(), null)
              done()

              return reply(request, h)
            }
          })

          axios
            .get(`http://localhost:${port}/user/123`)
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
          assert.notStrictEqual(tracer.scope().active(), null)
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
          .assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].trace_id.toString(), '1234')
            assert.strictEqual(traces[0][0].parent_id.toString(), '5678')
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
          .assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].name, 'hapi.request')
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
          .assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].error, 1)
            assert.strictEqual(traces[0][0].meta[ERROR_TYPE], error.name)
            assert.strictEqual(traces[0][0].meta[ERROR_MESSAGE], error.message)
            assert.strictEqual(traces[0][0].meta[ERROR_STACK], error.stack)
            assert.strictEqual(traces[0][0].meta.component, 'hapi')
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
          .assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].error, 0)
            assert.strictEqual(traces[0][0].meta.component, 'hapi')
          })
          .then(done)
          .catch(done)

        axios
          .get(`http://localhost:${port}/user/123`)
          .catch(() => {})
      })

      it('should persist AsyncLocalStorage context', (done) => {
        const storage = new AsyncLocalStorage()
        const path = '/path'

        server.ext('onRequest', (request, h) => {
          storage.enterWith({ path: request.path })
          return reply(request, h)
        })

        server.route({
          method: 'GET',
          path,
          handler: async (request, h) => {
            assert.deepStrictEqual(storage.getStore(), { path })
            done()
            return h.response ? h.response() : h()
          }
        })

        axios
          .get(`http://localhost:${port}${path}`)
          .catch(() => {})
      })
    })
  })
})
