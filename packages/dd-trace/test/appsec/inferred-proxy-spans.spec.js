'use strict'

const assert = require('node:assert/strict')
const { Agent } = require('node:http')
const path = require('node:path')

const { describe, it, afterEach } = require('mocha')
const axios = require('axios')

require('../setup/core')
const agent = require('../plugins/agent')

const httpClient = axios.create({
  httpAgent: new Agent({ keepAlive: false }),
  timeout: 5000,
})

describe('Inferred Proxy Spans with AppSec', function () {
  let http
  let appListener
  let port

  const loadTest = async function ({ inferredProxyServicesEnabled = true } = {}) {
    await agent.load(
      ['http', 'dns', 'net'],
      [{ client: false }, { enabled: false }, { enabled: false }],
      {
        inferredProxyServicesEnabled,
        service: 'test-server',
        appsec: {
          enabled: true,
          rules: path.join(__dirname, './inferred-proxy-rules.json'),
        },
      }
    )

    http = require('http')

    const server = new http.Server((req, res) => {
      res.writeHead(200)
      res.end(JSON.stringify({ message: 'OK' }))
    })

    const connections = new Set()
    server.on('connection', (connection) => {
      connections.add(connection)
      connection.on('close', () => {
        connections.delete(connection)
      })
    })

    return new Promise((resolve) => {
      appListener = server.listen(0, '127.0.0.1', () => {
        port = server.address().port
        appListener._connections = connections
        resolve()
      })
    })
  }

  const cleanupTest = async function () {
    if (appListener) {
      if (appListener._connections) {
        for (const connection of appListener._connections) {
          connection.destroy()
        }
      }

      await new Promise((resolve, reject) => {
        appListener.close((err) => {
          if (err) reject(err)
          else resolve()
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
    'x-dd-proxy-stage': 'dev',
  }

  afterEach(async () => {
    await cleanupTest()
  })

  it('should add _dd.appsec.enabled to inferred proxy span', async () => {
    await loadTest()

    await httpClient.get(`http://127.0.0.1:${port}/`, {
      headers: inferredHeaders,
    })

    await agent.assertSomeTraces((traces) => {
      const spans = traces[0]

      assert.strictEqual(spans.length, 2)

      // Inferred proxy span
      assert.strictEqual(spans[0].name, 'aws.apigateway')
      assert.strictEqual(spans[0].metrics['_dd.appsec.enabled'], 1)

      // Server span
      assert.strictEqual(spans[1].name, 'web.request')
      assert.strictEqual(spans[1].metrics['_dd.appsec.enabled'], 1)
    })
  })

  it('should add _dd.appsec.json to inferred proxy span when attack is detected', async () => {
    await loadTest()

    await httpClient.get(`http://127.0.0.1:${port}/testattack`, {
      headers: inferredHeaders,
      validateStatus: () => true,
    })

    await agent.assertSomeTraces((traces) => {
      const spans = traces[0]

      assert.strictEqual(spans.length, 2)

      // Inferred proxy span
      assert.strictEqual(spans[0].name, 'aws.apigateway')
      assert.strictEqual(spans[0].metrics['_dd.appsec.enabled'], 1)
      assert.ok(spans[0].meta['_dd.appsec.json'], 'inferred proxy span should have _dd.appsec.json')
      assert.ok(
        spans[0].meta['_dd.appsec.json'].includes('test-rule-uri'),
        '_dd.appsec.json should contain the triggered rule'
      )

      // Server span
      assert.strictEqual(spans[1].name, 'web.request')
      assert.strictEqual(spans[1].metrics['_dd.appsec.enabled'], 1)
      assert.ok(spans[1].meta['_dd.appsec.json'], 'server span should have _dd.appsec.json')
    })
  })
})
