'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')

require('../../../setup/core')

const plugins = require('../../../../src/llmobs/plugins/modelcontextprotocol-sdk')

// Drives the diagnostic channels directly: the reduced path needs no MCP server to exercise.
describe('modelcontextprotocol-sdk gen_ai APM attributes with LLM Observability disabled', () => {
  const ToolCallPlugin = plugins.find(plugin => plugin.id === 'llmobs_mcp_tool_call')
  const ListToolsPlugin = plugins.find(plugin => plugin.id === 'llmobs_mcp_list_tools')

  // the tracer under test subscribes the real plugins to their own prefixes, so these subclasses
  // take private ones rather than sharing those channels
  class TestToolCallPlugin extends ToolCallPlugin {
    static prefix = 'tracing:orchestrion:mcp-gen-ai-test:Client_callTool'
  }

  class TestListToolsPlugin extends ListToolsPlugin {
    static prefix = 'tracing:orchestrion:mcp-gen-ai-test:Client_listTools'
  }

  let plugins_
  let apmTags

  beforeEach(() => {
    apmTags = {}
    plugins_ = [TestToolCallPlugin, TestListToolsPlugin].map(Plugin => {
      const plugin = new Plugin({}, { llmobs: { DD_LLMOBS_ENABLED: false }, service: 'test-service' })
      plugin.configure({ enabled: true })
      return plugin
    })
  })

  afterEach(() => {
    for (const plugin of plugins_) plugin.configure({ enabled: false })
  })

  // MCP spans carry no model, so the operation name is all the reduced path has to report
  it('tags a client tool call with the tool operation and nothing else', () => {
    publish(TestToolCallPlugin, { arguments: [{ name: 'search', arguments: { q: 'hi' } }] })

    assert.deepStrictEqual(apmTags, {
      'gen_ai.operation.name': 'tool',
      '_dd.llmobs.artificial_gen_ai_tags': 'true',
    })
  })

  it('tags a client list-tools call as a task', () => {
    publish(TestListToolsPlugin, {})

    assert.deepStrictEqual(apmTags, {
      'gen_ai.operation.name': 'task',
      '_dd.llmobs.artificial_gen_ai_tags': 'true',
    })
  })

  it('writes no model, provider or usage for either', () => {
    publish(TestToolCallPlugin, { arguments: [{ name: 'search' }] })

    assert.equal(apmTags['gen_ai.request.model'], undefined)
    assert.equal(apmTags['gen_ai.provider.name'], undefined)
    assert.equal(apmTags['gen_ai.usage.total_tokens'], undefined)
  })

  function publish (Plugin, { arguments: args = [] }) {
    const spanContext = {
      _trace: { tags: {} },
      getTags: () => ({}),
      getTag: () => undefined,
      setTag (key, value) {
        apmTags[key] = value
      },
    }
    const ctx = { currentStore: { span: { context: () => spanContext } }, arguments: args }

    dc.channel(`${Plugin.prefix}:start`).publish(ctx)
    dc.channel(`${Plugin.prefix}:asyncEnd`).publish(ctx)
  }
})
