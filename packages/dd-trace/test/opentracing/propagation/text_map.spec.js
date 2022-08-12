'use strict'

const id = require('../../../src/id')
const SpanContext = require('../../../src/opentracing/span_context')

const { AUTO_KEEP, AUTO_REJECT, USER_KEEP } = require('../../../../../ext/priority')

describe('TextMapPropagator', () => {
  let TextMapPropagator
  let propagator
  let textMap
  let baggageItems
  let config

  beforeEach(() => {
    TextMapPropagator = require('../../../src/opentracing/propagation/text_map')
    config = { experimental: { b3: false } }
    propagator = new TextMapPropagator(config)
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
        traceId: id('123', 10),
        spanId: id('-456', 10),
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
        traceId: id('123', 10),
        spanId: id('-456', 10),
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
        traceId: id('123', 10),
        spanId: id('-456', 10),
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
        traceId: id('123', 10),
        spanId: id('-456', 10),
        trace: {
          origin: 'synthetics',
          tags: {}
        }
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('x-datadog-origin', 'synthetics')
    })

    it('should inject the trace B3 headers', () => {
      const carrier = {}
      const spanContext = new SpanContext({
        traceId: id('0000000000000123'),
        spanId: id('0000000000000456'),
        parentId: id('0000000000000789'),
        sampling: {
          priority: USER_KEEP
        }
      })

      config.experimental.b3 = true

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('x-b3-traceid', '0000000000000123')
      expect(carrier).to.have.property('x-b3-spanid', '0000000000000456')
      expect(carrier).to.have.property('x-b3-parentspanid', '0000000000000789')
      expect(carrier).to.have.property('x-b3-sampled', '1')
      expect(carrier).to.have.property('x-b3-flags', '1')
    })

    it('should inject the traceparent header', () => {
      const carrier = {}
      const spanContext = new SpanContext({
        traceId: id('1111aaaa2222bbbb3333cccc4444dddd', 16),
        spanId: id('5555eeee6666ffff', 16),
        sampling: {
          priority: USER_KEEP
        }
      })

      config.experimental.traceparent = true

      propagator.inject(spanContext, carrier)

      expect(carrier).to.have.property('traceparent', '01-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01')
    })

    it('should skip injection of B3 headers without the feature flag', () => {
      const carrier = {}
      const spanContext = new SpanContext({
        traceId: id('0000000000000123'),
        spanId: id('0000000000000456')
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.not.have.property('x-b3-traceid')
    })
  })

  describe('extract', () => {
    it('should extract a span context from the carrier', () => {
      const carrier = textMap
      const spanContext = propagator.extract(carrier)

      expect(spanContext).to.deep.equal(new SpanContext({
        traceId: id('123', 10),
        spanId: id('-456', 10),
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
        traceId: id('123', 10),
        spanId: id('-456', 10),
        sampling: {
          priority: AUTO_REJECT
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

    it('should extract from an aws-sqsd header', () => {
      const carrier = {
        'x-aws-sqsd-attr-_datadog': JSON.stringify(textMap)
      }

      const spanContext = propagator.extract(carrier)

      expect(spanContext).to.deep.equal(new SpanContext({
        traceId: id('123', 10),
        spanId: id('-456', 10),
        baggageItems
      }))
    })

    describe('with B3 propagation as multiple headers', () => {
      beforeEach(() => {
        config.experimental.b3 = true

        delete textMap['x-datadog-trace-id']
        delete textMap['x-datadog-parent-id']
      })

      it('should extract the headers', () => {
        textMap['x-b3-traceid'] = '0000000000000123'
        textMap['x-b3-spanid'] = '0000000000000456'
        textMap['x-b3-sampled'] = '1'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.deep.equal(new SpanContext({
          traceId: id('123', 16),
          spanId: id('456', 16),
          sampling: {
            priority: AUTO_KEEP
          }
        }))
      })

      it('should support unsampled traces', () => {
        textMap['x-b3-sampled'] = '0'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._sampling.priority).to.equal(AUTO_REJECT)
      })

      it('should support sampled traces', () => {
        textMap['x-b3-sampled'] = '1'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._sampling.priority).to.equal(AUTO_KEEP)
      })

      it('should support the debug flag', () => {
        textMap['x-b3-flags'] = '1'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._sampling.priority).to.equal(USER_KEEP)
      })

      it('should skip extraction without the feature flag', () => {
        textMap['x-b3-traceid'] = '0000000000000123'
        textMap['x-b3-spanid'] = '0000000000000456'

        config.experimental.b3 = false

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.be.null
      })
    })

    describe('with B3 propagation as a single header', () => {
      beforeEach(() => {
        config.experimental.b3 = true

        delete textMap['x-datadog-trace-id']
        delete textMap['x-datadog-parent-id']
      })

      it('should extract the header', () => {
        textMap['b3'] = '0000000000000123-0000000000000456'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.deep.equal(new SpanContext({
          traceId: id('123', 16),
          spanId: id('456', 16)
        }))
      })

      it('should extract sampling', () => {
        textMap['b3'] = '0000000000000123-0000000000000456-1'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.deep.equal(new SpanContext({
          traceId: id('123', 16),
          spanId: id('456', 16),
          sampling: {
            priority: AUTO_KEEP
          }
        }))
      })

      it('should support the full syntax', () => {
        textMap['b3'] = '0000000000000123-0000000000000456-1-0000000000000789'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.deep.equal(new SpanContext({
          traceId: id('123', 16),
          spanId: id('456', 16),
          sampling: {
            priority: AUTO_KEEP
          }
        }))
      })

      it('should support unsampled traces', () => {
        textMap['b3'] = '0'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._sampling.priority).to.equal(AUTO_REJECT)
      })

      it('should support sampled traces', () => {
        textMap['b3'] = '1'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._sampling.priority).to.equal(AUTO_KEEP)
      })

      it('should support the debug flag', () => {
        textMap['b3'] = 'd'

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        const idExpr = /^[0-9a-f]{16}$/

        expect(spanContext._traceId).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0000000000000000')
        expect(spanContext._spanId).to.be.null
        expect(spanContext._sampling.priority).to.equal(USER_KEEP)
      })

      it('should skip extraction without the feature flag', () => {
        textMap['b3'] = '0000000000000123-0000000000000456-1-0000000000000789'

        config.experimental.b3 = false

        const carrier = textMap
        const spanContext = propagator.extract(carrier)

        expect(spanContext).to.be.null
      })
    })

    describe('With traceparent propagation as single header', () => {
      beforeEach(() => {
        delete textMap['x-datadog-trace-id']
        delete textMap['x-datadog-parent-id']
      })

      it('should skip extraction without the feature flag', () => {
        textMap['traceparent'] = '00-000000000000000000000000000004d2-000000000000162e-01'
        config.experimental.traceparent = false

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        expect(spanContext).to.be.null
      })

      it('should extract the header', () => {
        textMap['traceparent'] = '00-1111aaaa2222bbbb3333cccc4444dddd-5555eeee6666ffff-01'
        config.experimental.traceparent = true

        const carrier = textMap
        const spanContext = propagator.extract(carrier)
        expect(spanContext._traceId.toString(16)).to.equal('1111aaaa2222bbbb3333cccc4444dddd')
        expect(spanContext._spanId.toString(16)).to.equal('5555eeee6666ffff')
        expect(spanContext._sampling.priority).to.equal(AUTO_KEEP)
      })
    })
  })
})
