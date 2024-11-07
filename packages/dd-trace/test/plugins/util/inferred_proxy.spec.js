'use strict'

require('../setup/tap')

const getPort = require('get-port')
const { expect } = require('chai')
const axios = require('axios')
const agent = require('../../../test/plugins/agent')

describe('Inferred Proxy Spans', function () {
  this.timeout(60000)
  let port, appListener, controller
  let http

  before(async () => {
    process.env.DD_SERVICE = 'aws-server'
    const tracer = require('../../../../dd-trace').init()

    port = await getPort()

    await agent.load('http').then(() => {
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

      appListener = server.listen(port, 'localhost')
    })
  })

  after(() => {
    appListener && appListener.close()
    return agent.close({ ritmReset: false })
  })

  const inferredHeaders = {
    'x-dd-proxy-name': 'aws-apigateway',
    'x-dd-proxy-request-time': '1729780025473',
    'x-dd-proxy-path': '/test',
    'x-dd-proxy-httpmethod': 'GET',
    'x-dd-proxy-domain-name': 'example.com',
    'x-dd-proxy-stage': 'dev'
  }

  describe('without configuration', function () {
    it('should create a parent span and a child span for a 200', async () => {
      await axios.get(`http://localhost:${port}/`, {
        headers: inferredHeaders
      })

      await agent.use(traces => {
        const spans = traces[1]

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
        expect(spans[1].meta).to.have.property('http.url', `http://localhost:${port}/`)
        expect(spans[1].meta).to.have.property('http.method', 'GET')
        expect(spans[1].meta).to.have.property('http.status_code', '200')
        expect(spans[1].meta).to.have.property('span.kind', 'server')
      }).then().catch()
    })

    it('should create a parent span and a child span for a 500', async () => {
      await axios.get(`http://localhost:${port}/error`, {
        headers: inferredHeaders,
        validateStatus: function (status) {
          return status === 500
        }
      })

      await agent.use(traces => {
        const spans = traces[1]
        // TODO: figure out why this test only creates one http.request
        expect(spans.length).to.be.equal(2)
      })
    })

    it('should not create an API Gateway span if all necessary headers are', async () => {
      await axios.get(`http://localhost:${port}/`, {
        headers: {}
      })

      await agent.use(traces => {
        const spans = traces[1]
        expect(spans.length).to.be.equal(1)
      })
    })
  })

  describe('with configuration', function () {
    before(() => {
      return agent.load(null, null, { managedServicesEnabled: false })
    })

    it('should not create a span when configured to be off', async () => {
      await axios.get(`http://localhost:${port}/`, {
        headers: inferredHeaders
      })

      await agent.use(traces => {
        const spans = traces[1]

        expect(spans.length).to.be.equal(1)

        expect(spans[0]).to.have.property('name', 'web.request')
        expect(spans[0]).to.have.property('service', 'aws-server')
        expect(spans[0]).to.have.property('type', 'web')
        expect(spans[0]).to.have.property('resource', 'GET')
        expect(spans[0].meta).to.have.property('component', 'http')
        expect(spans[0].meta).to.have.property('span.kind', 'server')
        expect(spans[0].meta).to.have.property('http.url', `http://localhost:${port}/`)
        expect(spans[0].meta).to.have.property('http.method', 'GET')
        expect(spans[0].meta).to.have.property('http.status_code', '200')
        expect(spans[0].meta).to.have.property('span.kind', 'server')
      }).then().catch()
    })
  })
})
