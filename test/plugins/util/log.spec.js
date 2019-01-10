'use strict'

describe('plugins/util/log', () => {
  let log
  let tracer

  beforeEach(() => {
    tracer = require('../../..').init({ service: 'test', plugins: false })
    log = require('../../../src/plugins/util/log')
  })

  describe('correlate', () => {
    it('should attach the current scope trace identifiers to the log record', () => {
      const record = {}
      const span = tracer.startSpan('test')

      tracer.scopeManager().activate(span)

      log.correlate(tracer, record)

      expect(record).to.include({
        'dd.trace_id': span.context().toTraceId(),
        'dd.span_id': span.context().toSpanId()
      })
    })

    it('should return a new correlated log record if one was not provided', () => {
      const span = tracer.startSpan('test')

      tracer.scopeManager().activate(span)

      const record = log.correlate(tracer)

      expect(record).to.include({
        'dd.trace_id': span.context().toTraceId(),
        'dd.span_id': span.context().toSpanId()
      })
    })

    it('should do nothing if there is no active scope', () => {
      const span = tracer.startSpan('test')
      const record = log.correlate(tracer)

      expect(record).to.not.include({
        'dd.trace_id': span.context().toTraceId(),
        'dd.span_id': span.context().toSpanId()
      })
    })
  })
})
