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
      'gen_ai.conversation.id': 'sess-1',
      '_dd.llmobs.artificial_gen_ai_tags': 'true',
    })
  })

  // the in-process trace default is written by the tagger, which never runs on this path, so an
  // upstream service is the only place an inherited session can come from
  it('inherits a propagated session when the integration has none', () => {
    traceTags['_dd.p.llmobs_sid'] = 'sess-from-upstream'
    publishStart()

    assert.equal(apmTags['gen_ai.conversation.id'], 'sess-from-upstream')
  })

  it('does not read the in-process trace session default, which this path never writes', () => {
    traceTags['_ml_obs.trace_session_id'] = 'sess-from-trace'
    publishStart()

    assert.equal(apmTags['gen_ai.conversation.id'], undefined)
  })

  // an integration can decline the reduced path, and then behaves as it did before the tags existed
  it('stays disabled for an integration that opts out of the gen_ai tags', () => {
    class OptedOutPlugin extends TestLLMObsPlugin {
      static id = 'llmobs-base-test-opted-out'
      static emitsGenAiApmTags = false
    }

    const optedOut = new OptedOutPlugin({}, {
      llmobs: { DD_LLMOBS_ENABLED: false },
      service: 'test-service',
    })
    optedOut.configure({ enabled: true })

    try {
      assert.equal(optedOut._enabled, false)
    } finally {
      optedOut.configure({ enabled: false })
    }
  })

  it('does not tag the ml app, which is an LLM Observability concept', () => {
    publishStart()

    assert.equal(apmTags['gen_ai.application.name'], undefined)
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

  // `llmobs.enable()` flips the config flag while operations are in flight; one that switched
  // track halfway would ask the tagger to tag a span its start never registered, and lose the
  // response-derived tags the reduced path resolves at the end
  describe('when LLM Observability is toggled mid-operation', () => {
    it('keeps an operation started while disabled on the reduced path', () => {
      const ctx = publishStart()

      plugin._tracerConfig.llmobs.DD_LLMOBS_ENABLED = true
      plugin.setLLMObsTags = () => assert.fail('setLLMObsTags must not run for a reduced-path span')

      endTags = { metrics: { inputTokens: 10, outputTokens: 20 } }
      asyncEndCh.publish(ctx)

      assert.equal(apmTags['gen_ai.usage.input_tokens'], 10)
      assert.equal(apmTags['gen_ai.usage.output_tokens'], 20)
    })

    it('keeps an operation started while enabled on the LLMObs path', () => {
      plugin._tracerConfig.llmobs.DD_LLMOBS_ENABLED = true

      let tagged = 0
      plugin.setLLMObsTags = () => { tagged++ }
      // no register options, so the start registers no span and leaves the LLMObs storage alone
      registerOptions = undefined

      const ctx = publishStart()
      plugin._tracerConfig.llmobs.DD_LLMOBS_ENABLED = false

      endTags = { metrics: { inputTokens: 10 } }
      asyncEndCh.publish(ctx)

      assert.equal(tagged, 1)
      // the reduced path never ran, so it wrote no attributes of its own
      assert.equal(apmTags['gen_ai.usage.input_tokens'], undefined)
    })
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
