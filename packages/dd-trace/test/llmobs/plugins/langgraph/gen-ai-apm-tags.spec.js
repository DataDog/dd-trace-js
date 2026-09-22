'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')

require('../../../setup/core')

const plugins = require('../../../../src/llmobs/plugins/langgraph')

// Drives the diagnostic channels directly: the reduced path needs no graph to exercise.
describe('langgraph gen_ai APM attributes with LLM Observability disabled', () => {
  const PregelStreamPlugin = plugins.find(plugin => plugin.id === 'llmobs_langgraph_pregel_stream')

  // the tracer under test subscribes the real plugin to its own prefix, so this subclass takes a
  // private one rather than sharing those channels
  class TestPregelStreamPlugin extends PregelStreamPlugin {
    static prefix = 'tracing:orchestrion:langgraph-gen-ai-test:Pregel_stream'
  }

  const startCh = dc.channel(`${TestPregelStreamPlugin.prefix}:start`)

  let plugin
  let apmTags

  beforeEach(() => {
    apmTags = {}
    plugin = new TestPregelStreamPlugin({}, {
      llmobs: { DD_LLMOBS_ENABLED: false },
      service: 'test-service',
    })
    plugin.configure({ enabled: true })
  })

  afterEach(() => {
    plugin.configure({ enabled: false })
  })

  it('tags the graph run as a workflow', () => {
    publish({ name: 'my-graph' })

    assert.deepStrictEqual(apmTags, {
      'gen_ai.operation.name': 'workflow',
      'gen_ai.application.name': 'test-service',
      '_dd.llmobs.artificial_gen_ai_tags': 'true',
    })
  })

  // a workflow carries no model, and its metrics are not token counts
  it('writes no model or usage for a graph run', () => {
    publish({ name: 'my-graph' })

    assert.equal(apmTags['gen_ai.request.model'], undefined)
    assert.equal(apmTags['gen_ai.provider.name'], undefined)
    assert.equal(apmTags['gen_ai.usage.total_tokens'], undefined)
  })

  it('emits nothing when the operation has no span', () => {
    startCh.publish({ currentStore: {}, self: { name: 'my-graph' }, arguments: [{}] })

    assert.deepStrictEqual(apmTags, {})
  })

  function publish ({ name }) {
    const spanContext = {
      _trace: { tags: {} },
      getTags: () => ({}),
      getTag: () => undefined,
      setTag (key, value) {
        apmTags[key] = value
      },
    }

    startCh.publish({
      currentStore: { span: { context: () => spanContext } },
      self: { name },
      arguments: [{}],
    })
  }
})
