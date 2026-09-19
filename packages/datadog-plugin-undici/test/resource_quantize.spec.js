'use strict'

const { afterEach, beforeEach, describe, it } = require('mocha')

const { NODE_MAJOR } = require('../../../version')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

describe('Plugin', () => {
  let express
  let fetch
  let appListener

  describe('undici-fetch', () => {
    withVersions('undici', 'undici', NODE_MAJOR < 20 ? '<7.11.0' : '*', version => {
      describe('resource name quantization', () => {
        function server (app, listener) {
          const server = require('http').createServer(app)
          server.listen(0, 'localhost', () => {
            listener?.((/** @type {import('net').AddressInfo} */ (server.address())).port)
          })
          return server
        }

        function app () {
          const app = express()
          app.get('/users/:id', (req, res) => {
            res.status(200).send()
          })
          return app
        }

        beforeEach(() => {
          appListener = null
        })

        afterEach(() => {
          if (appListener) {
            appListener.close()
          }
          express = null
          return agent.close()
        })

        describe('when disabled', () => {
          beforeEach(() => {
            return agent.load('undici', { service: 'test' }).then(() => {
              express = require('express')
              fetch = require(`../../../versions/undici@${version}`, {}).get()
            })
          })

          it('uses the bare method as the resource name', done => {
            appListener = server(app(), port => {
              agent.assertFirstTraceSpan({ resource: 'GET' }).then(done).catch(done)

              fetch.fetch(`http://localhost:${port}/users/123`, { method: 'GET' })
            })
          })
        })

        describe('when enabled', () => {
          beforeEach(() => {
            process.env.DD_TRACE_HTTP_CLIENT_RESOURCE_NAME_QUANTIZE = 'true'
            return agent.load('undici', { service: 'test' }).then(() => {
              express = require('express')
              fetch = require(`../../../versions/undici@${version}`, {}).get()
            })
          })

          afterEach(() => {
            delete process.env.DD_TRACE_HTTP_CLIENT_RESOURCE_NAME_QUANTIZE
          })

          it('appends the quantized path to the method', done => {
            appListener = server(app(), port => {
              agent.assertFirstTraceSpan({ resource: 'GET /users/?' }).then(done).catch(done)

              fetch.fetch(`http://localhost:${port}/users/123`, { method: 'GET' })
            })
          })

          it('keeps the query string out of the resource name', done => {
            appListener = server(app(), port => {
              agent.assertFirstTraceSpan({ resource: 'GET /users/?' }).then(done).catch(done)

              fetch.fetch(`http://localhost:${port}/users/123?token=secret`, { method: 'GET' })
            })
          })
        })
      })
    })
  })
})
