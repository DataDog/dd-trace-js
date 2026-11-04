'use strict'

const { describe, it, beforeEach, afterEach } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')

describe('Plugin', () => {
  describe('http/client', () => {
    describe('resource name quantization', () => {
      let http
      let appListener

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

      afterEach(async () => {
        if (appListener) {
          appListener.close()
          appListener = null
        }
        await agent.close()
      })

      describe('when disabled', () => {
        beforeEach(async () => {
          await agent.load('http', { server: false })
          http = require('http')
        })

        it('uses the bare method as the resource name', done => {
          appListener = server(port => {
            agent.assertFirstTraceSpan({ resource: 'GET' }).then(done).catch(done)

            http.get(`http://localhost:${port}/users/123`, res => res.resume())
          })
        })
      })

      describe('when enabled', () => {
        beforeEach(async () => {
          process.env.DD_TRACE_HTTP_CLIENT_RESOURCE_NAME_QUANTIZE = 'true'
          await agent.load('http', { server: false })
          http = require('http')
        })

        afterEach(() => {
          delete process.env.DD_TRACE_HTTP_CLIENT_RESOURCE_NAME_QUANTIZE
        })

        it('appends the quantized path to the method', done => {
          appListener = server(port => {
            agent.assertFirstTraceSpan({ resource: 'GET /users/?' }).then(done).catch(done)

            http.get(`http://localhost:${port}/users/123`, res => res.resume())
          })
        })

        it('preserves API version segments', done => {
          appListener = server(port => {
            agent.assertFirstTraceSpan({ resource: 'GET /v2/lots/?/photos' }).then(done).catch(done)

            http.get(`http://localhost:${port}/v2/lots/8675309/photos`, res => res.resume())
          })
        })

        it('keeps the query string out of the resource name', done => {
          appListener = server(port => {
            agent.assertFirstTraceSpan({ resource: 'GET /users/?' }).then(done).catch(done)

            http.get(`http://localhost:${port}/users/123?token=secret`, res => res.resume())
          })
        })

        it('leaves a path with no quantizable segment untouched', done => {
          appListener = server(port => {
            agent.assertFirstTraceSpan({ resource: 'GET /health/status' }).then(done).catch(done)

            http.get(`http://localhost:${port}/health/status`, res => res.resume())
          })
        })
      })
    })
  })
})
