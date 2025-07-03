'use strict'

require('../../setup/tap')

const agent = require('../agent')
const getPort = require('get-port')
const { expect } = require('chai')
const axios = require('axios')

describe('Inferred Proxy Spans', function () {
  let http
  let appListener
  let controller
  let port

  // tap was throwing timeout errors when trying to use hooks like `before`, so instead we just use this function
  // and call before the test starts
  const loadTest = async function (options) {
    process.env.DD_SERVICE = 'aws-server'
    process.env.DD_TRACE_INFERRED_PROXY_SERVICES_ENABLED = 'true'

    port = await getPort()
    require('../../../../dd-trace')

    await agent.load(['http'], null, options)

    http = require('http')

    const server = new http.Server(async (req, res) => {
      controller && await controller(req, res)
      if (req.url === '/error') {
        res.statusCode = 500
        res.end(JSON.stringify({ message: 'ERROR' }))
      } else {
        res.writeHead(200)
        res.end(JSON.stringify({ message: 'OK' }))
      }
    })

    appListener = server.listen(port, '127.0.0.1')
  }

  // test cleanup function
  const cleanupTest = function () {
    appListener && appListener.close()
    try {
      agent.close({ ritmReset: false })
    } catch {
      // pass
    }
  }

  const inferredHeaders = {
    'x-dd-proxy': 'aws-apigateway',
    'x-dd-proxy-request-time-ms': '1729780025473',
    'x-dd-proxy-path': '/test',
    'x-dd-proxy-httpmethod': 'GET',
    'x-dd-proxy-domain-name': 'example.com',
    'x-dd-proxy-stage': 'dev'
  }

  describe('without configuration', () => {
    it('should create a parent span and a child span for a 200', async () => {
      await loadTest({})

      await axios.get(`http://127.0.0.1:${port}/`, {
        headers: inferredHeaders
      })

      await agent.assertSomeTraces(traces => {
        for (const trace of traces) {
          try {
            const spans = trace

            expect(spans.length).to.be.equal(2)

            expect(spans[0]).to.have.property('name', 'aws.apigateway')
            expect(spans[0]).to.have.property('service', 'example.com')
            expect(spans[0]).to.have.property('resource', 'GET /test')
            expect(spans[0]).to.have.property('type', 'web')
            expect(spans[0].meta).to.have.property('http.url', 'example.com/test')
            expect(spans[0].meta).to.have.property('http.method', 'GET')
            expect(spans[0].meta).to.have.property('http.status_code', '200')
            expect(spans[0].meta).to.have.property('component', 'aws-apigateway')
            expect(spans[0].meta).to.have.property('_dd.integration', 'aws-apigateway')
            expect(spans[0].metrics).to.have.property('_dd.inferred_span', 1)
            expect(spans[0].start.toString()).to.be.equal('1729780025472999936')

            expect(spans[0].span_id.toString()).to.be.equal(spans[1].parent_id.toString())

            expect(spans[1]).to.have.property('name', 'web.request')
            expect(spans[1]).to.have.property('service', 'aws-server')
            expect(spans[1]).to.have.property('type', 'web')
            expect(spans[1]).to.have.property('resource', 'GET')
            expect(spans[1].meta).to.have.property('component', 'http')
            expect(spans[1].meta).to.have.property('span.kind', 'server')
            expect(spans[1].meta).to.have.property('http.url', `http://127.0.0.1:${port}/`)
            expect(spans[1].meta).to.have.property('http.method', 'GET')
            expect(spans[1].meta).to.have.property('http.status_code', '200')
            expect(spans[1].meta).to.have.property('span.kind', 'server')
            break
          } catch {
            continue
          }
        }
      }).then(cleanupTest).catch(cleanupTest)
    })

    it('should create a parent span and a child span for an error', async () => {
      await loadTest({})

      await axios.get(`http://127.0.0.1:${port}/error`, {
        headers: inferredHeaders,
        validateStatus: function (status) {
          return status === 500
        }
      })

      await agent.assertSomeTraces(traces => {
        for (const trace of traces) {
          try {
            const spans = trace
            expect(spans.length).to.be.equal(2)

            expect(spans[0]).to.have.property('name', 'aws.apigateway')
            expect(spans[0]).to.have.property('service', 'example.com')
            expect(spans[0]).to.have.property('resource', 'GET /test')
            expect(spans[0]).to.have.property('type', 'web')
            expect(spans[0].meta).to.have.property('http.url', 'example.com/test')
            expect(spans[0].meta).to.have.property('http.method', 'GET')
            expect(spans[0].meta).to.have.property('http.status_code', '500')
            expect(spans[0].meta).to.have.property('component', 'aws-apigateway')
            expect(spans[0].error).to.be.equal(1)
            expect(spans[0].start.toString()).to.be.equal('1729780025472999936')
            expect(spans[0].span_id.toString()).to.be.equal(spans[1].parent_id.toString())

            expect(spans[1]).to.have.property('name', 'web.request')
            expect(spans[1]).to.have.property('service', 'aws-server')
            expect(spans[1]).to.have.property('type', 'web')
            expect(spans[1]).to.have.property('resource', 'GET')
            expect(spans[1].meta).to.have.property('component', 'http')
            expect(spans[1].meta).to.have.property('span.kind', 'server')
            expect(spans[1].meta).to.have.property('http.url', `http://127.0.0.1:${port}/error`)
            expect(spans[1].meta).to.have.property('http.method', 'GET')
            expect(spans[1].meta).to.have.property('http.status_code', '500')
            expect(spans[1].meta).to.have.property('span.kind', 'server')
            expect(spans[1].error).to.be.equal(1)
            break
          } catch {
            continue
          }
        }
      }).then(cleanupTest).catch(cleanupTest)
    })

    it('should not create an API Gateway span if all necessary headers are missing', async () => {
      await loadTest({})

      await axios.get(`http://127.0.0.1:${port}/no-aws-headers`, {
        headers: {}
      })

      await agent.assertSomeTraces(traces => {
        for (const trace of traces) {
          try {
            const spans = trace
            expect(spans.length).to.be.equal(1)

            expect(spans[0]).to.have.property('name', 'web.request')
            expect(spans[0]).to.have.property('service', 'aws-server')
            expect(spans[0]).to.have.property('type', 'web')
            expect(spans[0]).to.have.property('resource', 'GET')
            expect(spans[0].meta).to.have.property('component', 'http')
            expect(spans[0].meta).to.have.property('span.kind', 'server')
            expect(spans[0].meta).to.have.property('http.url', `http://127.0.0.1:${port}/no-aws-headers`)
            expect(spans[0].meta).to.have.property('http.method', 'GET')
            expect(spans[0].meta).to.have.property('http.status_code', '200')
            expect(spans[0].meta).to.have.property('span.kind', 'server')
            expect(spans[0].error).to.be.equal(0)
            break
          } catch {
            continue
          }
        }
      }).then(cleanupTest).catch(cleanupTest)
    })

    it('should not create an API Gateway span if missing the proxy system header', async () => {
      await loadTest({})

      // remove x-dd-proxy from headers
      const { 'x-dd-proxy': _, ...newHeaders } = inferredHeaders

      await axios.get(`http://127.0.0.1:${port}/a-few-aws-headers`, {
        headers: newHeaders
      })

      await agent.assertSomeTraces(traces => {
        for (const trace of traces) {
          try {
            const spans = trace
            expect(spans.length).to.be.equal(1)

            expect(spans[0]).to.have.property('name', 'web.request')
            expect(spans[0]).to.have.property('service', 'aws-server')
            expect(spans[0]).to.have.property('type', 'web')
            expect(spans[0]).to.have.property('resource', 'GET')
            expect(spans[0].meta).to.have.property('component', 'http')
            expect(spans[0].meta).to.have.property('span.kind', 'server')
            expect(spans[0].meta).to.have.property('http.url', `http://127.0.0.1:${port}/a-few-aws-headers`)
            expect(spans[0].meta).to.have.property('http.method', 'GET')
            expect(spans[0].meta).to.have.property('http.status_code', '200')
            expect(spans[0].meta).to.have.property('span.kind', 'server')
            expect(spans[0].error).to.be.equal(0)
            break
          } catch {
            continue
          }
        }
      }).then(cleanupTest).catch(cleanupTest)
    })
  })

  describe('with configuration', function () {
    it('should not create a span when configured to be off', async () => {
      await loadTest({ inferredProxyServicesEnabled: false })

      await axios.get(`http://127.0.0.1:${port}/configured-off`, {
        headers: inferredHeaders
      })

      await agent.assertSomeTraces(traces => {
        for (const trace of traces) {
          try {
            const spans = trace

            expect(spans.length).to.be.equal(1)

            expect(spans[0]).to.have.property('name', 'web.request')
            expect(spans[0]).to.have.property('service', 'aws-server')
            expect(spans[0]).to.have.property('type', 'web')
            expect(spans[0]).to.have.property('resource', 'GET')
            expect(spans[0].meta).to.have.property('component', 'http')
            expect(spans[0].meta).to.have.property('span.kind', 'server')
            expect(spans[0].meta).to.have.property('http.url', `http://127.0.0.1:${port}/configured-off`)
            expect(spans[0].meta).to.have.property('http.method', 'GET')
            expect(spans[0].meta).to.have.property('http.status_code', '200')
            expect(spans[0].meta).to.have.property('span.kind', 'server')
            break
          } catch {
            continue
          }
        }
      }).then(cleanupTest).catch(cleanupTest)
    })
  })
})
