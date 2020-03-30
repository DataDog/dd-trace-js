'use strict'

const id = require('../../../src/id')
const SpanContext = require('../../../src/opentracing/span_context')

describe('LogPropagator', () => {
  let LogPropagator
  let propagator
  let log

  beforeEach(() => {
    LogPropagator = require('../../../src/opentracing/propagation/log')
    propagator = new LogPropagator()
    log = {
      dd: {
        trace_id: '123',
        span_id: '18446744073709551160' // -456 casted to uint64
      }
    }
  })

  describe('inject', () => {
    it('should inject the span context into the carrier', () => {
      const carrier = {}
      const spanContext = new SpanContext({
        traceId: id('123', 10),
        spanId: id('-456', 10),
        tags: {
          service: 'test',
          env: 'dev',
          version: '1.0.0'
        }
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.deep.include({
        dd: {
          trace_id: '123',
          span_id: '18446744073709551160', // -456 casted to uint64
          service: 'test',
          env: 'dev',
          version: '1.0.0'
        }
      })
    })
  })

  describe('extract', () => {
    it('should extract a span context from the carrier', () => {
      const carrier = log
      const spanContext = propagator.extract(carrier)

      expect(spanContext).to.deep.equal(new SpanContext({
        traceId: id('123', 10),
        spanId: id('-456', 10)
      }))
    })

    it('should return null if the carrier does not contain a trace', () => {
      const carrier = {}
      const spanContext = propagator.extract(carrier)

      expect(spanContext).to.equal(null)
    })
  })
})
