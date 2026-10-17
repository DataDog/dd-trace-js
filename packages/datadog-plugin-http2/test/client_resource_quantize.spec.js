'use strict'

const { afterEach, beforeEach, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')

describe('Plugin', () => {
  describe('http2/client', () => {
    describe('resource name quantization', () => {
      let http2
      let appListener

      function server (listener) {
        const server = require('http2').createServer()
        server.on('stream', stream => {
          stream.respond({ ':status': 200 })
          stream.end()
        })
        server.listen(0, 'localhost', () => {
          listener((/** @type {import('net').AddressInfo} */ (server.address())).port)
        })
        return server
      }

      function request (port, path) {
        const client = http2.connect(`http://localhost:${port}`)
        const req = client.request({ ':path': path, ':method': 'GET' })
        req.on('response', () => {
          req.resume()
          req.on('end', () => client.close())
        })
        req.end()
        return client
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
          return agent.load('http2', { server: false }).then(() => {
            http2 = require('http2')
          })
        })

        it('uses the bare method as the resource name', done => {
          appListener = server(port => {
            agent.assertFirstTraceSpan({ resource: 'GET' }).then(done).catch(done)

            request(port, '/users/123').on('error', done)
          })
        })
      })

      describe('when enabled', () => {
        beforeEach(() => {
          process.env.DD_TRACE_HTTP_CLIENT_RESOURCE_NAME_QUANTIZE = 'true'
          return agent.load('http2', { server: false }).then(() => {
            http2 = require('http2')
          })
        })

        afterEach(() => {
          delete process.env.DD_TRACE_HTTP_CLIENT_RESOURCE_NAME_QUANTIZE
        })

        it('appends the quantized path to the method', done => {
          appListener = server(port => {
            agent.assertFirstTraceSpan({ resource: 'GET /users/?' }).then(done).catch(done)

            request(port, '/users/123').on('error', done)
          })
        })

        it('keeps the query string out of the resource name', done => {
          appListener = server(port => {
            agent.assertFirstTraceSpan({ resource: 'GET /users/?' }).then(done).catch(done)

            request(port, '/users/123?token=secret').on('error', done)
          })
        })
      })
    })
  })
})
