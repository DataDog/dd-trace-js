'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')

require('../../../setup/core')

const plugins = require('../../../../src/llmobs/plugins/openai/realtime')

// Realtime opts out of the reduced path, so with LLM Observability off it behaves as it did before
// the `gen_ai.*` tags existed: no subscriptions at all, and so no retained audio.
describe('openai realtime with LLM Observability disabled', () => {
  const ResponsePlugin = plugins.find(plugin => plugin.id === 'openai_realtime_response_llmobs')

  class TestResponsePlugin extends ResponsePlugin {
    static prefix = 'tracing:apm:openai:realtime-opt-out-test:response'
  }

  const startCh = dc.channel(`${TestResponsePlugin.prefix}:start`)
  const audioCh = dc.channel('dd-trace:openai:realtime:audio')

  let plugin
  let apmTags

  afterEach(() => {
    plugin?.configure({ enabled: false })
  })

  function buildPlugin (llmobsEnabled) {
    apmTags = {}
    plugin = new TestResponsePlugin({}, {
      llmobs: { DD_LLMOBS_ENABLED: llmobsEnabled },
      service: 'test-service',
    })
    plugin._tagger = { registerLLMObsSpan () {} }
    plugin.configure({ enabled: true })
    return plugin
  }

  function publishStart () {
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
      turn: { model: 'gpt-4o-realtime-preview', basePath: 'https://api.openai.com/v1', sessionId: 'sess-1' },
    })
  }

  describe('with LLM Observability off', () => {
    beforeEach(() => buildPlugin(false))

    it('stays disabled rather than emitting gen_ai tags', () => {
      publishStart()

      assert.deepStrictEqual(apmTags, {})
    })

    // the instrumentation retains a turn's audio only while something subscribes here
    it('does not subscribe to the audio channel', () => {
      assert.equal(audioCh.hasSubscribers, false)
    })
  })

  describe('with LLM Observability on', () => {
    beforeEach(() => buildPlugin(true))

    it('subscribes to the audio channel', () => {
      assert.equal(audioCh.hasSubscribers, true)
    })
  })
})
