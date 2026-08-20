'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')

const parents = new WeakMap()
const spanKinds = new WeakMap()
const LLMObsTagger = {
  getParent (span) {
    return parents.get(span)
  },
  getSpanKind (span) {
    return spanKinds.get(span)
  },
}

class BaseLLMObsPlugin {}

const DdTelemetryPlugin = proxyquire('../../../../src/llmobs/plugins/ai/ddTelemetry', {
  '../../tagger': LLMObsTagger,
  '../base': BaseLLMObsPlugin,
})

describe('AI SDK DD telemetry register options', () => {
  const plugin = new DdTelemetryPlugin()

  function getToolOptions (parent) {
    return plugin.getLLMObsSpanRegisterOptions({
      attributes: {},
      name: 'ai.streamText.toolCall',
    }, parent)
  }

  it('uses the semantic parent of an ambient LLM span for a tool', () => {
    const semanticParent = {}
    const parent = {}
    parents.set(parent, semanticParent)
    spanKinds.set(parent, 'llm')

    assert.strictEqual(getToolOptions(parent).parent, semanticParent)
  })

  it('does not override a non-LLM ambient parent', () => {
    const parent = {}
    spanKinds.set(parent, 'workflow')

    assert.strictEqual(Object.hasOwn(getToolOptions(parent), 'parent'), false)
  })

  it('does not override an LLM parent without a resolved semantic parent', () => {
    const parent = {}
    spanKinds.set(parent, 'llm')

    assert.strictEqual(Object.hasOwn(getToolOptions(parent), 'parent'), false)
  })
})
