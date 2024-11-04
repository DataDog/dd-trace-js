'use strict'

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
        res.writeHead(200)
        res.end(JSON.stringify({ message: 'OK' }))
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
    'x-dd-proxy-request-time': '123456.45',
    'x-dd-proxy-path': '/test',
    'x-dd-proxy-httpmethod': 'GET',
    'x-dd-proxy-domain-name': 'example.com',
    'x-dd-proxy-stage': 'dev'
  }

  it('should create a parent span and a child span', async () => {
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

      expect(spans[0].start.toString()).to.be.equal('123456000000')

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
})
