'use strict'

const Uint64BE = require('int64-buffer').Uint64BE
const SpanContext = require('../../../src/opentracing/span_context')

describe('TextMapPropagator', () => {
  let TextMapPropagator
  let propagator
  let textMap
  let baggageItems

  beforeEach(() => {
    TextMapPropagator = require('../../../src/opentracing/propagation/text_map')
    propagator = new TextMapPropagator()
    textMap = {
      'x-datadog-trace-id': '123',
      'x-datadog-parent-id': '-456',
      'ot-baggage-foo': 'bar'
    }
    baggageItems = {
      foo: 'bar'
    }
  })

  describe('inject', () => {
    it('should inject the span context into the carrier', () => {
      const carrier = {}
      const spanContext = new SpanContext({
        traceId: new Uint64BE(0, 123),
        spanId: new Uint64BE(-456),
        baggageItems
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.deep.equal(textMap)
    })

    it('should handle non-string values', () => {
      const carrier = {}
      const spanContext = new SpanContext({
        traceId: new Uint64BE(0, 123),
        spanId: new Uint64BE(0, 456),
        baggageItems: {
          number: 1.23,
          bool: true,
          array: ['foo', 'bar'],
          object: {}
        }
      })

      propagator.inject(spanContext, carrier)

      expect(carrier['ot-baggage-number']).to.equal('1.23')
      expect(carrier['ot-baggage-bool']).to.equal('true')
      expect(carrier['ot-baggage-array']).to.equal('foo,bar')
      expect(carrier['ot-baggage-object']).to.equal('[object Object]')
    })
  })

  describe('extract', () => {
    it('should extract a span context from the carrier', () => {
      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext).to.deep.equal(new SpanContext({
        traceId: new Uint64BE(0, 123),
        spanId: new Uint64BE(-456),
        baggageItems
      }))
    })

    it('should return null if the carrier does not contain a trace', () => {
      const carrier = {}
      const spanContext = propagator.extract(carrier)

      expect(spanContext).to.equal(null)
    })
  })
})
