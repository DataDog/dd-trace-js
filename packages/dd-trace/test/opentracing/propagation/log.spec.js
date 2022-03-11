'use strict'

describe('LogPropagator', () => {
  let tracer

  beforeEach(() => {
    tracer = require('../../../../..').init({
      service: 'test',
      env: 'dev',
      version: '1.0.0'
    })
  })

  describe('inject', () => {
    it('should inject the span context into the carrier', () => {
      const carrier = {}
      const span = tracer.startSpan('test')
      const spanContext = span.context()

      tracer.inject(spanContext, 'log', carrier)

      expect(carrier).to.have.property('dd')
      expect(carrier.dd).to.have.property('trace_id', spanContext.toTraceId())
      expect(carrier.dd).to.have.property('span_id', spanContext.toSpanId())
    })

    it('should inject the global context into the carrier', () => {
      const carrier = {}

      tracer.inject(null, 'log', carrier)

      expect(carrier).to.deep.include({
        dd: {
          service: 'test',
          env: 'dev',
          version: '1.0.0'
        }
      })
    })
  })

  describe('extract', () => {
    let log

    beforeEach(() => {
      log = {
        dd: {
          trace_id: '123',
          span_id: '18446744073709551160' // -456 casted to uint64
        }
      }
    })

    it('should return null as it is not supported', () => {
      const carrier = log
      const spanContext = tracer.extract('log', carrier)

      expect(spanContext).to.equal(null)
    })
  })
})
