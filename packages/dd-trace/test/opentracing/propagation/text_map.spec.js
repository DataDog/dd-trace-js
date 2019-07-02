'use strict'

const platform = require('../../../src/platform')
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
      'x-datadog-parent-id': '18446744073709551160', // -456 casted to uint64
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
        traceId: platform.id('123', 10),
        spanId: platform.id('-456', 10),
        baggageItems
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('x-datadog-trace-id', '123')
      expect(carrier).to.have.property('x-datadog-parent-id', '18446744073709551160') // -456 casted to uint64
      expect(carrier).to.have.property('ot-baggage-foo', 'bar')
    })

    it('should handle non-string values', () => {
      const carrier = {}
      const spanContext = new SpanContext({
        traceId: platform.id('123', 10),
        spanId: platform.id('-456', 10),
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

    it('should inject an existing sampling priority', () => {
      const carrier = {}
      const spanContext = new SpanContext({
        traceId: platform.id('123', 10),
        spanId: platform.id('-456', 10),
        sampling: {
          priority: 0
        },
        baggageItems
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('x-datadog-sampling-priority', '0')
    })

    it('should inject the origin', () => {
      const carrier = {}
      const spanContext = new SpanContext({
        traceId: platform.id('123', 10),
        spanId: platform.id('-456', 10),
        trace: {
          origin: 'synthetics'
        }
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('x-datadog-origin', 'synthetics')
    })

    it('should inject the trace B3 headers', () => {
      const carrier = {}
      const spanContext = new SpanContext({
        traceId: platform.id('0000000000000123'),
        spanId: platform.id('0000000000000456'),
        parentId: platform.id('0000000000000789'),
        traceFlags: {
          sampled: true
        }
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('x-b3-traceid', '0000000000000123')
      expect(carrier).to.have.property('x-b3-spanid', '0000000000000456')
      expect(carrier).to.have.property('x-b3-parentspanid', '0000000000000789')
      expect(carrier).to.have.property('x-b3-sampled', '1')
    })
  })

  describe('extract', () => {
    it('should extract a span context from the carrier', () => {
      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext).to.deep.equal(new SpanContext({
        traceId: platform.id('123', 10),
        spanId: platform.id('-456', 10),
        baggageItems
      }))
    })

    it('should return null if the carrier does not contain a trace', () => {
      const carrier = {}
      const spanContext = propagator.extract(carrier)

      expect(spanContext).to.equal(null)
    })

    it('should extract a span context with a valid sampling priority', () => {
      textMap['x-datadog-sampling-priority'] = '0'
      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext).to.deep.equal(new SpanContext({
        traceId: platform.id('123', 10),
        spanId: platform.id('-456', 10),
        sampling: {
          priority: 0
        },
        baggageItems
      }))
    })

    it('should extract the origin', () => {
      textMap['x-datadog-origin'] = 'synthetics'
      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext._trace).to.have.property('origin', 'synthetics')
    })

    describe('with B3 propagation as multiple headers', () => {
      it('should extract the headers', () => {
        textMap['x-b3-traceid'] = '0000000000000123'
        textMap['x-b3-spanid'] = '0000000000000456'
        textMap['x-b3-sampled'] = '1'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.deep.equal(new SpanContext({
          traceId: platform.id('123', 16),
          spanId: platform.id('456', 16),
          baggageItems,
          traceFlags: {
            sampled: true
          }
        }))
      })

      it('should support unsampled traces', () => {
        delete textMap['x-datadog-trace-id']
        delete textMap['x-datadog-parent-id']

        textMap['x-b3-sampled'] = '0'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._traceFlags.sampled).to.equal(false)
      })

      it('should support sampled traces', () => {
        delete textMap['x-datadog-trace-id']
        delete textMap['x-datadog-parent-id']

        textMap['x-b3-sampled'] = '1'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._traceFlags.sampled).to.equal(true)
      })

      it('should support the debug flag', () => {
        delete textMap['x-datadog-trace-id']
        delete textMap['x-datadog-parent-id']

        textMap['x-b3-flags'] = '1'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._traceFlags.sampled).to.equal(true)
      })
    })

    describe('with B3 propagation as a single header', () => {
      it('should extract the header', () => {
        textMap['b3'] = '0000000000000123-0000000000000456-1-0000000000000789'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.deep.equal(new SpanContext({
          traceId: platform.id('123', 16),
          spanId: platform.id('456', 16),
          baggageItems,
          traceFlags: {
            sampled: true
          }
        }))
      })

      it('should support unsampled traces', () => {
        delete textMap['x-datadog-trace-id']
        delete textMap['x-datadog-parent-id']

        textMap['b3'] = '0'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._traceFlags.sampled).to.equal(false)
      })

      it('should support sampled traces', () => {
        delete textMap['x-datadog-trace-id']
        delete textMap['x-datadog-parent-id']

        textMap['b3'] = '1'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._traceFlags.sampled).to.equal(true)
      })

      it('should support the debug flag', () => {
        delete textMap['x-datadog-trace-id']
        delete textMap['x-datadog-parent-id']

        textMap['b3'] = 'd'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._traceFlags.sampled).to.equal(true)
      })
    })
  })
})
