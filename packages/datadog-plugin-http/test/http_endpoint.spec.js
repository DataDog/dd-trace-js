'use strict'

const assert = require('node:assert/strict')
const axios = require('axios')

const { describe, it, beforeEach, afterEach, before } = require('mocha')

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
        before(() => {
          // Needed when this spec file run together with other spec files, in which case the agent config is not
          // re-loaded unless the existing agent is wiped first.
          // And we need the agent config to be re-loaded in order to enable appsec.
          agent.wipe()
        })

        beforeEach(async () => {
          return agent.load('http', {}, { appsec: { enabled: true } })
            .then(() => {
              http = require(pluginToBeLoaded)
            })
        })

        afterEach(() => {
          appListener && appListener.close()
          return agent.close({ ritmReset: false })
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
  })
})
