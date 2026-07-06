'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const {
  CACHED_LLMOBS_EVENT_SYMBOL,
  LLMOBS_META_STRUCT_KEY,
} = require('../../src/llmobs/export-mode')

const agentConfig = {
  DD_TRACE_ENABLED: true,
  apmTracingEnabled: true,
  llmobs: { DD_LLMOBS_ENABLED: true },
}

describe('LLMObs sampling fallback processor', () => {
  let log
  let processor
  let writer

  beforeEach(() => {
    log = { warn: sinon.stub() }
    processor = proxyquire('../../src/llmobs/sampling-fallback-processor', {
      '../log': log,
    })
    writer = { append: sinon.stub().returns(true) }
    processor.setWriter(writer)
  })

  afterEach(() => {
    processor.setWriter(null)
    sinon.restore()
  })

  it('rescues cached LLMObs events when the APM agent trace is auto-rejected', () => {
    const event = { span_id: '123' }
    const routing = { apiKey: undefined, site: undefined }
    const { span, tags } = createSpan({ priority: 0, event, routing })

    processor.processTrace([span], agentConfig)

    sinon.assert.calledOnceWithExactly(writer.append, event, routing)
    assert.strictEqual(tags['_dd.llmobs.submitted'], '1')
    assert.strictEqual(span.meta_struct, undefined)
  })

  it('rescues cached LLMObs events when the APM agent trace is user-rejected', () => {
    const event = { span_id: '123' }
    const { span } = createSpan({ priority: -1, event })

    processor.processTrace([span], agentConfig)

    sinon.assert.calledOnce(writer.append)
    assert.strictEqual(span.meta_struct, undefined)
  })

  it('leaves kept APM agent traces on the meta_struct path', () => {
    const event = { span_id: '123' }
    const { span, tags } = createSpan({ priority: 1, event })

    processor.processTrace([span], agentConfig)

    sinon.assert.notCalled(writer.append)
    assert.deepStrictEqual(span.meta_struct, { [LLMOBS_META_STRUCT_KEY]: event })
    assert.strictEqual(tags['_dd.llmobs.submitted'], undefined)
  })

  it('does not rescue APM agentless traces', () => {
    const event = { span_id: '123' }
    const { span } = createSpan({ priority: 0, event })

    processor.processTrace([span], {
      ...agentConfig,
      experimental: { exporter: 'agentless' },
    })

    sinon.assert.notCalled(writer.append)
    assert.deepStrictEqual(span.meta_struct, { [LLMOBS_META_STRUCT_KEY]: event })
  })

  it('scrubs half-built LLMObs meta_struct payloads on rejected APM agent traces', () => {
    const event = { span_id: '123' }
    const other = { value: true }
    const { span } = createSpan({
      priority: 0,
      event: undefined,
      metaStruct: {
        [LLMOBS_META_STRUCT_KEY]: event,
        other,
      },
    })

    processor.processTrace([span], agentConfig)

    sinon.assert.notCalled(writer.append)
    assert.deepStrictEqual(span.meta_struct, { other })
  })

  it('does not mark the span as submitted when fallback writer drops the event', () => {
    const event = { span_id: '123' }
    const { span, tags } = createSpan({ priority: 0, event })
    writer.append.returns(false)

    processor.processTrace([span], agentConfig)

    assert.strictEqual(tags['_dd.llmobs.submitted'], undefined)
    assert.strictEqual(span.meta_struct, undefined)
  })

  it('scrubs meta_struct and logs when fallback writer throws', () => {
    const event = { span_id: '123' }
    const { span, tags } = createSpan({ priority: 0, event })
    writer.append.throws(new Error('boom'))

    processor.processTrace([span], agentConfig)

    assert.strictEqual(tags['_dd.llmobs.submitted'], undefined)
    assert.strictEqual(span.meta_struct, undefined)
    sinon.assert.calledOnce(log.warn)
  })
})

function createSpan ({ priority, event, routing = {}, metaStruct } = {}) {
  const tags = {}
  const context = {
    _sampling: { priority },
    _tags: tags,
    setTag (key, value) {
      this._tags[key] = value
    },
  }
  const span = {
    _duration: 1,
    meta_struct: metaStruct ?? { [LLMOBS_META_STRUCT_KEY]: event },
    context () {
      return context
    },
  }

  if (event !== undefined) {
    span[CACHED_LLMOBS_EVENT_SYMBOL] = { event, routing }
  }

  return { span, tags }
}
