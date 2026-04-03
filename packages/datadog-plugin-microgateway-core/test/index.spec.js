'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const os = require('node:os')

const axios = require('axios')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')

const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const proxy = require('./proxy')

describe('Plugin', () => {
  let Gateway
  let gateway
  let tracer
  let api
  let gatewayPort
  let proxyPort
  let apiPort

  const startGateway = (cb) => {
    const api = http.createServer((req, res) => res.end('OK'))

    api.listen(apiPort, function () {
      const apiPort = api.address().port

      proxy.listen(proxyPort, function () {
        const proxyPort = proxy.address().port

        gateway = Gateway({
          edgemicro: {
            port: gatewayPort,
            logging: { level: 'info', dir: os.tmpdir() },
            proxy: 'http://localhost:' + proxyPort,
          },
          proxies: [
            { base_path: '/v1', secure: false, url: 'http://localhost:' + apiPort },
          ],
        })

        gateway.start((err, server) => {
          gatewayPort = (/** @type {import('net').AddressInfo} */ (server.address())).port
          cb(err)
        })
      })
    })
  }

  const stopGateway = () => {
    gateway && gateway.stop(() => {})
    api && api.close()
    proxy && proxy.close()
  }

  describe('microgateway-core', () => {
    withVersions('microgateway-core', 'microgateway-core', (version) => {
      afterEach(() => {
        stopGateway()
      })

      describe('without configuration', () => {
        before(() => {
          tracer = require('../../dd-trace')

          return agent.load(['microgateway-core', 'http'], [{}, { client: false }])
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(done => {
          Gateway = require(`../../../versions/microgateway-core@${version}`).get()
          gateway = startGateway(() => done())
        })

        it('should do automatic instrumentation', done => {
          agent
            .assertSomeTraces(traces => {
              const spans = traces[0]

              assert.strictEqual(spans[0].name, 'microgateway.request')
              assert.strictEqual(spans[0].service, 'test')
              assert.strictEqual(spans[0].type, 'web')
              assert.strictEqual(spans[0].resource, 'GET /v1')
              assert.strictEqual(spans[0].meta['span.kind'], 'server')
              assert.strictEqual(spans[0].meta['http.url'], `http://localhost:${gatewayPort}/v1/foo`)
              assert.strictEqual(spans[0].meta['http.method'], 'GET')
              assert.strictEqual(spans[0].meta['http.status_code'], '200')
              assert.strictEqual(spans[0].meta.component, 'microgateway')
              assert.strictEqual(spans[0].meta['_dd.integration'], 'microgateway')
            })
            .then(done)
            .catch(done)

          axios.get('http://localhost:' + gatewayPort + '/v1/foo').catch(done)
        })

        it('should propagate context to plugins', done => {
          const onrequest = (req, res, options, cb) => {
            assert.notStrictEqual(tracer.scope().active(), null)
            cb()
          }

          const first = {
            init: (config, logging, stats) => ({ onrequest }),
          }

          const second = {
            init: (config, logging, stats) => ({ onrequest }),
          }

          gateway.addPlugin('first', first.init)
          gateway.addPlugin('second', second.init)

          axios.get('http://localhost:' + gatewayPort + '/v1/foo')
            .then(() => done())
            .catch(done)
        })

        it('should handle plugin errors', done => {
          const error = new Error('boom')
          const plugin = {
            init: (config, logging, stats) => ({
              onrequest: (req, res, options, cb) => {
                cb(error)
              },
            }),
          }

          agent
            .assertSomeTraces(traces => {
              const spans = traces[0]

              assert.strictEqual(spans[0].name, 'microgateway.request')
              assert.strictEqual(spans[0].resource, 'GET /v1')
              assert.strictEqual(spans[0].meta[ERROR_TYPE], error.name)
              assert.strictEqual(spans[0].meta[ERROR_MESSAGE], error.message)
              assert.strictEqual(spans[0].meta[ERROR_STACK], error.stack)
              assert.strictEqual(spans[0].meta.component, 'microgateway')
            })
            .then(done)
            .catch(done)

          gateway.addPlugin('test', plugin.init)

          axios.get('http://localhost:' + gatewayPort + '/v1/foo').catch(() => {})
        })

        it('should handle plugin exceptions', done => {
          const error = new Error('boom')
          const plugin = {
            init: (config, logging, stats) => ({
              onrequest: (req, res, options, cb) => {
                throw error
              },
            }),
          }

          agent
            .assertSomeTraces(traces => {
              const spans = traces[0]

              assert.strictEqual(spans[0].name, 'microgateway.request')
              assert.strictEqual(spans[0].resource, 'GET /v1')
              assert.strictEqual(spans[0].meta[ERROR_TYPE], error.name)
              assert.strictEqual(spans[0].meta[ERROR_MESSAGE], error.message)
              assert.strictEqual(spans[0].meta[ERROR_STACK], error.stack)
              assert.strictEqual(spans[0].meta.component, 'microgateway')
            })
            .then(done)
            .catch(done)

          gateway.addPlugin('test', plugin.init)

          axios.get('http://localhost:' + gatewayPort + '/v1/foo').catch(() => {})
        })

        if (semver.intersects(version, '>=2.3.3')) {
          it('should re-expose any exports', () => {
            assert.ok(typeof Gateway.Logging === 'object' && Gateway.Logging !== null)
          })
        }
      })
    })
  })
})
