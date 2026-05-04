'use strict'

const assert = require('node:assert/strict')
const path = require('path')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const { sandboxCwd, useSandbox, FakeAgent, spawnProc, stopProc } = require('../helpers')
const { assertObjectContains } = require('../helpers')
const startApiMock = require('./api-mock')
const { executeRequest } = require('./util')

function assertHasGuardSpan (payload, predicate) {
  const spans = payload[0].filter(span => span.name === 'ai_guard')
  assert.ok(spans.length > 0)
  const matching = spans.find(predicate)
  assert.notStrictEqual(matching, undefined)
}

function findMetric (series, metricName) {
  return series.find(s => s.metric === metricName)
}

function assertHasTags (metric, expectedTags) {
  for (const tag of expectedTags) {
    assert.ok(metric.tags.includes(tag), `Expected tag "${tag}" in [${metric.tags}]`)
  }
}

describe('AIGuard SDK integration tests', () => {
  let cwd, appFile, agent, proc, api, url

  useSandbox(['express', 'ai@6.0.39'])

  before(async function () {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'aiguard/server.js')
    api = await startApiMock()
  })

  after(async () => {
    await api.close()
  })

  const baseEnv = () => ({
    DD_SERVICE: 'ai_guard_integration_test',
    DD_ENV: 'test',
    DD_TRACE_ENABLED: 'true',
    DD_TRACE_CLIENT_IP_ENABLED: 'false',
    DD_TRACE_AGENT_PORT: String(agent.port),
    DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
    DD_AI_GUARD_ENABLED: 'true',
    DD_AI_GUARD_BLOCK: 'true',
    DD_AI_GUARD_ENDPOINT: `http://localhost:${api.address().port}`,
    DD_API_KEY: 'DD_API_KEY',
    DD_APP_KEY: 'DD_APP_KEY',
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
    proc = await spawnProc(appFile, {
      cwd,
      env: baseEnv(),
    })
    url = `${proc.url}`
  })

  afterEach(async () => {
    await stopProc(proc)
    await agent.stop()
  })

  it('test default options honors remote blocking', async () => {
    const response = await executeRequest(`${url}/deny-default-options`, 'GET')
    assert.strictEqual(response.status, 403)
    assertObjectContains(response.body, 'I am feeling suspicious today')

    await agent.assertMessageReceived(({ payload }) => {
      const span = payload[0].find(span => span.name === 'ai_guard')
      assert.notStrictEqual(span, undefined)
      assert.strictEqual(span.meta['ai_guard.action'], 'DENY')
      assert.strictEqual(span.meta['ai_guard.blocked'], 'true')
    })
  })

  it('adds client ip tags to the request root span when AI Guard runs', async () => {
    const response = await executeRequest(`${url}/allow`, 'GET', {
      'x-forwarded-for': '203.0.113.10, 10.0.0.1',
    })

    assert.strictEqual(response.status, 200)

    await agent.assertMessageReceived(({ payload }) => {
      const requestSpan = payload[0].find(span => span.name === 'express.request')
      const guardSpan = payload[0].find(span => span.name === 'ai_guard')

      assert.notStrictEqual(requestSpan, undefined)
      assert.notStrictEqual(guardSpan, undefined)
      assert.strictEqual(requestSpan.meta['http.client_ip'], '203.0.113.10')
      assert.ok(requestSpan.meta['network.client.ip'])
    })
  })

  it('does not add client ip tags when no AI Guard span is created', async () => {
    const response = await executeRequest(`${url}/no-aiguard`, 'GET', {
      'x-forwarded-for': '203.0.113.10, 10.0.0.1',
    })

    assert.strictEqual(response.status, 200)
    assert.deepStrictEqual(response.body, { ok: true })

    await agent.assertMessageReceived(({ payload }) => {
      const requestSpan = payload[0].find(span => span.name === 'express.request')
      const guardSpan = payload[0].find(span => span.name === 'ai_guard')

      assert.notStrictEqual(requestSpan, undefined)
      assert.strictEqual(guardSpan, undefined)
      assert.strictEqual(requestSpan.meta['http.client_ip'], undefined)
      assert.strictEqual(requestSpan.meta['network.client.ip'], undefined)
    })
  })

  const directApiSuite = [
    { endpoint: '/allow', action: 'ALLOW', reason: 'The prompt looks harmless' },
    { endpoint: '/deny', action: 'DENY', reason: 'I am feeling suspicious today' },
    { endpoint: '/abort', action: 'ABORT', reason: 'The user is trying to destroy me' },
  ].flatMap(r => [
    { ...r, blocking: true },
    { ...r, blocking: false },
  ])

  for (const { endpoint, action, reason, blocking } of directApiSuite) {
    it(`test evaluate with ${action} response (blocking: ${blocking})`, async () => {
      const headers = blocking ? { 'x-blocking-enabled': 'true' } : null
      const response = await executeRequest(`${url}${endpoint}`, 'GET', headers)

      if (blocking && action !== 'ALLOW') {
        assert.strictEqual(response.status, 403)
        assertObjectContains(response.body, reason)
      } else {
        assert.strictEqual(response.status, 200)
        assert.strictEqual(response.body?.action, action)
        assert.strictEqual(response.body?.reason, reason)
      }

      await agent.assertMessageReceived(({ payload }) => {
        const span = payload[0].find(span => span.name === 'ai_guard')
        assert.notStrictEqual(span, undefined)
        assert.strictEqual(span.meta['ai_guard.action'], action)
      })
    })
  }

  const autoSuite = [
    {
      mode: 'point1',
      target: 'prompt',
      description: 'blocks malicious user input before LLM call',
    },
    {
      mode: 'point2',
      target: 'prompt',
      description: 'blocks assistant text response with sensitive data',
    },
    {
      mode: 'point3',
      target: 'tool',
      description: 'blocks dangerous tool calls before execution',
    },
    {
      mode: 'point4',
      target: 'tool',
      description: 'blocks malicious tool output before LLM sees it',
    },
  ]

  for (const { mode, target, description } of autoSuite) {
    it(`allows safe messages (${description})`, async () => {
      const response = await executeRequest(`${url}/auto?mode=${mode}&deny=false`)
      assert.strictEqual(response.status, 200)
      assert.deepStrictEqual(response.body, { blocked: false })

      await agent.assertMessageReceived(({ payload }) => {
        assertHasGuardSpan(payload, span =>
          span.meta['ai_guard.target'] === target &&
          span.meta['ai_guard.action'] === 'ALLOW'
        )
      })
    })

    it(`blocks dangerous messages (${description})`, async () => {
      const response = await executeRequest(`${url}/auto?mode=${mode}&deny=true`)
      assert.strictEqual(response.status, 403)
      assert.deepStrictEqual(JSON.parse(response.body), { blocked: true, reason: 'Blocked by policy' })

      await agent.assertMessageReceived(({ payload }) => {
        assertHasGuardSpan(payload, span =>
          span.meta['ai_guard.target'] === target &&
          span.meta['ai_guard.action'] === 'DENY' &&
          span.meta['ai_guard.blocked'] === 'true'
        )
      })
    })
  }

  describe('telemetry metrics', () => {
    it('reports requests metric with sdk source on direct SDK call', async () => {
      let telemetryReceived = false

      await executeRequest(`${url}/allow`, 'GET')

      const checkTelemetry = agent.assertTelemetryReceived({
        fn: ({ payload }) => {
          const series = payload.payload.series
          const requests = findMetric(series, 'requests')

          assert.ok(requests)
          telemetryReceived = true
          assert.strictEqual(requests.type, 'count')
          assertHasTags(requests, ['source:sdk', 'integration:none', 'action:allow', 'error:false'])
        },
        requestType: 'generate-metrics',
        timeout: 30_000,
        resolveAtFirstSuccess: true,
        namespace: 'ai_guard',
      })

      await checkTelemetry
      assert.ok(telemetryReceived, 'Expected ai_guard telemetry metrics to be received')
    })

    it('reports requests metric with auto source on auto-instrumented call', async () => {
      let telemetryReceived = false

      await executeRequest(`${url}/auto?mode=point1&deny=false`)

      const checkTelemetry = agent.assertTelemetryReceived({
        fn: ({ payload }) => {
          const series = payload.payload.series
          const requests = findMetric(series, 'requests')

          assert.ok(requests)
          telemetryReceived = true
          assert.strictEqual(requests.type, 'count')
          assertHasTags(requests, ['source:auto', 'integration:ai', 'action:allow', 'error:false'])
        },
        requestType: 'generate-metrics',
        timeout: 30_000,
        resolveAtFirstSuccess: true,
        namespace: 'ai_guard',
      })

      await checkTelemetry
      assert.ok(telemetryReceived, 'Expected ai_guard telemetry metrics to be received')
    })

    it('reports requests metric with block tag on blocked evaluation', async () => {
      let telemetryReceived = false

      await executeRequest(`${url}/deny`, 'GET', { 'x-blocking-enabled': 'true' })

      const checkTelemetry = agent.assertTelemetryReceived({
        fn: ({ payload }) => {
          const series = payload.payload.series
          const requests = findMetric(series, 'requests')

          assert.ok(requests)
          telemetryReceived = true
          assert.strictEqual(requests.type, 'count')
          assertHasTags(requests, ['source:sdk', 'integration:none', 'action:deny', 'error:false', 'block:true'])
        },
        requestType: 'generate-metrics',
        timeout: 30_000,
        resolveAtFirstSuccess: true,
        namespace: 'ai_guard',
      })

      await checkTelemetry
      assert.ok(telemetryReceived, 'Expected ai_guard telemetry metrics to be received')
    })

    it('reports error metric on API failure', async () => {
      const agent2 = await new FakeAgent().start()
      const proc2 = await spawnProc(appFile, {
        cwd,
        env: {
          ...baseEnv(),
          DD_TRACE_AGENT_PORT: String(agent2.port),
          DD_AI_GUARD_ENDPOINT: 'http://localhost:1',
          DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
        },
      })

      try {
        let telemetryReceived = false

        // This will fail because the endpoint is unreachable
        await executeRequest(`${proc2.url}/allow`, 'GET').catch(() => {})

        const checkTelemetry = agent2.assertTelemetryReceived({
          fn: ({ payload }) => {
            const series = payload.payload.series
            const errorMetric = findMetric(series, 'error')

            assert.ok(errorMetric)
            telemetryReceived = true
            assert.strictEqual(errorMetric.type, 'count')
            assertHasTags(errorMetric, ['type:client_error', 'source:sdk', 'integration:none'])

            const requests = findMetric(series, 'requests')
            assert.ok(requests)
            assertHasTags(requests, ['error:true', 'source:sdk', 'integration:none'])
          },
          requestType: 'generate-metrics',
          timeout: 30_000,
          resolveAtFirstSuccess: true,
          namespace: 'ai_guard',
        })

        await checkTelemetry
        assert.ok(telemetryReceived, 'Expected ai_guard error telemetry to be received')
      } finally {
        await stopProc(proc2)
        await agent2.stop()
      }
    })
  })
})
