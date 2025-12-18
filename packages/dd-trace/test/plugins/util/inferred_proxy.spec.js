'use strict'

const assert = require('node:assert/strict')
const { Agent } = require('node:http')
// Create axios instance with no connection pooling

const { describe, it, afterEach } = require('mocha')
const axios = require('axios')

require('../../setup/core')
const agent = require('../agent')
const { assertObjectContains } = require('../../../../../integration-tests/helpers')

const httpClient = axios.create({
  httpAgent: new Agent({ keepAlive: false }),
  timeout: 5000
})

describe('Inferred Proxy Spans', function () {
  let http
  let appListener
  let controller
  let port

  // tap was throwing timeout errors when trying to use hooks like `before`, so instead we just use this function
  // and call before the test starts
  const loadTest = async function ({ inferredProxyServicesEnabled = true } = {}) {
    const options = {
      inferredProxyServicesEnabled,
      service: 'aws-server'
    }

    await agent.load(
      ['http', 'dns', 'net'],
      [{ client: false }, { enabled: false }, { enabled: false }],
      options
    )

    // we can't force re-init the tracer, so we have to set the config manually
    const tracer = require('../../../../dd-trace').init(options)
    tracer._tracer._config.inferredProxyServicesEnabled = inferredProxyServicesEnabled

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
        port = (/** @type {import('net').AddressInfo} */ (server.address())).port
        appListener._connections = connections
        resolve()
      })
    })
  }

  const cleanupTest = async function () {
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
  }

  const inferredHeaders = {
    'x-dd-proxy': 'aws-apigateway',
    'x-dd-proxy-request-time-ms': '1729780025473',
    'x-dd-proxy-path': '/test',
    'x-dd-proxy-httpmethod': 'GET',
    'x-dd-proxy-domain-name': 'example.com',
    'x-dd-proxy-stage': 'dev'
  }

  afterEach(async () => {
    await cleanupTest()
  })

  describe('without configuration', () => {
    it('should create a parent span and a child span for a 200', async () => {
      await loadTest({})

      await httpClient.get(`http://127.0.0.1:${port}/`, {
        headers: inferredHeaders
      })

      await agent.assertSomeTraces(traces => {
        const spans = traces[0]

        assert.strictEqual(spans.length, 2)

        assert.strictEqual(spans[0].name, 'aws.apigateway')
        assert.strictEqual(spans[0].service, 'example.com')
        assert.strictEqual(spans[0].resource, 'GET /test')
        assert.strictEqual(spans[0].type, 'web')
        assertObjectContains(spans[0], {
          meta: {
            'http.url': 'example.com/test',
            'http.method': 'GET',
            'http.status_code': '200',
            component: 'aws-apigateway',
            '_dd.integration': 'aws-apigateway'
          },
          metrics: {
            '_dd.inferred_span': 1
          }
        })
        assert.strictEqual(spans[0].start.toString(), '1729780025472999936')

        assert.strictEqual(spans[0].span_id.toString(), spans[1].parent_id.toString())

        assertObjectContains(spans[1], {
          name: 'web.request',
          service: 'aws-server',
          type: 'web',
          resource: 'GET',
          meta: {
            component: 'http',
            'span.kind': 'server',
            'http.url': `http://127.0.0.1:${port}/`,
            'http.method': 'GET',
            'http.status_code': '200'
          }
        })
      })
    })

    it('should create a parent span and a child span for an error', async () => {
      await loadTest({})

      await httpClient.get(`http://127.0.0.1:${port}/error`, {
        headers: inferredHeaders,
        validateStatus: function (status) {
          return status === 500
        }
      })

      await agent.assertSomeTraces(traces => {
        const spans = traces[0]
        assert.strictEqual(spans.length, 2)

        assertObjectContains(spans[0], {
          name: 'aws.apigateway',
          service: 'example.com',
          resource: 'GET /test',
          type: 'web',
          meta: {
            'http.url': 'example.com/test',
            'http.method': 'GET',
            'http.status_code': '500',
            component: 'aws-apigateway'
          }
        })

        assert.strictEqual(spans[0].error, 1)
        assert.strictEqual(spans[0].start.toString(), '1729780025472999936')
        assert.strictEqual(spans[0].span_id.toString(), spans[1].parent_id.toString())

        assertObjectContains(spans[1], {
          name: 'web.request',
          service: 'aws-server',
          type: 'web',
          resource: 'GET',
          meta: {
            component: 'http',
            'span.kind': 'server',
            'http.url': `http://127.0.0.1:${port}/error`,
            'http.method': 'GET',
            'http.status_code': '500'
          }
        })

        assert.strictEqual(spans[1].error, 1)
      })
    })

    it('should not create an API Gateway span if all necessary headers are missing', async () => {
      await loadTest({})

      await httpClient.get(`http://127.0.0.1:${port}/no-aws-headers`, {
        headers: {}
      })

      await agent.assertSomeTraces(traces => {
        const spans = traces[0]
        assert.strictEqual(spans.length, 1)

        assertObjectContains(spans[0], {
          name: 'web.request',
          service: 'aws-server',
          type: 'web',
          resource: 'GET',
          meta: {
            component: 'http',
            'span.kind': 'server',
            'http.url': `http://127.0.0.1:${port}/no-aws-headers`,
            'http.method': 'GET',
            'http.status_code': '200'
          }
        })

        assert.strictEqual(spans[0].error, 0)
      })
    })

    it('should not create an API Gateway span if missing the proxy system header', async () => {
      await loadTest({})

      // remove x-dd-proxy from headers
      const { 'x-dd-proxy': _, ...newHeaders } = inferredHeaders

      await httpClient.get(`http://127.0.0.1:${port}/a-few-aws-headers`, {
        headers: newHeaders
      })

      await agent.assertSomeTraces(traces => {
        const spans = traces[0]
        assert.strictEqual(spans.length, 1)

        assertObjectContains(spans[0], {
          name: 'web.request',
          service: 'aws-server',
          type: 'web',
          resource: 'GET',
          meta: {
            component: 'http',
            'span.kind': 'server',
            'http.url': `http://127.0.0.1:${port}/a-few-aws-headers`,
            'http.method': 'GET',
            'http.status_code': '200'
          }
        })

        assert.strictEqual(spans[0].error, 0)
      })
    })
  })

  describe('with configuration', function () {
    it('should not create a span when configured to be off', async () => {
      await loadTest({ inferredProxyServicesEnabled: false })

      await httpClient.get(`http://127.0.0.1:${port}/configured-off`, {
        headers: inferredHeaders
      })

      await agent.assertSomeTraces(traces => {
        const spans = traces[0]

        assert.strictEqual(spans.length, 1)

        assertObjectContains(spans[0], {
          name: 'web.request',
          service: 'aws-server',
          type: 'web',
          resource: 'GET',
          meta: {
            component: 'http',
            'span.kind': 'server',
            'http.url': `http://127.0.0.1:${port}/configured-off`,
            'http.method': 'GET',
            'http.status_code': '200'
          }
        })
      })
    })
  })
})
