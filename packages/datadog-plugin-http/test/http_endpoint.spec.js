'use strict'

const assert = require('node:assert/strict')
const axios = require('axios')

const { describe, it, beforeEach, afterEach } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')

describe('Plugin', () => {
  let http
  let listener
  let appListener
  let port
  let app

  ['http', 'node:http'].forEach(pluginToBeLoaded => {
    describe(`${pluginToBeLoaded}/server`, () => {
      describe('http.endpoint', () => {
        beforeEach(async () => {
          return agent.load('http', {}, { appsec: { enabled: true } })
            .then(() => {
              http = require(pluginToBeLoaded)
            })
        })

        afterEach(() => {
          appListener && appListener.close()
          return agent.close()
        })

        beforeEach(() => {
          app = null
          listener = (req, res) => {
            app && app(req, res)
            res.writeHead(200)
            res.end()
          }
        })

        beforeEach(done => {
          const server = new http.Server(listener)
          appListener = server
            .listen(0, 'localhost', () => {
              port = appListener.address().port
              done()
            })
        })

        it('should set http.endpoint with int when no route is available', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].name, 'web.request')
              assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/users/123`)
              assert.ok(!('http.route' in traces[0][0].meta))
              assert.strictEqual(traces[0][0].meta['http.endpoint'], '/users/{param:int}')
            })
            .then(done)
            .catch(done)

          axios.get(`http://localhost:${port}/users/123`).catch(done)
        })

        it('should set http.endpoint with int_id when no route is available', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].name, 'web.request')
              assert.ok(!('http.route' in traces[0][0].meta))
              assert.strictEqual(traces[0][0].meta['http.endpoint'], '/resources/{param:int_id}')
            })
            .then(done)
            .catch(done)

          axios.get(`http://localhost:${port}/resources/123-456`).catch(done)
        })

        it('should set http.endpoint with hex when no route is available', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].name, 'web.request')
              assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/orders/abc123`)
              assert.ok(!('http.route' in traces[0][0].meta))
              assert.strictEqual(traces[0][0].meta['http.endpoint'], '/orders/{param:hex}')
            })
            .then(done)
            .catch(done)

          axios.get(`http://localhost:${port}/orders/abc123`).catch(done)
        })

        it('should set http.endpoint with hex_id when no route is available', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].name, 'web.request')
              assert.ok(!('http.route' in traces[0][0].meta))
              assert.strictEqual(traces[0][0].meta['http.endpoint'], '/resources/{param:hex_id}')
            })
            .then(done)
            .catch(done)

          axios.get(`http://localhost:${port}/resources/abc-123`).catch(done)
        })
      })
    })

    describe(`${pluginToBeLoaded}/client`, () => {
      describe('http.endpoint', () => {
        beforeEach(async () => {
          return agent.load('http', { server: false }, { appsec: { enabled: true } })
            .then(() => {
              http = require(pluginToBeLoaded)
            })
        })

        afterEach(() => {
          appListener && appListener.close()
          return agent.close()
        })

        beforeEach(done => {
          const server = new http.Server((req, res) => {
            res.writeHead(200)
            res.end()
          })
          appListener = server.listen(0, 'localhost', () => {
            port = appListener.address().port
            done()
          })
        })

        it('should set http.endpoint with int', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
              assert.strictEqual(traces[0][0].meta['http.url'], `http://localhost:${port}/users/123`)
              assert.strictEqual(traces[0][0].meta['http.endpoint'], '/users/{param:int}')
            })
            .then(done)
            .catch(done)

          axios.get(`http://localhost:${port}/users/123`).catch(done)
        })

        it('should normalize a mixed path into multiple param classes', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
              assert.strictEqual(
                traces[0][0].meta['http.endpoint'],
                '/v1/users/{param:int}/sessions/{param:hex}'
              )
            })
            .then(done)
            .catch(done)

          axios.get(`http://localhost:${port}/v1/users/12345/sessions/a1b2c3d4e5f6`).catch(done)
        })

        it('should compute http.endpoint from the path only, ignoring the query string', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
              assert.strictEqual(traces[0][0].meta['http.endpoint'], '/users/{param:int}')
            })
            .then(done)
            .catch(done)

          axios.get(`http://localhost:${port}/users/123?cursor=abc&page=2`).catch(done)
        })
      })

      describe('http.endpoint disabled', () => {
        beforeEach(async () => {
          return agent.load('http', { server: false })
            .then(() => {
              http = require(pluginToBeLoaded)
            })
        })

        afterEach(() => {
          appListener && appListener.close()
          return agent.close()
        })

        beforeEach(done => {
          const server = new http.Server((req, res) => {
            res.writeHead(200)
            res.end()
          })
          appListener = server.listen(0, 'localhost', () => {
            port = appListener.address().port
            done()
          })
        })

        it('should not set http.endpoint when resourceRenamingEnabled is off', done => {
          agent
            .assertSomeTraces(traces => {
              assert.strictEqual(traces[0][0].meta['span.kind'], 'client')
              assert.ok(!('http.endpoint' in traces[0][0].meta))
            })
            .then(done)
            .catch(done)

          axios.get(`http://localhost:${port}/users/123`).catch(done)
        })
      })
    })
  })
})
