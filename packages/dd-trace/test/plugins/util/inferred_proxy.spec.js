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

  beforeEach(async () => {
    process.env.DD_SERVICE = 'aws-server'

    port = await getPort()

    await agent.load(['http'])

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
  })

  afterEach(() => {
    appListener && appListener.close()
    return agent.close({ ritmReset: false })
  })

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
      await axios.get(`http://127.0.0.1:${port}/`, {
        headers: inferredHeaders
      })

      await agent.use(traces => {
        for (const trace of traces) {
          try {
            const spans = trace

            expect(spans.length).to.be.equal(2)

            expect(spans[0]).to.have.property('name', 'aws.apigateway')
            expect(spans[0]).to.have.property('service', 'example.com')
            expect(spans[0]).to.have.property('resource', 'GET /test')
            expect(spans[0].meta).to.have.property('type', 'web')
            expect(spans[0].meta).to.have.property('http.url', 'example.com/test')
            expect(spans[0].meta).to.have.property('http.method', 'GET')
            expect(spans[0].meta).to.have.property('http.status_code', '200')
            expect(spans[0].meta).to.have.property('http.route', '/test')
            expect(spans[0].meta).to.have.property('span.kind', 'internal')
            expect(spans[0].meta).to.have.property('component', 'aws-apigateway')

            // TODO: Fix this and ensure start time is correct
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
      }).then().catch()
    })

    it('should create a parent span and a child span for an error', async () => {
      await axios.get(`http://127.0.0.1:${port}/error`, {
        headers: inferredHeaders,
        validateStatus: function (status) {
          return status === 500
        }
      })

      await agent.use(traces => {
        for (const trace of traces) {
          try {
            const spans = trace
            // TODO: figure out why this test only creates one http.request
            expect(spans.length).to.be.equal(2)

            expect(spans[0]).to.have.property('name', 'aws.apigateway')
            expect(spans[0]).to.have.property('service', 'example.com')
            expect(spans[0]).to.have.property('resource', 'GET /test')
            expect(spans[0].meta).to.have.property('type', 'web')
            expect(spans[0].meta).to.have.property('http.url', 'example.com/test')
            expect(spans[0].meta).to.have.property('http.method', 'GET')
            expect(spans[0].meta).to.have.property('http.status_code', '500')
            expect(spans[0].meta).to.have.property('http.route', '/test')
            expect(spans[0].meta).to.have.property('span.kind', 'internal')
            expect(spans[0].meta).to.have.property('component', 'aws-apigateway')
            // TODO ensure we add error here too
            expect(spans[0].error).to.be.equal(1)

            // TODO: Fix this and ensure start time is correct
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
      }).then().catch()
    })

    it('should not create an API Gateway span if all necessary headers are missing', async () => {
      await axios.get(`http://127.0.0.1:${port}/no-aws-headers`, {
        headers: {}
      })

      await agent.use(traces => {
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
      }).then().catch()
    })

    it('should not create an API Gateway span if missing the proxy system header', async () => {
      // remove x-dd-proxy from headers
      const { 'x-dd-proxy': _, ...newHeaders } = inferredHeaders

      await axios.get(`http://127.0.0.1:${port}/a-few-aws-headers`, {
        headers: newHeaders
      })

      await agent.use(traces => {
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
      }).then().catch()
    })

    describe('with configuration', function () {
      before(() => {
        return agent.load(null, null, { inferredProxyServicesEnabled: false })
      })

      after(() => agent.reset({ ritmReset: true }))

      it('should not create a span when configured to be off', async () => {
        await axios.get(`http://127.0.0.1:${port}/configured-off`, {
          headers: inferredHeaders
        })

        await agent.use(traces => {
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
        }).then().catch()
      })
    })
  })
})
