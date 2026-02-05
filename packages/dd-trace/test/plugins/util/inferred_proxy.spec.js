'use strict'

const assert = require('node:assert/strict')
const { Agent } = require('node:http')

const { describe, it, afterEach } = require('mocha')
const axios = require('axios')

require('../../setup/core')
const agent = require('../agent')
const { assertObjectContains } = require('../../../../../integration-tests/helpers')

// Create axios instance with no connection pooling
const httpClient = axios.create({
  httpAgent: new Agent({ keepAlive: false }),
  timeout: 5000,
})

// Configuration for each proxy type
const proxyConfigs = {
  'aws-apigateway': {
    headers: {
      'x-dd-proxy': 'aws-apigateway',
      'x-dd-proxy-request-time-ms': '1729780025473',
      'x-dd-proxy-path': '/test',
      'x-dd-proxy-httpmethod': 'GET',
      'x-dd-proxy-domain-name': 'example.com',
      'x-dd-proxy-stage': 'dev',
    },
    expectedSpanName: 'aws.apigateway',
    expectedService: 'example.com',
    expectedComponent: 'aws-apigateway',
    expectedUrl: 'example.com/test',
    expectedStartTime: '1729780025472999936',
  },
  'azure-apim': {
    headers: {
      'x-dd-proxy': 'azure-apim',
      'x-dd-proxy-request-time-ms': '1729780025473',
      'x-dd-proxy-path': '/test',
      'x-dd-proxy-httpmethod': 'GET',
      'x-dd-proxy-domain-name': 'azure-example.com',
      // Add any other Azure-specific headers here
    },
    expectedSpanName: 'azure.apim',
    expectedService: 'azure-example.com',
    expectedComponent: 'azure-apim',
    expectedUrl: 'azure-example.com/test',
    expectedStartTime: '1729780025472999936',
  },
}

