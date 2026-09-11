'use strict'

const { afterEach, beforeEach, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')

describe('Plugin', function () {
  this.timeout(0)

  let fetch
  let appListener

  describe('fetch', () => {
    describe('resource name quantization', () => {
      function server (listener) {
        const server = require('http').createServer((req, res) => {
          res.writeHead(200)
          res.end()
        })
        server.listen(0, 'localhost', () => {
          listener((/** @type {import('net').AddressInfo} */ (server.address())).port)
        })
        return server
      }

      beforeEach(() => {
        appListener = null
      })

      afterEach(() => {
        if (appListener) {
          appListener.close()
        }
        return agent.close()
      })

      describe('when disabled', () => {
        beforeEach(() => {
          return agent.load('fetch').then(() => {
            fetch = globalThis.fetch
          })
        })

        it('uses the bare method as the resource name', done => {
          appListener = server(port => {
            agent.assertFirstTraceSpan({ resource: 'GET' }).then(done).catch(done)

            fetch(`http://localhost:${port}/users/123`).catch(done)
          })
        })
      })

      // fetch reuses the http client plugin's bindStart, so it inherits
      // quantization rather than wiring it separately.
      describe('when enabled', () => {
        beforeEach(() => {
          process.env.DD_TRACE_HTTP_CLIENT_RESOURCE_NAME_QUANTIZE = 'true'
          return agent.load('fetch').then(() => {
            fetch = globalThis.fetch
          })
        })

        afterEach(() => {
          delete process.env.DD_TRACE_HTTP_CLIENT_RESOURCE_NAME_QUANTIZE
        })

        it('appends the quantized path to the method', done => {
          appListener = server(port => {
            agent.assertFirstTraceSpan({ resource: 'GET /users/?' }).then(done).catch(done)

            fetch(`http://localhost:${port}/users/123`).catch(done)
          })
        })

        // fetch carries the query in `search` rather than `path`, so this guards
        // the path extraction that feeds the quantizer.
        it('keeps the query string out of the resource name', done => {
          appListener = server(port => {
            agent.assertFirstTraceSpan({ resource: 'GET /users/?' }).then(done).catch(done)

            fetch(`http://localhost:${port}/users/123?token=secret`).catch(done)
          })
        })
      })
    })
  })
})
