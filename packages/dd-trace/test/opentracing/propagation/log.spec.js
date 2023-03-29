'use strict'

require('../../setup/tap')

const id = require('../../../src/id')
const SpanContext = require('../../../src/opentracing/span_context')

describe('LogPropagator', () => {
  let LogPropagator
  let propagator
  let log
  let config

  beforeEach(() => {
    config = {
      service: 'test',
      env: 'dev',
      version: '1.0.0'
    }
    LogPropagator = require('../../../src/opentracing/propagation/log')
    propagator = new LogPropagator(config)
    log = {
      dd: {
        trace_id: '123',
        span_id: '456'
      }
    }
  })

  describe('inject', () => {
    it('should inject the span context into the carrier', () => {
      const carrier = {}
      const spanContext = new SpanContext({
        traceId: id('123', 10),
        spanId: id('456', 10)
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('dd')
      expect(carrier.dd).to.have.property('trace_id', '123')
      expect(carrier.dd).to.have.property('span_id', '456')
    })

    it('should inject the global context into the carrier', () => {
      const carrier = {}

      propagator.inject(null, carrier)

      expect(carrier).to.deep.include({
        dd: {
          service: 'test',
          env: 'dev',
          version: '1.0.0'
        }
      })
    })

    it('should inject 128-bit trace IDs when enabled', () => {
      config.traceId128BitLoggingEnabled = true

      const carrier = {}
      const traceId = id('1234567812345678')
      const traceIdTag = '8765432187654321'
      const spanContext = new SpanContext({
        traceId,
        spanId: id('456', 10)
      })

      spanContext._trace.tags['_dd.p.tid'] = traceIdTag

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('dd')
      expect(carrier.dd).to.have.property('trace_id', '87654321876543211234567812345678')
      expect(carrier.dd).to.have.property('span_id', '456')
    })

    it('should not inject 128-bit trace IDs when disabled', () => {
      const carrier = {}
      const traceId = id('123', 10)
      const traceIdTag = '8765432187654321'
      const spanContext = new SpanContext({
        traceId,
        spanId: id('456', 10)
      })

      spanContext._trace.tags['_dd.p.tid'] = traceIdTag

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('dd')
      expect(carrier.dd).to.have.property('trace_id', '123')
      expect(carrier.dd).to.have.property('span_id', '456')
    })
  })

  describe('extract', () => {
    it('should extract a span context from the carrier', () => {
      const carrier = log
      const spanContext = propagator.extract(carrier)

      expect(spanContext).to.deep.equal(new SpanContext({
        traceId: id('123', 10),
        spanId: id('456', 10)
      }))
    })

    it('should convert signed IDs to unsigned', () => {
      log.dd.trace_id = '-123'
      log.dd.span_id = '-456'

      const carrier = log
      const spanContext = propagator.extract(carrier)

      expect(spanContext).to.deep.equal(new SpanContext({
        traceId: id('18446744073709551493', 10), // -123 casted to uint64
        spanId: id('18446744073709551160', 10) // -456 casted to uint64
      }))
    })

    it('should return null if the carrier does not contain a trace', () => {
      const carrier = {}
      const spanContext = propagator.extract(carrier)

      expect(spanContext).to.equal(null)
    })

    it('should extract 128-bit IDs', () => {
      config.traceId128BitLoggingEnabled = true
      log.dd.trace_id = '87654321876543211234567812345678'

      const carrier = log
      const spanContext = propagator.extract(carrier)

      expect(spanContext).to.deep.equal(new SpanContext({
        traceId: id('1234567812345678', 16),
        spanId: id('456', 10),
        trace: {
          started: [],
          finished: [],
          tags: {
            '_dd.p.tid': '8765432187654321'
          }
        }
      }))
    })
  })
})
