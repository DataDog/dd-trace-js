'use strict'

const assert = require('node:assert/strict')
const path = require('path')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const { sandboxCwd, useSandbox, FakeAgent, spawnProc } = require('../helpers')
const { assertObjectContains } = require('../helpers')
const startApiMock = require('./api-mock')
const { executeRequest } = require('./util')

describe('AIGuard SDK integration tests', () => {
  let cwd, appFile, agent, proc, api, url

  useSandbox(['express', 'ai'])

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
        DD_AI_GUARD_ENDPOINT: `http://localhost:${api.address().port}`,
        DD_API_KEY: 'DD_API_KEY',
        DD_APP_KEY: 'DD_APP_KEY',
      },
    })
    url = `${proc.url}`
  })

  afterEach(async () => {
    proc.kill()
    await agent.stop()
  })

  const testSuite = [
    { endpoint: '/allow', action: 'ALLOW', reason: 'The prompt looks harmless' },
    { endpoint: '/deny', action: 'DENY', reason: 'I am feeling suspicious today' },
    { endpoint: '/abort', action: 'ABORT', reason: 'The user is trying to destroy me' },
  ].flatMap(r => [
    { ...r, blocking: true },
    { ...r, blocking: false },
  ])

  for (const { endpoint, action, reason, blocking } of testSuite) {
    it(`test evaluate with ${action} response (blocking ${blocking})`, async () => {
      const headers = blocking ? { 'x-blocking-enabled': true } : null
      const response = await executeRequest(`${url}${endpoint}`, 'GET', headers)
      if (blocking && action !== 'ALLOW') {
        assert.strictEqual(response.status, 403)
        assertObjectContains(response.body, reason)
      } else {
        assert.strictEqual(response.status, 200)
        assert.strictEqual(response.body?.action, action)
        assert.strictEqual(response.body?.reason, reason)
      }
      await agent.assertMessageReceived(({ headers, payload }) => {
        const span = payload[0].find(span => span.name === 'ai_guard')
        assert.notStrictEqual(span, null)
      })
    })
  }
})

describe('AIGuardMiddleware integration tests', () => {
  let cwd, appFile, agent, proc, api, url

  useSandbox(['express', 'ai'])

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
        DD_SERVICE: 'aiguard_middleware_test',
        DD_ENV: 'test',
        DD_TRACING_ENABLED: 'true',
        DD_TRACE_AGENT_PORT: agent.port,
        DD_AI_GUARD_ENABLED: 'true',
        DD_AI_GUARD_ENDPOINT: `http://localhost:${api.address().port}`,
        DD_API_KEY: 'DD_API_KEY',
        DD_APP_KEY: 'DD_APP_KEY'
      }
    })
    url = `${proc.url}`
  })

  afterEach(async () => {
    proc.kill()
    await agent.stop()
  })

  it('should allow prompt through generateText with AIGuardMiddleware', async () => {
    const response = await executeRequest(`${url}/middleware/prompt/allow`, 'GET')
    assert.strictEqual(response.status, 200)
    assert.ok(response.body.text.includes('Mock response'))
  })

  it('should terminate stream when tool-call is blocked', async () => {
    const response = await executeRequest(`${url}/middleware/stream/tool-deny`, 'GET')
    assert.strictEqual(response.status, 403)
  })
})
