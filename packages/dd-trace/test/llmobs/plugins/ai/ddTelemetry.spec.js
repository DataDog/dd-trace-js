'use strict'

const assert = require('node:assert/strict')
const v8 = require('node:v8')
const vm = require('node:vm')

const { setTimeout: wait } = require('node:timers/promises')
const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')

v8.setFlagsFromString('--expose-gc')
const gc = globalThis.gc ?? vm.runInNewContext('gc')
v8.setFlagsFromString('--no-expose-gc')

const DdTelemetryPlugin = require('../../../../src/llmobs/plugins/ai/ddTelemetry')

const toolCreationCh = channel('tracing:orchestrion:ai:tool:start')

describe('AI LLMObs ddTelemetry plugin', () => {
  let plugin

  beforeEach(() => {
    plugin = new DdTelemetryPlugin({}, {
      llmobs: {
        DD_LLMOBS_ENABLED: true,
      },
    })
    plugin.configure({ enabled: true })
  })

  afterEach(() => {
    plugin.configure(false)
  })

  it('attributes numeric tool names by description', () => {
    toolCreationCh.publish({
      arguments: [{ id: 'openai.web_search', description: 'search the web' }],
    })

    assert.equal(plugin.findToolName('0', 'search the web'), 'openai.web_search')
    assert.equal(plugin.findToolName('getWeather', 'anything'), 'getWeather')
    assert.equal(plugin.findToolName('0', 'unknown'), undefined)

    toolCreationCh.publish({
      arguments: [{ description: 'missing id' }],
    })
    assert.equal(plugin.findToolName('1', 'missing id'), undefined)
  })

  it('bounds the tool description registry', () => {
    for (let i = 0; i < DdTelemetryPlugin.TOOL_ID_CACHE_MAX + 10; i++) {
      toolCreationCh.publish({
        arguments: [{ id: `tool-${i}`, description: `description-${i}` }],
      })
    }

    assert.equal(
      plugin.findToolName('0', `description-${DdTelemetryPlugin.TOOL_ID_CACHE_MAX + 9}`),
      `tool-${DdTelemetryPlugin.TOOL_ID_CACHE_MAX + 9}`
    )
    assert.equal(plugin.findToolName('0', 'description-0'), undefined)
  })

  it('does not retain tool configuration objects', async function () {
    this.timeout(10000)

    const collected = new Set()
    const finalizationRegistry = new FinalizationRegistry(token => collected.add(token))
    const count = 200

    ;(() => {
      for (let i = 0; i < count; i++) {
        const payload = 'x'.repeat(100_000)
        const tool = {
          id: `tool-${i}`,
          description: `description-${i}`,
          payload,
          execute: () => payload,
        }

        finalizationRegistry.register(tool, i)
        toolCreationCh.publish({ arguments: [tool] })
      }
    })()

    for (let i = 0; i < 10 && collected.size < count; i++) {
      gc()
      await wait(100)
    }

    assert.equal(collected.size, count)
  })

  it('scopes tool registration to the plugin lifecycle', () => {
    plugin.configure(false)
    toolCreationCh.publish({
      arguments: [{ id: 'disabled.tool', description: 'disabled description' }],
    })
    assert.equal(plugin.findToolName('0', 'disabled description'), undefined)

    plugin.configure({ enabled: true })
    toolCreationCh.publish({
      arguments: [{ id: 'enabled.tool', description: 'enabled description' }],
    })
    assert.equal(plugin.findToolName('0', 'enabled description'), 'enabled.tool')
  })

  it('bounds tool-call ID attribution', () => {
    const tagger = {
      _setTag (span, name, value) {
        span.tags[name] = value
      },
      tagTextIO () {},
    }
    plugin._tagger = tagger

    const nameTag = '_ml_obs.name'
    const formatToolCall = (i) => {
      const description = `description-${i}`
      toolCreationCh.publish({
        arguments: [{ id: `tool-${i}`, description }],
      })
      plugin.formatOutputMessage(
        {
          'ai.response.toolCalls': JSON.stringify([{
            toolCallId: `call-${i}`,
            toolName: '0',
            args: '{}',
          }]),
        },
        [{ name: '0', description }]
      )
    }

    for (let i = 0; i <= DdTelemetryPlugin.TOOL_CALL_NAME_CACHE_MAX; i++) {
      formatToolCall(i)
    }

    const recentSpan = { tags: {} }
    plugin.setToolTags(recentSpan, { 'ai.toolCall.id': `call-${DdTelemetryPlugin.TOOL_CALL_NAME_CACHE_MAX}` })
    assert.equal(recentSpan.tags[nameTag], `tool-${DdTelemetryPlugin.TOOL_CALL_NAME_CACHE_MAX}`)

    const evictedSpan = { tags: {} }
    plugin.setToolTags(evictedSpan, { 'ai.toolCall.id': 'call-0' })
    assert.equal(evictedSpan.tags[nameTag], undefined)
  })
})
