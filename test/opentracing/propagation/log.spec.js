'use strict'

const Uint64BE = require('int64-buffer').Uint64BE
const SpanContext = require('../../../src/opentracing/span_context')

describe('LogPropagator', () => {
  let LogPropagator
  let propagator
  let log

  beforeEach(() => {
    LogPropagator = require('../../../src/opentracing/propagation/log')
    propagator = new LogPropagator()
    log = {
      'dd.trace_id': '123',
      'dd.span_id': '18446744073709551160' // -456 casted to uint64
    }
  })

  describe('inject', () => {
    it('should inject the span context into the carrier', () => {
      const carrier = {}
      const spanContext = new SpanContext({
        traceId: new Uint64BE(0, 123),
        spanId: new Uint64BE(-456)
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('dd.trace_id', '123')
      expect(carrier).to.have.property('dd.span_id', '18446744073709551160') // -456 casted to uint64
    })
  })

  describe('extract', () => {
    it('should extract a span context from the carrier', () => {
      const carrier = log
      const spanContext = propagator.extract(carrier)

      expect(spanContext).to.deep.equal(new SpanContext({
        traceId: new Uint64BE(0, 123),
        spanId: new Uint64BE(-456)
      }))
    })

    it('should return null if the carrier does not contain a trace', () => {
      const carrier = {}
      const spanContext = propagator.extract(carrier)

      expect(spanContext).to.equal(null)
    })
  })
})