Object.entries(proxyConfigs).forEach(([proxyType, config]) => {
  describe(`Inferred Proxy Spans - ${proxyType}`, function () {
    let http
    let appListener
    let controller
    let port

    // Timeout errors occurred when trying to use hooks like `before`, so instead we just use this function
    // and call before the test starts
    const loadTest = async function ({ inferredProxyServicesEnabled = true } = {}) {
      const options = {
        inferredProxyServicesEnabled,
        service: 'aws-server',
      }

      await agent.load(
        ['http', 'dns', 'net'],
        [{ client: false }, { enabled: false }, { enabled: false }],
        options
      )

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

      const connections = new Set()
      server.on('connection', (connection) => {
        connections.add(connection)
        connection.on('close', () => {
          connections.delete(connection)
        })
      })

      return new Promise(/** @type {() => void} */ (resolve, reject) => {
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

        await new Promise(/** @type {() => void} */ (resolve, reject) => {
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

  // API Gateway v1 headers
  const inferredHeaders = {
    'x-dd-proxy': 'aws-apigateway',
    'x-dd-proxy-request-time-ms': '1729780025473',
    'x-dd-proxy-path': '/test',
    'x-dd-proxy-httpmethod': 'GET',
    'x-dd-proxy-domain-name': 'example.com',
    'x-dd-proxy-stage': 'dev',
  }

  // API Gateway v2 headers
  const inferredHeadersV2 = {
    'x-dd-proxy': 'aws-httpapi',
    'x-dd-proxy-request-time-ms': '1729780025473',
    'x-dd-proxy-path': '/test',
    'x-dd-proxy-httpmethod': 'GET',
    'x-dd-proxy-domain-name': 'example.com',
    'x-dd-proxy-stage': 'dev',
  }

  const inferredHeadersWithRoute = {
    'x-dd-proxy': 'aws-apigateway',
    'x-dd-proxy-request-time-ms': '1729780025473',
    'x-dd-proxy-path': '/users/123',
    'x-dd-proxy-httpmethod': 'GET',
    'x-dd-proxy-domain-name': 'example.com',
    'x-dd-proxy-stage': 'dev',
    'x-dd-proxy-resource-path': '/users/{id}',
  }

  const inferredHeadersWithOptionalTags = {
    'x-dd-proxy': 'aws-apigateway',
    'x-dd-proxy-request-time-ms': '1729780025473',
    'x-dd-proxy-path': '/users/123',
    'x-dd-proxy-httpmethod': 'GET',
    'x-dd-proxy-domain-name': 'example.com',
    'x-dd-proxy-stage': 'prod',
    'x-dd-proxy-resource-path': '/users/{id}',
    'x-dd-proxy-account-id': '123456789012',
    'x-dd-proxy-api-id': 'abc123def4',
    'x-dd-proxy-region': 'us-east-1',
    'x-dd-proxy-user': 'arn:aws:iam::123456789012:user/testuser',
  }

  afterEach(async () => {
    await cleanupTest()
  })

    describe('without configuration', () => {
      it('should create a parent span and a child span for a 200', async () => {
        await loadTest({})

        await httpClient.get(`http://127.0.0.1:${port}/`, {
          headers: config.headers,
        })

        await agent.assertSomeTraces(traces => {
          const spans = traces[0]

          assert.strictEqual(spans.length, 2)

          assert.strictEqual(spans[0].name, config.expectedSpanName)
          assert.strictEqual(spans[0].service, config.expectedService)
          assert.strictEqual(spans[0].resource, 'GET /test')
          assert.strictEqual(spans[0].type, 'web')
          assertObjectContains(spans[0], {
            meta: {
              'span.kind': 'server',
              'http.url': config.expectedUrl,
              'http.method': 'GET',
              'http.status_code': '200',
              component: config.expectedComponent,
              '_dd.integration': config.expectedComponent,
            },
            metrics: {
              '_dd.inferred_span': 1,
            },
          })

          assert.strictEqual(spans[0].start.toString(), config.expectedStartTime)

          assert.strictEqual(spans[0].span_id.toString(), spans[1].parent_id.toString())

          assertObjectContains(spans[1], {
            name: 'web.request',
            service: 'aws-server',
            resource: 'GET',
            meta: {
              component: 'http',
              'span.kind': 'server',
              'http.url': `http://127.0.0.1:${port}/`,
              'http.method': 'GET',
              'http.status_code': '200',
            },
          })
        })
      })

    it('should create a parent span with aws.httpapi for API Gateway v2', async () => {
      await loadTest({})

      await httpClient.get(`http://127.0.0.1:${port}/`, {
        headers: inferredHeadersV2,
      })

      await agent.assertSomeTraces(traces => {
        const spans = traces[0]

        assert.strictEqual(spans.length, 2)

        assert.strictEqual(spans[0].name, 'aws.httpapi')
        assert.strictEqual(spans[0].service, 'example.com')
        assert.strictEqual(spans[0].resource, 'GET /test')
        assert.strictEqual(spans[0].type, 'web')
        assertObjectContains(spans[0], {
          meta: {
            'span.kind': 'server',
            'http.url': 'https://example.com/test',
            'http.method': 'GET',
            'http.status_code': '200',
            component: 'aws-httpapi',
            '_dd.integration': 'aws-httpapi',
          },
          metrics: {
            '_dd.inferred_span': 1,
          },
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
            'http.status_code': '200',
          },
        })
      })
    })

      it('should include http.route when x-dd-proxy-resource-path header is present', async () => {
      await loadTest({})

      await httpClient.get(`http://127.0.0.1:${port}/`, {
        headers: inferredHeadersWithRoute,
      })

      await agent.assertSomeTraces(traces => {
        const spans = traces[0]

        assert.strictEqual(spans.length, 2)

        assert.strictEqual(spans[0].name, 'aws.apigateway')
        assert.strictEqual(spans[0].service, 'example.com')
        assert.strictEqual(spans[0].resource, 'GET /users/{id}')
        assert.strictEqual(spans[0].type, 'web')
        assertObjectContains(spans[0], {
          meta: {
            'span.kind': 'server',
            'http.url': 'https://example.com/users/123',
            'http.method': 'GET',
            'http.route': '/users/{id}',
            'http.status_code': '200',
            component: 'aws-apigateway',
          },
          metrics: {
            '_dd.inferred_span': 1,
          },
        })
      })
    })

    it('should include optional tags when corresponding headers are present', async () => {
      await loadTest({})

      await httpClient.get(`http://127.0.0.1:${port}/`, {
        headers: inferredHeadersWithOptionalTags,
      })

      await agent.assertSomeTraces(traces => {
        const spans = traces[0]

        assert.strictEqual(spans.length, 2)
        assert.strictEqual(spans[0].name, 'aws.apigateway')

        assertObjectContains(spans[0], {
          meta: {
            account_id: '123456789012',
            apiid: 'abc123def4',
            region: 'us-east-1',
            aws_user: 'arn:aws:iam::123456789012:user/testuser',
            dd_resource_key: 'arn:aws:apigateway:us-east-1::/restapis/abc123def4',
          },
        })
      })
    })

    it('should create a parent span and a child span for an error', async () => {
      await loadTest({})

        await httpClient.get(`http://127.0.0.1:${port}/error`, {
          headers: config.headers,
          validateStatus: function (status) {
            return status === 500
          },
        })

        await agent.assertSomeTraces(traces => {
          const spans = traces[0]
          assert.strictEqual(spans.length, 2)

          assertObjectContains(spans[0], {
            name: config.expectedSpanName,
            service: config.expectedService,
            resource: 'GET /test',
            type: 'web',
            meta: {
              'span.kind': 'server',
              'http.url': config.expectedUrl,
              'http.method': 'GET',
              'http.status_code': '500',
              component: config.expectedComponent,
            },
          })

          assert.strictEqual(spans[0].error, 1)
          assert.strictEqual(spans[0].start.toString(), config.expectedStartTime)
          assert.strictEqual(spans[0].span_id.toString(), spans[1].parent_id.toString())

          assertObjectContains(spans[1], {
            name: 'web.request',
            service: 'aws-server',
            resource: 'GET',
            meta: {
              component: 'http',
              'span.kind': 'server',
              'http.url': `http://127.0.0.1:${port}/error`,
              'http.method': 'GET',
              'http.status_code': '500',
            },
          })

          assert.strictEqual(spans[1].error, 1)
        })
      })

      it('should not create a proxy span if all necessary headers are missing', async () => {
        await loadTest({})

        await httpClient.get(`http://127.0.0.1:${port}/no-proxy-headers`, {
          headers: {},
        })

        await agent.assertSomeTraces(traces => {
          const spans = traces[0]
          assert.strictEqual(spans.length, 1)

          assertObjectContains(spans[0], {
            name: 'web.request',
            service: 'aws-server',
            resource: 'GET',
            meta: {
              component: 'http',
              'span.kind': 'server',
              'http.url': `http://127.0.0.1:${port}/no-proxy-headers`,
              'http.method': 'GET',
              'http.status_code': '200',
            },
          })

          assert.strictEqual(spans[0].error, 0)
        })
      })

      it('should not create a proxy span if missing the proxy system header', async () => {
        await loadTest({})

        // remove x-dd-proxy from headers
        const { 'x-dd-proxy': _, ...newHeaders } = config.headers

        await httpClient.get(`http://127.0.0.1:${port}/a-few-proxy-headers`, {
          headers: newHeaders,
        })

        await agent.assertSomeTraces(traces => {
          const spans = traces[0]
          assert.strictEqual(spans.length, 1)

          assertObjectContains(spans[0], {
            name: 'web.request',
            service: 'aws-server',
            resource: 'GET',
            meta: {
              component: 'http',
              'span.kind': 'server',
              'http.url': `http://127.0.0.1:${port}/a-few-proxy-headers`,
              'http.method': 'GET',
              'http.status_code': '200',
            },
          })

          assert.strictEqual(spans[0].error, 0)
        })
      })
    })

    describe('with configuration', function () {
      it('should not create a span when configured to be off', async () => {
        await loadTest({ inferredProxyServicesEnabled: false })

        await httpClient.get(`http://127.0.0.1:${port}/configured-off`, {
          headers: config.headers,
        })

        await agent.assertSomeTraces(traces => {
          const spans = traces[0]

          assert.strictEqual(spans.length, 1)

          assertObjectContains(spans[0], {
            name: 'web.request',
            service: 'aws-server',
            resource: 'GET',
            meta: {
              component: 'http',
              'span.kind': 'server',
              'http.url': `http://127.0.0.1:${port}/configured-off`,
              'http.method': 'GET',
              'http.status_code': '200',
            },
          })
        })
      })
    })
  })
})
