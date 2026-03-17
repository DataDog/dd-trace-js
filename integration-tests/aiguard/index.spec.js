'use strict'

const assert = require('node:assert/strict')
const path = require('path')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const { sandboxCwd, useSandbox, FakeAgent, spawnProc, stopProc } = require('../helpers')
const { assertObjectContains } = require('../helpers')
const startApiMock = require('./api-mock')
const { executeRequest } = require('./util')

describe('AIGuard SDK integration tests', () => {
  let cwd, appFile, agent, proc, api, url

  useSandbox(['express'])

  before(async function () {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'aiguard/server.js')
    api = await startApiMock()
  })

  after(async () => {
    await api.close()
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
    proc = await spawnProc(appFile, {
      cwd,
      env: {
        DD_SERVICE: 'ai_guard_integration_test',
        DD_ENV: 'test',
        DD_TRACING_ENABLED: 'true',
        DD_TRACE_AGENT_PORT: agent.port,
        DD_AI_GUARD_ENABLED: 'true',
        DD_AI_GUARD_BLOCK: 'true',
        DD_AI_GUARD_ENDPOINT: `http://localhost:${api.address().port}`,
        DD_API_KEY: 'DD_API_KEY',
        DD_APP_KEY: 'DD_APP_KEY',
      },
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
      endpoint: '/auto/point1',
      target: 'prompt',
      description: 'blocks malicious user input before LLM call',
    },
    {
      endpoint: '/auto/point2',
      target: 'prompt',
      description: 'blocks assistant text response with sensitive data',
    },
    {
      endpoint: '/auto/point3',
      target: 'tool',
      description: 'blocks dangerous tool calls before execution',
    },
    {
      endpoint: '/auto/point4',
      target: 'tool',
      description: 'blocks malicious tool output before LLM sees it',
    },
  ]

  for (const { endpoint, target, description } of autoSuite) {
    it(`allows safe messages (${description})`, async () => {
      const response = await executeRequest(`${url}${endpoint}?deny=false`)
      assert.strictEqual(response.status, 200)
      assert.deepStrictEqual(response.body, { blocked: false })

      await agent.assertMessageReceived(({ payload }) => {
        const span = payload[0].find(span => span.name === 'ai_guard')
        assert.notStrictEqual(span, undefined)
        assert.strictEqual(span.meta['ai_guard.target'], target)
        assert.strictEqual(span.meta['ai_guard.action'], 'ALLOW')
      })
    })

    it(`blocks dangerous messages (${description})`, async () => {
      const response = await executeRequest(`${url}${endpoint}?deny=true`)
      assert.strictEqual(response.status, 403)
      assert.deepStrictEqual(JSON.parse(response.body), { blocked: true, reason: 'Blocked by policy' })

      await agent.assertMessageReceived(({ payload }) => {
        const span = payload[0].find(span => span.name === 'ai_guard')
        assert.notStrictEqual(span, undefined)
        assert.strictEqual(span.meta['ai_guard.target'], target)
        assert.strictEqual(span.meta['ai_guard.action'], 'DENY')
        assert.strictEqual(span.meta['ai_guard.blocked'], 'true')
      })
    })
  }
})
