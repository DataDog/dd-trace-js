'use strict'

require('./setup/tap')

const agent = require('./plugins/agent')

const { SAMPLING_PRIORITY_KEY, DECISION_MAKER_KEY } = require('../src/constants')

describe('dd-trace', () => {
  let tracer

  beforeEach(() => {
    tracer = require('../')
    return agent.load()
  })

  afterEach(() => {
    agent.close()
  })

  it('should record and send a trace to the agent', () => {
    const span = tracer.startSpan('hello', {
      tags: {
        'resource.name': '/hello/:name'
      }
    })

    span.finish()

    return agent.assertSomeTraces((payload) => {
      expect(payload[0][0].trace_id.toString()).to.equal(span.context()._traceId.toString(10))
      expect(payload[0][0].span_id.toString()).to.equal(span.context()._spanId.toString(10))
      expect(payload[0][0].service).to.equal('test')
      expect(payload[0][0].name).to.equal('hello')
      expect(payload[0][0].resource).to.equal('/hello/:name')
      expect(typeof payload[0][0].start).to.equal('bigint')
      expect(typeof payload[0][0].duration).to.equal('bigint')
      expect(payload[0][0].metrics).to.have.property(SAMPLING_PRIORITY_KEY)
      expect(payload[0][0].meta).to.have.property(DECISION_MAKER_KEY)
    })
  })
})
