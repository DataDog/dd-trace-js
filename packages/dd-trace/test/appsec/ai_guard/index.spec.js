'use strict'

const msgpack = require('@msgpack/msgpack')
const { rejects } = require('node:assert/strict')
const { expect } = require('chai')
const { describe, it } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')
const agent = require('../../plugins/agent')
const NoopAIGuard = require('../../../src/appsec/ai_guard/noop')

describe('AIGuard SDK', () => {
  const config = {
    service: 'ai_guard_demo',
    env: 'test',
    apiKey: 'API_KEY',
    appKey: 'APP_KEY',
    protocolVersion: '0.4',
    aiguard: {
      enabled: true,
      endpoint: 'https://aiguard.com'
    }
  }
  let tracer
  let aiGuard
  let executeRequest

  const toolCall = [
    { role: 'system', content: 'You are a beautiful AI assistant' },
    { role: 'user', content: 'What is 2 + 2' },
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_1',
          function: {
            name: 'calc',
            arguments: '{ operator: "+", args: [2, 2] }'
          }
        },
      ],
    }
  ]

  const prompt = [
    ...toolCall,
    { role: 'tool', tool_call_id: 'call_1', content: '5' },
    { role: 'assistant', content: '2 + 2 is 5' },
    { role: 'user', content: 'Are you sure?' },
  ]

  beforeEach(() => {
    tracer = require('../../../../dd-trace')
    tracer.init(config)

    executeRequest = sinon.stub()
    const AIGuard = proxyquire('../../../src/appsec/ai_guard/sdk', {
      './client': executeRequest
    })
    aiGuard = new AIGuard(tracer, config)

    return agent.load(null, [])
  })

  afterEach(() => {
    agent.close()
  })

  const mockExecuteRequest = (options) => {
    executeRequest.resolves({
      status: options.status ?? 200,
      body: options.body
    })
  }

  const assertExecuteRequest = (messages) => {
    sinon.assert.calledOnceWithExactly(executeRequest,
      `${config.aiguard.endpoint}/evaluate`,
      { 'DD-API-KEY': 'API_KEY', 'DD-APPLICATION-KEY': 'APP_KEY' },
      { data: { attributes: { messages, meta: { service: 'ai_guard_demo', env: 'test' } } } }
    )
  }

  const assertAIGuardSpan = async (meta, metaStruct = null) => {
    await agent.assertFirstTraceSpan(span => {
      expect(span.name).to.equal('ai_guard')
      expect(span.resource).to.equal('ai_guard')
      expect(span.meta).to.deep.include(meta)
      if (metaStruct) {
        expect(msgpack.decode(span.meta_struct.ai_guard)).to.deep.equal(metaStruct)
      }
    }, { rejectFirst: true })
  }

  const testSuite = [
    { action: 'ALLOW', reason: 'Go ahead' },
    { action: 'DENY', reason: 'Nope' },
    { action: 'ABORT', reason: 'Kill it with fire' }
  ].flatMap(r => [
    { ...r, blocking: true },
    { ...r, blocking: false },
  ])

  for (const { action, reason, blocking } of testSuite) {
    it(`test evaluate prompt with ${action} action (blocking: ${blocking})`, async () => {
      // given
      mockExecuteRequest({ body: { data: { attributes: { action, reason, is_blocking_enabled: blocking } } } })
      const shouldBlock = action !== 'ALLOW' && blocking

      // when
      if (shouldBlock) {
        await rejects(
          () => aiGuard.evaluate(prompt, { block: blocking }),
          err => err.name === 'AIGuardAbortError' && err.reason === reason
        )
      } else {
        const evaluation = await aiGuard.evaluate(prompt, { block: blocking })
        expect(evaluation.action).to.equal(action)
        expect(evaluation.reason).to.equal(reason)
      }

      // then
      assertExecuteRequest(prompt)
      await assertAIGuardSpan({
        'ai_guard.target': 'prompt',
        'ai_guard.action': action,
        'ai_guard.reason': reason,
        ...(shouldBlock ? { 'ai_guard.blocked': 'true', 'error.type': 'AIGuardAbortError' } : {})
      },
      { messages: prompt })
    })

    it(`test evaluate tool call with ${action} action (blocking: ${blocking})`, async () => {
      // given
      mockExecuteRequest({ body: { data: { attributes: { action, reason, is_blocking_enabled: blocking } } } })
      const shouldBlock = action !== 'ALLOW' && blocking

      // when
      if (shouldBlock) {
        await rejects(
          () => aiGuard.evaluate(toolCall, { block: true }),
          err => err.name === 'AIGuardAbortError' && err.reason === reason
        )
      } else {
        const evaluation = await aiGuard.evaluate(toolCall, { block: true })
        expect(evaluation.action).to.equal(action)
        expect(evaluation.reason).to.equal(reason)
      }

      // then
      assertExecuteRequest(toolCall)
      await assertAIGuardSpan({
        'ai_guard.target': 'tool',
        'ai_guard.tool_name': 'calc',
        'ai_guard.action': action,
        'ai_guard.reason': reason,
        ...(shouldBlock ? { 'ai_guard.blocked': 'true', 'error.type': 'AIGuardAbortError' } : {})
      },
      { messages: toolCall })
    })
  }

  it('test evaluate with API error', async () => {
    mockExecuteRequest({
      status: 400,
      body: { errors: [{ status: 400, title: 'Internal server error' }] }
    })

    await rejects(
      () => aiGuard.evaluate(toolCall),
      err => err.name === 'AIGuardClientError' && err.errors?.length > 0
    )
    assertExecuteRequest(toolCall)
    await assertAIGuardSpan({
      'ai_guard.target': 'tool',
      'error.type': 'AIGuardClientError'
    })
  })

  it('test evaluate with invalid JSON', async () => {
    mockExecuteRequest({ body: { message: 'This is an invalid JSON' } })

    await rejects(
      () => aiGuard.evaluate(toolCall),
      err => err.name === 'AIGuardClientError'
    )
    assertExecuteRequest(toolCall)
    await assertAIGuardSpan({
      'ai_guard.target': 'tool',
      'error.type': 'AIGuardClientError'
    })
  })

  it('test noop implementation', () => {
    const noop = new NoopAIGuard()
    const evaluation = noop.evaluate(prompt)
    expect(evaluation.action).to.equal('ALLOW')
    expect(evaluation.reason).to.equal('AI Guard is not enabled')
  })
})
