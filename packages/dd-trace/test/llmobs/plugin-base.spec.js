'use strict'

require('../setup/core')

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')

const LLMObsPlugin = require('../../src/llmobs/plugins/base')

// Drives the plugin's diagnostic channels directly: the reduced path this covers only reads the
// span register options, so it needs no LLM library.
describe('LLMObs plugin with LLM Observability disabled', () => {
  const startCh = dc.channel('tracing:apm:llmobs-base-test:request:start')
  const asyncEndCh = dc.channel('tracing:apm:llmobs-base-test:request:asyncEnd')

  let plugin
  let apmTags
  let traceTags
  let registerOptions
  let endTags

  class TestLLMObsPlugin extends LLMObsPlugin {
    static id = 'llmobs-base-test'
    static prefix = 'tracing:apm:llmobs-base-test:request'

    getLLMObsSpanRegisterOptions (ctx) {
      return registerOptions
    }

    getGenAiApmEndTags (ctx, spanKind) {
      return endTags
    }
  }

  beforeEach(() => {
    apmTags = {}
    traceTags = {}
    registerOptions = { kind: 'llm', modelName: 'gpt-4', modelProvider: 'OpenAI' }
    endTags = undefined

    plugin = new TestLLMObsPlugin({}, {
      llmobs: { DD_LLMOBS_ENABLED: false },
      service: 'test-service',
    })
    plugin.configure({ enabled: true })
  })

  afterEach(() => {
    plugin.configure({ enabled: false })
  })

  it('tags the scalars from the register options', () => {
    registerOptions.sessionId = 'sess-1'
    publishStart()

    assert.deepStrictEqual(apmTags, {
      'gen_ai.operation.name': 'llm',
      'gen_ai.request.model': 'gpt-4',
      'gen_ai.provider.name': 'openai',
      'gen_ai.application.name': 'test-service',
      'gen_ai.conversation.id': 'sess-1',
    })
  })

  it('inherits the session from the trace when the integration has none', () => {
    traceTags['_ml_obs.trace_session_id'] = 'sess-from-trace'
    publishStart()

    assert.equal(apmTags['gen_ai.conversation.id'], 'sess-from-trace')
  })

  it('emits nothing for an operation without a span kind', () => {
    registerOptions = undefined
    const ctx = publishStart()
    endTags = { metrics: { inputTokens: 1 } }
    asyncEndCh.publish(ctx)

    assert.deepStrictEqual(apmTags, {})
  })

  it('applies token usage resolved at the end of the operation', () => {
    const ctx = publishStart()
    endTags = { metrics: { inputTokens: 10, outputTokens: 20 } }
    asyncEndCh.publish(ctx)

    assert.equal(apmTags['gen_ai.usage.input_tokens'], 10)
    assert.equal(apmTags['gen_ai.usage.output_tokens'], 20)
  })

  it('corrects a model only known at the end of the operation', () => {
    registerOptions = { kind: 'llm' }
    const ctx = publishStart()

    assert.equal(apmTags['gen_ai.request.model'], 'custom')

    endTags = { modelName: 'gpt-4o', modelProvider: 'OpenAI' }
    asyncEndCh.publish(ctx)

    assert.equal(apmTags['gen_ai.request.model'], 'gpt-4o')
    assert.equal(apmTags['gen_ai.provider.name'], 'openai')
  })

  it('corrects a span kind only known at the end of the operation', () => {
    registerOptions = { kind: 'tool' }
    const ctx = publishStart()
    endTags = { spanKind: 'agent' }
    asyncEndCh.publish(ctx)

    assert.equal(apmTags['gen_ai.operation.name'], 'agent')
  })

  function publishStart () {
    const spanContext = {
      _trace: { tags: traceTags },
      setTag (key, value) {
        apmTags[key] = value
      },
    }
    const ctx = { currentStore: { span: { context: () => spanContext } } }
    startCh.publish(ctx)
    return ctx
  }
})
