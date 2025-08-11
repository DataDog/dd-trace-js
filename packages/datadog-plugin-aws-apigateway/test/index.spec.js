'use strict'

const agent = require('../../dd-trace/test/plugins/agent')
const { expect } = require('chai')
const axios = require('axios')
const { Agent } = require('http')

// Create axios instance with no connection pooling
const httpClient = axios.create({
  httpAgent: new Agent({ keepAlive: false }),
  timeout: 5000
})

describe('Plugin', function () {
  let http
  let appListener
  let controller
  let port

  const inferredHeaders = {
    'x-dd-proxy': 'aws-apigateway',
    'x-dd-proxy-request-time-ms': '1729780025473',
    'x-dd-proxy-path': '/test',
    'x-dd-proxy-httpmethod': 'GET',
    'x-dd-proxy-domain-name': 'example.com',
    'x-dd-proxy-stage': 'dev'
  }

  afterEach(async () => {
    controller = null

    if (appListener) {
      // Force close all existing connections
      if (appListener._connections) {
        for (const connection of appListener._connections) {
          connection.destroy()
        }
      }

      await new Promise((resolve, reject) => {
        appListener.close((err) => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      })
      appListener = null
    }

    await agent.close()
  })

  describe('without configuration', () => {
    beforeEach(async () => {
      const options = {
        inferredProxyServicesEnabled: true,
        service: 'aws-server'
      }

      require('../../dd-trace').init(options)

      await agent.load(
        ['http', 'dns', 'net', 'aws-apigateway'],
        [{ client: false }, { enabled: false }, { enabled: false }, { enabled: true }],
        options
      )

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

      // Force close connections when server closes
      const connections = new Set()
      server.on('connection', (connection) => {
        connections.add(connection)
        connection.on('close', () => {
          connections.delete(connection)
        })
      })

      return new Promise((resolve, reject) => {
        appListener = server.listen(0, '127.0.0.1', () => {
          port = server.address().port
          appListener._connections = connections
          resolve()
        })
      })
    })

    it('should create a parent span and a child span for a 200', async () => {
      await httpClient.get(`http://127.0.0.1:${port}/`, {
        headers: inferredHeaders
      })

      await agent.assertSomeTraces(traces => {
        const spans = traces[0]

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
      })
    })

    it('should create a parent span and a child span for an error', async () => {
      await httpClient.get(`http://127.0.0.1:${port}/error`, {
        headers: inferredHeaders,
        validateStatus: function (status) {
          return status === 500
        }
      })

      await agent.assertSomeTraces(traces => {
        const spans = traces[0]
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
      })
    })

    it('should not create an API Gateway span if all necessary headers are missing', async () => {
      await httpClient.get(`http://127.0.0.1:${port}/no-aws-headers`, {
        headers: {}
      })

      await agent.assertSomeTraces(traces => {
        const spans = traces[0]
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
      })
    })

    it('should not create an API Gateway span if missing the proxy system header', async () => {
      // remove x-dd-proxy from headers
      const { 'x-dd-proxy': _, ...newHeaders } = inferredHeaders

      await httpClient.get(`http://127.0.0.1:${port}/a-few-aws-headers`, {
        headers: newHeaders
      })

      await agent.assertSomeTraces(traces => {
        const spans = traces[0]
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
      })
    })
  })

  describe('with configuration', function () {
    beforeEach(async () => {
      const options = {
        inferredProxyServicesEnabled: false,
        service: 'aws-server'
      }

      // we can't force re-init the tracer, so we have to set the config manually
      const tracer = require('../../dd-trace').init(options)
      tracer._tracer._config.inferredProxyServicesEnabled = false

      await agent.load(
        ['http', 'dns', 'net', 'aws-apigateway'],
        [{ client: false }, { enabled: false }, { enabled: false }, { enabled: true }],
        options
      )

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

      // Force close connections when server closes
      const connections = new Set()
      server.on('connection', (connection) => {
        connections.add(connection)
        connection.on('close', () => {
          connections.delete(connection)
        })
      })

      return new Promise((resolve, reject) => {
        appListener = server.listen(0, '127.0.0.1', () => {
          port = server.address().port
          appListener._connections = connections
          resolve()
        })
      })
    })

    it('should not create a span when configured to be off', async () => {
      await httpClient.get(`http://127.0.0.1:${port}/configured-off`, {
        headers: inferredHeaders
      })

      await agent.assertSomeTraces(traces => {
        const spans = traces[0]

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
      })
    })
  })
})
