'use strict'

const axios = require('axios')
const http = require('http')
const getPort = require('get-port')
const os = require('os')
const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')
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
      proxy.listen(proxyPort, function () {
        gateway = Gateway({
          edgemicro: {
            port: gatewayPort,
            logging: { level: 'info', dir: os.tmpdir() },
            proxy: 'http://localhost:' + proxyPort
          },
          proxies: [
            { base_path: '/v1', secure: false, url: 'http://localhost:' + apiPort }
          ]
        })

        gateway.start(cb)
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
      beforeEach(async () => {
        gatewayPort = await getPort()
        proxyPort = await getPort()
        apiPort = await getPort()
      })

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
            .use(traces => {
              const spans = traces[0]

              expect(spans[0]).to.have.property('name', 'microgateway.request')
              expect(spans[0]).to.have.property('service', 'test')
              expect(spans[0]).to.have.property('type', 'web')
              expect(spans[0]).to.have.property('resource', 'GET /v1')
              expect(spans[0].meta).to.have.property('span.kind', 'server')
              expect(spans[0].meta).to.have.property('http.url', `http://localhost:${gatewayPort}/v1/foo`)
              expect(spans[0].meta).to.have.property('http.method', 'GET')
              expect(spans[0].meta).to.have.property('http.status_code', '200')
            })
            .then(done)
            .catch(done)

          axios.get('http://localhost:' + gatewayPort + '/v1/foo').catch(done)
        })

        it('should propagate context to plugins', done => {
          const first = {
            init: (config, logging, stats) => ({
              onrequest: (req, res, options, cb) => {
                expect(tracer.scope().active()).to.not.be.null
                cb()
                // tracer.scope().activate('test', () => cb())
              }
            })
          }

          const second = {
            init: (req, res, options, cb) => ({
              onrequest: (req, res, options, cb) => {
                expect(tracer.scope().active()).to.not.be.null
                cb()
                // tracer.scope().activate('test', () => cb())
              }
            })
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
              }
            })
          }

          agent
            .use(traces => {
              const spans = traces[0]

              expect(spans[0]).to.have.property('name', 'microgateway.request')
              expect(spans[0]).to.have.property('resource', 'GET /v1')
              expect(spans[0].meta).to.have.property('error.type', error.name)
              expect(spans[0].meta).to.have.property('error.msg', error.message)
              expect(spans[0].meta).to.have.property('error.stack', error.stack)
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
              }
            })
          }

          agent
            .use(traces => {
              const spans = traces[0]

              expect(spans[0]).to.have.property('name', 'microgateway.request')
              expect(spans[0]).to.have.property('resource', 'GET /v1')
              expect(spans[0].meta).to.have.property('error.type', error.name)
              expect(spans[0].meta).to.have.property('error.msg', error.message)
              expect(spans[0].meta).to.have.property('error.stack', error.stack)
            })
            .then(done)
            .catch(done)

          gateway.addPlugin('test', plugin.init)

          axios.get('http://localhost:' + gatewayPort + '/v1/foo').catch(() => {})
        })

        if (semver.intersects(version, '>=2.3.3')) {
          it('should re-expose any exports', () => {
            expect(Gateway.Logging).to.be.an('object')
          })
        }
      })
    })
  })
})
