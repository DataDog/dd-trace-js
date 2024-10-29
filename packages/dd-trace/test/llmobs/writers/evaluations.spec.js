'use strict'

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

  it('constructs the writer with the correct values', () => {
    writer = new LLMObsEvalMetricsWriter({
      site: 'datadoghq.com',
      llmobs: {},
      apiKey: '1234'
    })

    writer.flush = flush // just to stop the beforeExit flush call

    expect(writer._url.href).to.equal('https://api.datadoghq.com/api/intake/llm-obs/v1/eval-metric')
    expect(writer._headers['DD-API-KEY']).to.equal('1234')
    expect(writer._eventType).to.equal('evaluation_metric')
  })

  it('builds the payload correctly', () => {
    writer = new LLMObsEvalMetricsWriter({
      site: 'datadoghq.com',
      apiKey: 'test'
    })

    const events = [
      { name: 'test', value: 1 }
    ]

    const payload = writer.makePayload(events)

    expect(payload.data.type).to.equal('evaluation_metric')
    expect(payload.data.attributes.metrics).to.deep.equal(events)
  })
})
