'use strict'

const assert = require('node:assert/strict')
const path = require('path')

const Axios = require('axios')
const { sandboxCwd, useSandbox, FakeAgent, spawnProc } = require('../helpers')

describe('Inferred Proxy Spans with AppSec', () => {
  let axios, cwd, appFile, agent, proc

  useSandbox()

  before(() => {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'appsec/inferred-proxy-spans/index.js')
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
    proc = await spawnProc(appFile, {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_APPSEC_ENABLED: 'true',
        DD_APPSEC_RULES: path.join(cwd, 'appsec/inferred-proxy-spans/rules.json'),
        DD_TRACE_INFERRED_PROXY_SERVICES_ENABLED: 'true',
      },
    })
    axios = Axios.create({ baseURL: proc.url })
  })

  afterEach(async () => {
    proc.kill()
    await agent.stop()
  })

  const inferredHeaders = {
    'x-dd-proxy': 'aws-apigateway',
    'x-dd-proxy-request-time-ms': '1729780025473',
    'x-dd-proxy-path': '/test',
    'x-dd-proxy-httpmethod': 'GET',
    'x-dd-proxy-domain-name': 'example.com',
    'x-dd-proxy-stage': 'dev',
  }

  it('should add _dd.appsec.enabled to inferred proxy span', async () => {
    await axios.get('/', { headers: inferredHeaders })

    await agent.assertMessageReceived(({ payload }) => {
      const spans = payload[0]

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
    await axios.get('/testattack', {
      headers: inferredHeaders,
      validateStatus: () => true,
    })

    await agent.assertMessageReceived(({ payload }) => {
      const spans = payload[0]

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
