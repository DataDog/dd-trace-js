'use strict'

const Uint64BE = require('int64-buffer').Uint64BE
const SpanContext = require('../../../src/opentracing/span_context')

describe('TextMapPropagator', () => {
  let tracer
  let TextMapPropagator
  let propagator
  let textMap
  let baggageItems

  beforeEach(() => {
    tracer = {
      _isSampled: sinon.stub().returns(true)
    }

    TextMapPropagator = require('../../../src/opentracing/propagation/text_map')
    propagator = new TextMapPropagator(tracer)
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

    it('should inject the sampling priority', () => {
      const priorities = [-1, 0, 1, 2]
      priorities.forEach(p => {
        const carrier = {}
        const spanContext = new SpanContext({
          traceId: new Uint64BE(0, 123),
          spanId: new Uint64BE(-456),
          samplingPriority: p,
          baggageItems
        })

        propagator.inject(spanContext, carrier)

        textMap['x-datadog-sampling-priority'] = p.toString()
        expect(carrier).to.deep.equal(textMap)
      })
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

    it('should extract a span context from the carrier and re-sample', () => {
      // if there is no incoming priority header (which is tested below), make sure we
      // ask the sampler whether the new context should be sampled (otherwise the
      // default SpanContext constructor behavior is to sample everything).
      const sampleDecisions = [true, false];
      sampleDecisions.forEach(sampled => {
        tracer._isSampled = sinon.stub().returns(sampled)
        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.deep.equal(new SpanContext({
          traceId: new Uint64BE(0, 123),
          spanId: new Uint64BE(-456),
          sampled: sampled,
          baggageItems
        }))
      })
    })

    it('should return null if the carrier does not contain a trace', () => {
      const carrier = {}
      const spanContext = propagator.extract(carrier)

      expect(spanContext).to.equal(null)
    })

    it('should extract a span context with a sampling priority', () => {
      const priorities = [-1, 0, 1, 2]
      priorities.forEach(p => {
        textMap['x-datadog-sampling-priority'] = p.toString()
        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.deep.equal(new SpanContext({
          traceId: new Uint64BE(0, 123),
          spanId: new Uint64BE(-456),
          samplingPriority: p,
          sampled: p > 0,
          baggageItems
        }))
      })
    })
  })
})
