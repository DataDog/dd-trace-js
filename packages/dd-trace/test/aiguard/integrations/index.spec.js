'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const chatCompletionsInterceptChannel = channel('dd-trace:openai:chat.completions:intercept')

describe('AIGuard integration wiring', () => {
  const config = {
    aiguard: {
      DD_AI_GUARD_ANALYZE_STREAM_RESPONSES_ENABLED: true,
      DD_AI_GUARD_BLOCK: true,
    },
  }
  let AIGuard
  let evaluate
  let aiguard

  beforeEach(() => {
    evaluate = sinon.stub().resolves()
    AIGuard = sinon.stub().returns({ evaluate })

    aiguard = proxyquire('../../../src/aiguard/index', {
      '../log': { error: sinon.stub() },
      './sdk': AIGuard,
    })
  })

  afterEach(() => {
    aiguard.disable()
    sinon.restore()
  })

  function publishChatIntercept () {
    const ctx = { arguments: [{ messages: [{ role: 'user', content: 'Hello' }] }], stream: false }
    chatCompletionsInterceptChannel.publish(ctx)
    return { ctx, intercepted: typeof ctx.beforeResult === 'function' }
  }

  it('subscribes, unsubscribes, and resubscribes AI Guard integrations', async () => {
    aiguard.enable({}, config)

    const enabled = publishChatIntercept()
    assert.strictEqual(enabled.intercepted, true)
    await enabled.ctx.beforeResult()
    sinon.assert.calledOnce(evaluate)

    aiguard.disable()

    assert.strictEqual(publishChatIntercept().intercepted, false)

    aiguard.enable({}, config)

    const reenabled = publishChatIntercept()
    assert.strictEqual(reenabled.intercepted, true)
    await reenabled.ctx.beforeResult()
    sinon.assert.calledTwice(AIGuard)
    sinon.assert.calledTwice(evaluate)
  })

  function stubIntegrations () {
    const stubs = {
      anthropic: { enable: sinon.stub(), disable: sinon.stub() },
      mcp: { enable: sinon.stub(), disable: sinon.stub() },
      openai: { enable: sinon.stub(), disable: sinon.stub() },
      vercelAi: { enable: sinon.stub(), disable: sinon.stub() },
    }
    const integrations = proxyquire('../../../src/aiguard/integrations', {
      './anthropic': stubs.anthropic,
      './mcp': stubs.mcp,
      './openai': stubs.openai,
      './vercel-ai': stubs.vercelAi,
    })
    return { integrations, ...stubs }
  }

  it('enables and disables providers through the integrations index', () => {
    const { integrations, anthropic, mcp, openai, vercelAi } = stubIntegrations()
    const aiguard = { evaluate }

    integrations.enable(aiguard, true, true, true)
    integrations.disable()

    sinon.assert.calledOnceWithExactly(anthropic.enable, aiguard, true, true)
    sinon.assert.calledOnceWithExactly(openai.enable, aiguard, true, true, true)
    sinon.assert.calledOnceWithExactly(vercelAi.enable, aiguard, true, true)
    sinon.assert.calledOnceWithExactly(mcp.enable, aiguard, true)
    sinon.assert.calledOnce(anthropic.disable)
    sinon.assert.calledOnce(openai.disable)
    sinon.assert.calledOnce(vercelAi.disable)
    sinon.assert.calledOnce(mcp.disable)
    sinon.assert.callOrder(
      anthropic.enable,
      openai.enable,
      vercelAi.enable,
      mcp.enable,
      mcp.disable,
      vercelAi.disable,
      openai.disable,
      anthropic.disable,
    )
  })

  it('does not enable the MCP checks when the MCP kill switch is off', () => {
    const { integrations, mcp, openai } = stubIntegrations()
    const aiguard = { evaluate }

    integrations.enable(aiguard, true, true, false)

    sinon.assert.notCalled(mcp.enable)
    sinon.assert.calledOnceWithExactly(openai.enable, aiguard, true, true, false)
  })

  for (const [value, expected] of [[undefined, true], [true, true], [false, false]]) {
    it(`passes the MCP kill switch ${value} to the integrations as ${expected}`, () => {
      const integrations = { enable: sinon.stub(), disable: sinon.stub() }
      const wiring = proxyquire('../../../src/aiguard/index', {
        '../log': { error: sinon.stub() },
        './integrations': integrations,
        './sdk': AIGuard,
      })

      wiring.enable({}, { aiguard: { ...config.aiguard, DD_AI_GUARD_MCP_ENABLED: value } })
      wiring.disable()

      sinon.assert.calledOnceWithExactly(integrations.enable, sinon.match.object, true, true, expected)
    })
  }

  describe('with the MCP kill switch off', () => {
    const callToolInterceptChannel = channel('dd-trace:mcp:callTool:intercept')
    const listToolsResultChannel = channel('dd-trace:mcp:listTools:result')

    it('subscribes to no MCP channel', () => {
      aiguard.enable({}, { aiguard: { ...config.aiguard, DD_AI_GUARD_MCP_ENABLED: false } })

      assert.strictEqual(callToolInterceptChannel.hasSubscribers, false)
      assert.strictEqual(listToolsResultChannel.hasSubscribers, false)
      assert.strictEqual(publishChatIntercept().intercepted, true)
    })

    it('subscribes to the MCP channels when it is on', () => {
      aiguard.enable({}, { aiguard: { ...config.aiguard, DD_AI_GUARD_MCP_ENABLED: true } })

      assert.strictEqual(callToolInterceptChannel.hasSubscribers, true)
      assert.strictEqual(listToolsResultChannel.hasSubscribers, true)

      aiguard.disable()

      assert.strictEqual(callToolInterceptChannel.hasSubscribers, false)
      assert.strictEqual(listToolsResultChannel.hasSubscribers, false)
    })
  })
})
