'use strict'

const assert = require('node:assert/strict')
const path = require('path')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const { sandboxCwd, useSandbox, FakeAgent, spawnProc } = require('../helpers')
const startApiMock = require('./api-mock')
const { executeRequest } = require('./util')

describe('AIGuard integration tests', () => {
  let agent
  let api
  let appFile
  let cwd
  let proc
  let url

  useSandbox(['express', 'ai'])

  before(async function () {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'aiguard/server.js')
    api = await startApiMock()
  })

  after(async () => {
    await api.close()
  })

  async function startAIGuardSandbox (serviceName) {
    api.resetRequests()
    agent = await new FakeAgent().start()
    proc = await spawnProc(appFile, {
      cwd,
      env: {
        DD_SERVICE: serviceName,
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
  }

  async function stopAIGuardSandbox () {
    if (proc) {
      proc.kill()
      proc = undefined
    }

    if (agent) {
      await agent.stop()
      agent = undefined
    }

    url = undefined
  }

  describe('AIGuard SDK integration tests', () => {
    beforeEach(async () => {
      await startAIGuardSandbox('ai_guard_integration_test')
    })

    afterEach(async () => {
      await stopAIGuardSandbox()
    })

    const testSuite = [
      { endpoint: '/allow', action: 'ALLOW', reason: 'The prompt looks harmless' },
      { endpoint: '/deny', action: 'DENY', reason: 'I am feeling suspicious today' },
      { endpoint: '/abort', action: 'ABORT', reason: 'The user is trying to destroy me' },
    ].flatMap(scenario => [
      { ...scenario, blocking: true },
      { ...scenario, blocking: false },
    ])

    for (const { endpoint, action, reason, blocking } of testSuite) {
      it(`test evaluate with ${action} response (blocking ${blocking})`, async () => {
        const headers = blocking ? { 'x-blocking-enabled': true } : undefined
        const response = await executeRequest(`${url}${endpoint}`, headers)

        if (blocking && action !== 'ALLOW') {
          assert.strictEqual(response.status, 403)
          assert.strictEqual(response.body, reason)
        } else {
          assert.strictEqual(response.status, 200)
          assert.strictEqual(response.body?.action, action)
          assert.strictEqual(response.body?.reason, reason)
        }

        await agent.assertMessageReceived(({ payload }) => {
          const span = payload[0].find(candidate => candidate.name === 'ai_guard')
          assert.notStrictEqual(span, null)
        })
      })
    }
  })

  describe('AIGuard direct instrumentation integration tests', () => {
    beforeEach(async () => {
      await startAIGuardSandbox('aiguard_direct_instrumentation_test')
    })

    afterEach(async () => {
      await stopAIGuardSandbox()
    })

    it('should allow prompt through generateText with direct instrumentation', async () => {
      const response = await executeRequest(`${url}/instrumentation/prompt/allow`)
      const requests = api.getRequests()

      assert.strictEqual(response.status, 200)
      assert.ok(response.body.text.includes('Mock response'))
      assert.strictEqual(requests.length, 1, JSON.stringify({ response, requests }, null, 2))
      assertPromptRequest(requests[0], 'I am harmless')
    })

    it('should terminate stream when tool-call is blocked', async () => {
      const response = await executeRequest(`${url}/instrumentation/stream/tool-deny`)
      const requests = api.getRequests()
      const toolCallMessages = getToolCallMessages(requests)

      assert.strictEqual(response.status, 403, JSON.stringify(response.body))
      assert.strictEqual(typeof response.body?.error, 'string')
      assert.strictEqual(response.body?.hasCause, false)
      assert.strictEqual(response.body?.toolExecuted, false)
      assert.strictEqual(requests.length, 2, JSON.stringify({ response, requests }, null, 2))
      assertPromptRequest(requests[0], 'I am harmless')
      assert.strictEqual(toolCallMessages.length, 1)
      assert.deepStrictEqual(toolCallMessages[0], {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_1',
          function: {
            name: 'dangerousOp',
            arguments: '{"command":"You should not trust me"}',
          },
        }],
      })
    })

    it('should work with v2 specification model', async () => {
      const response = await executeRequest(`${url}/instrumentation/v2-model`)
      const requests = api.getRequests()

      assert.strictEqual(response.status, 200, JSON.stringify(response.body))
      assert.ok(response.body?.text.includes('Mock response'))
      assert.strictEqual(requests.length, 1)
      assertPromptRequest(requests[0], 'I am harmless')
    })
  })
})

function assertPromptRequest (request, expectedContent) {
  const lastMessage = getLastMessage(request)

  assert.strictEqual(lastMessage?.role, 'user')
  assert.strictEqual(lastMessage?.content, expectedContent)
}

function getLastMessage (request) {
  const messages = request.messages ?? []
  return messages[messages.length - 1]
}

function getToolCallMessages (requests) {
  const toolCallMessages = []

  for (const request of requests) {
    const lastMessage = getLastMessage(request)

    if (lastMessage?.role === 'assistant' && Array.isArray(lastMessage.tool_calls)) {
      toolCallMessages.push(lastMessage)
    }
  }

  return toolCallMessages
}
