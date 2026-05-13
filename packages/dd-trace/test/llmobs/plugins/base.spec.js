'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('LLMObsPlugin base', () => {
  let LLMObsPlugin
  let registerLLMObsSpan
  let tagMap

  beforeEach(() => {
    registerLLMObsSpan = sinon.stub()
    tagMap = new WeakMap()

    class FakeTracingPlugin {}

    class FakeLLMObsTagger {
      constructor () {
        this.registerLLMObsSpan = registerLLMObsSpan
      }

      static get tagMap () { return tagMap }
    }

    LLMObsPlugin = proxyquire('../../../src/llmobs/plugins/base', {
      '../../plugins/tracing': FakeTracingPlugin,
      '../tagger': FakeLLMObsTagger,
      '../storage': { storage: { getStore () { return undefined }, enterWith () {} } },
      '../telemetry': { incrementLLMObsSpanStartCount () {} },
    })
  })

  function makeSpan (traceTags = {}, traceId = '00000000000000001111111111111111', spanId = '2222222222222222') {
    return {
      context () {
        return {
          _trace: { tags: traceTags },
          toTraceId () { return traceId },
          toSpanId () { return spanId },
        }
      },
    }
  }

  describe('start', () => {
    let TestPlugin

    beforeEach(() => {
      TestPlugin = class extends LLMObsPlugin {
        static integration = 'test-integration'
        getLLMObsSpanRegisterOptions (ctx) {
          return ctx.registerOptions
        }
      }
    })

    function makePlugin (enabled = true) {
      const plugin = new TestPlugin()
      plugin._tracerConfig = { llmobs: { enabled } }
      plugin._tagger = { registerLLMObsSpan }
      return plugin
    }

    it('writes bridge tags on first plugin-registered span', () => {
      const traceTags = {}
      const span = makeSpan(traceTags)
      const ctx = { currentStore: { span }, registerOptions: {} }

      makePlugin().start(ctx)

      assert.equal(registerLLMObsSpan.callCount, 1)
      assert.equal(traceTags.llmobs_trace_id, '00000000000000001111111111111111')
      assert.equal(traceTags.llmobs_parent_id, '2222222222222222')
    })

    it('does not overwrite bridge tags on a subsequent plugin span in the same local trace', () => {
      const traceTags = {}
      const ctx1 = { currentStore: { span: makeSpan(traceTags, 'aaaa', 'first') }, registerOptions: {} }
      const ctx2 = { currentStore: { span: makeSpan(traceTags, 'bbbb', 'second') }, registerOptions: {} }

      const plugin = makePlugin()
      plugin.start(ctx1)
      plugin.start(ctx2)

      assert.equal(traceTags.llmobs_trace_id, 'aaaa')
      assert.equal(traceTags.llmobs_parent_id, 'first')
    })

    it('does not write bridge tags when llmobs is disabled', () => {
      const traceTags = {}
      const span = makeSpan(traceTags)
      const ctx = { currentStore: { span }, registerOptions: {} }

      makePlugin(false).start(ctx)

      assert.equal(registerLLMObsSpan.callCount, 0)
      assert.equal(traceTags.llmobs_trace_id, undefined)
      assert.equal(traceTags.llmobs_parent_id, undefined)
    })

    it('does not write bridge tags when the plugin returns no register options', () => {
      const NoRegisterPlugin = class extends LLMObsPlugin {
        static integration = 'test-integration'
        getLLMObsSpanRegisterOptions () { return null }
      }
      const traceTags = {}
      const span = makeSpan(traceTags)
      const ctx = { currentStore: { span } }

      const plugin = new NoRegisterPlugin()
      plugin._tracerConfig = { llmobs: { enabled: true } }
      plugin._tagger = { registerLLMObsSpan }
      plugin.start(ctx)

      assert.equal(registerLLMObsSpan.callCount, 0)
      assert.equal(traceTags.llmobs_trace_id, undefined)
      assert.equal(traceTags.llmobs_parent_id, undefined)
    })
  })
})
