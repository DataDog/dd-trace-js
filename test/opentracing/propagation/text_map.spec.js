'use strict'

const Uint64BE = require('int64-buffer').Uint64BE
const SpanContext = require('../../../src/opentracing/span_context')

describe('TextMapPropagator', () => {
  let TextMapPropagator
  let propagator
  let textMap
  let prioritySampler
  let baggageItems

  beforeEach(() => {
    prioritySampler = {
      validate: sinon.stub().returns(false)
    }

    TextMapPropagator = require('../../../src/opentracing/propagation/text_map')
    propagator = new TextMapPropagator(prioritySampler)
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
    beforeEach(() => {
      prioritySampler.sample = sinon.spy(context => {
        context.sampling.priority = context.sampling.priority || 2
      })
    })

    it('should inject the span context into the carrier', () => {
      const carrier = {}
      const spanContext = new SpanContext({
        traceId: new Uint64BE(0, 123),
        spanId: new Uint64BE(-456),
        baggageItems
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('x-datadog-trace-id', '123')
      expect(carrier).to.have.property('x-datadog-parent-id', '-456')
      expect(carrier).to.have.property('ot-baggage-foo', 'bar')
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

    it('should generate the sampling priority', () => {
      const carrier = {}
      const spanContext = new SpanContext({
        traceId: new Uint64BE(0, 123),
        spanId: new Uint64BE(-456),
        baggageItems
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('x-datadog-sampling-priority', '2')
      expect(spanContext.sampling).to.have.property('priority', 2)
    })

    it('should inject an existing sampling priority', () => {
      prioritySampler.sample = () => {}

      const carrier = {}
      const spanContext = new SpanContext({
        traceId: new Uint64BE(0, 123),
        spanId: new Uint64BE(-456),
        sampling: {
          priority: 0
        },
        baggageItems
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('x-datadog-sampling-priority', '0')
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

    it('should extract a span context with a valid sampling priority', () => {
      prioritySampler.validate.returns(true)

      textMap['x-datadog-sampling-priority'] = '0'
      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext).to.deep.equal(new SpanContext({
        traceId: new Uint64BE(0, 123),
        spanId: new Uint64BE(-456),
        sampling: {
          priority: 0
        },
        baggageItems
      }))
    })
  })
})
