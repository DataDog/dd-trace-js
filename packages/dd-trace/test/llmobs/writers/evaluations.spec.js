'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')
describe('LLMObsEvalMetricsWriter', () => {
  let LLMObsEvalMetricsWriter
  let writer
  let flush

  beforeEach(() => {
    LLMObsEvalMetricsWriter = require('../../../src/llmobs/writers/evaluations')
    flush = sinon.stub()
  })

  afterEach(() => {
    process.removeAllListeners('beforeExit')
  })

  it('constructs the url with the correct values', () => {
    writer = new LLMObsEvalMetricsWriter({
      site: 'datadoghq.com'
    })
    writer.setAgentless(true)

    writer.flush = flush // just to stop the beforeExit flush call

    assert.strictEqual(writer.url, 'https://api.datadoghq.com/api/intake/llm-obs/v1/eval-metric')
    assert.strictEqual(writer._eventType, 'evaluation_metric')
  })

  it('constructs the writer with the correct agent proxy values', () => {
    writer = new LLMObsEvalMetricsWriter({
      port: 8126,
      hostname: 'localhost'
    })
    writer.setAgentless(false)
    assert.strictEqual(writer.url, 'http://localhost:8126/evp_proxy/v2/api/intake/llm-obs/v1/eval-metric')
    assert.strictEqual(writer._eventType, 'evaluation_metric')
  })

  it('builds the payload correctly', () => {
    writer = new LLMObsEvalMetricsWriter({
      site: 'datadoghq.com',
      apiKey: 'test'
    })
    writer.setAgentless(true)

    const events = [
      { name: 'test', value: 1 }
    ]

    const payload = writer.makePayload(events)

    assert.strictEqual(payload.data.type, 'evaluation_metric')
    assert.deepStrictEqual(payload.data.attributes.metrics, events)
  })
})
