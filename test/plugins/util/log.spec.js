'use strict'

wrapIt()

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

      tracer.scope().activate(span, () => {
        log.correlate(tracer, record)

        expect(record).to.have.deep.property('dd', {
          trace_id: span.context().toTraceId(),
          span_id: span.context().toSpanId()
        })
      })
    })

    it('should return a new correlated log record if one was not provided', () => {
      const span = tracer.startSpan('test')

      tracer.scope().activate(span, () => {
        const record = log.correlate(tracer)

        expect(record).to.have.deep.property('dd', {
          trace_id: span.context().toTraceId(),
          span_id: span.context().toSpanId()
        })
      })
    })

    it('should do nothing if there is no active scope', () => {
      const record = log.correlate(tracer)

      expect(record).to.not.have.property('dd')
    })

    it('should do nothing if the active span is null', () => {
      tracer.scopeManager().activate(null)

      const record = log.correlate(tracer)

      expect(record).to.not.have.property('dd')
    })
  })
})
