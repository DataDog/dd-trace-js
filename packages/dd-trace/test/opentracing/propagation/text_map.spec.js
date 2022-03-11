'use strict'

const { AUTO_KEEP, AUTO_REJECT, USER_KEEP } = require('../../../../../ext/priority')
const { expect } = require('chai')

const idExpr = /^[0-9a-f]+$/

describe('TextMapPropagator', () => {
  let tracer
  let config

  beforeEach(() => {
    config = { experimental: { b3: false }, plugins: false }
    tracer = require('../../../../..')
    tracer.init(config)
  })

  describe('inject', () => {
    let span
    let spanContext
    let carrier

    beforeEach(() => {
      span = tracer.startSpan('test')
      spanContext = span.context()
      carrier = {}
    })

    it('should inject the span context into the carrier', () => {
      span.setBaggageItem('foo', 'bar')

      tracer.inject(spanContext, 'text_map', carrier)

      expect(carrier).to.have.property('x-datadog-trace-id', spanContext.toTraceId())
      expect(carrier).to.have.property('x-datadog-parent-id', spanContext.toSpanId())
      expect(carrier).to.have.property('ot-baggage-foo', 'bar')
    })

    it('should handle non-string values', () => {
      span.setBaggageItem('number', 1.23)
      span.setBaggageItem('bool', true)
      span.setBaggageItem('array', ['foo', 'bar'])
      span.setBaggageItem('object', {})

      tracer.inject(spanContext, 'text_map', carrier)

      expect(carrier['ot-baggage-number']).to.equal('1.23')
      expect(carrier['ot-baggage-bool']).to.equal('true')
      expect(carrier['ot-baggage-array']).to.equal('foo,bar')
      expect(carrier['ot-baggage-object']).to.equal('[object Object]')
    })

    it('should inject an existing sampling priority', () => {
      spanContext._sampling.priority = 0

      tracer.inject(spanContext, 'text_map', carrier)

      expect(carrier).to.have.property('x-datadog-sampling-priority', '0')
    })

    it('should inject the origin', () => {
      spanContext._trace.origin = 'synthetics'

      tracer.inject(spanContext, 'text_map', carrier)

      expect(carrier).to.have.property('x-datadog-origin', 'synthetics')
    })

    it('should inject the trace B3 headers', () => {
      const childOf = tracer.startSpan('parent')
      span = tracer.startSpan('child', { childOf })
      spanContext = span.context()
      spanContext._sampling.priority = 2

      config.experimental.b3 = true
      tracer.init(config)
      tracer.inject(spanContext, 'text_map', carrier)

      expect(carrier).to.have.property('x-b3-traceid', spanContext._traceId.toString(16).padStart(32, '0'))
      expect(carrier).to.have.property('x-b3-spanid', spanContext._spanId.toString(16).padStart(16, '0'))
      expect(carrier).to.have.property('x-b3-parentspanid', childOf.context()._spanId.toString(16).padStart(16, '0'))
      expect(carrier).to.have.property('x-b3-sampled', '1')
      expect(carrier).to.have.property('x-b3-flags', '1')
    })

    it('should skip injection of B3 headers without the feature flag', () => {
      tracer.inject(spanContext, 'text_map', carrier)

      expect(carrier).to.not.have.property('x-b3-traceid')
    })
  })

  describe('extract', () => {
    let carrier

    beforeEach(() => {
      carrier = {
        'x-datadog-trace-id': '123',
        'x-datadog-parent-id': '18446744073709551160', // -456 casted to uint64
        'ot-baggage-foo': 'bar'
      }
    })

    it('should extract a span context from the carrier', () => {
      const spanContext = tracer.extract('text_map', carrier)

      expect(spanContext._traceId.toString()).to.equal(carrier['x-datadog-trace-id'])
      expect(spanContext._spanId.toString()).to.equal(carrier['x-datadog-parent-id'])
      expect(spanContext._baggageItems).to.have.property('foo', 'bar')
    })

    it('should return null if the carrier does not contain a trace', () => {
      const carrier = {}
      const spanContext = tracer.extract(carrier)

      expect(spanContext).to.equal(null)
    })

    it('should extract a span context with a valid sampling priority', () => {
      carrier['x-datadog-sampling-priority'] = '0'

      const spanContext = tracer.extract('text_map', carrier)

      expect(spanContext._sampling.priority).to.equal(AUTO_REJECT)
    })

    it('should extract the origin', () => {
      carrier['x-datadog-origin'] = 'synthetics'

      const spanContext = tracer.extract('text_map', carrier)

      expect(spanContext._trace).to.have.property('origin', 'synthetics')
    })

    describe('with B3 propagation as multiple headers', () => {
      beforeEach(() => {
        config.experimental.b3 = true
        tracer.init(config)

        delete carrier['x-datadog-trace-id']
        delete carrier['x-datadog-parent-id']
      })

      it('should extract the headers', () => {
        carrier = {
          'x-b3-traceid': '0000000000000123',
          'x-b3-spanid': '0000000000000456',
          'x-b3-sampled': '1'
        }

        const spanContext = tracer.extract('text_map', carrier)

        expect(spanContext._traceId.toString(16)).to.equal('123')
        expect(spanContext._spanId.toString(16)).to.equal('456')
        expect(spanContext._sampling.priority).to.equal(AUTO_KEEP)
      })

      it('should support unsampled traces', () => {
        carrier = {
          'x-b3-sampled': '0'
        }

        const spanContext = tracer.extract('text_map', carrier)

        expect(spanContext._traceId.toString(16)).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0')
        expect(spanContext._spanId.toString()).to.equal('0')
        expect(spanContext._sampling.priority).to.equal(AUTO_REJECT)
      })

      it('should support sampled traces', () => {
        carrier = {
          'x-b3-sampled': '1'
        }

        const spanContext = tracer.extract('text_map', carrier)

        expect(spanContext._traceId.toString(16)).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0')
        expect(spanContext._spanId.toString()).to.equal('0')
        expect(spanContext._sampling.priority).to.equal(AUTO_KEEP)
      })

      it('should support the debug flag', () => {
        carrier = {
          'x-b3-flags': '1'
        }

        const spanContext = tracer.extract('text_map', carrier)

        expect(spanContext._traceId.toString(16)).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0')
        expect(spanContext._spanId.toString()).to.equal('0')
        expect(spanContext._sampling.priority).to.equal(USER_KEEP)
      })

      it('should skip extraction without the feature flag', () => {
        config.experimental.b3 = false
        tracer.init(config)

        carrier = {
          'x-b3-traceid': '0000000000000123',
          'x-b3-spanid': '0000000000000456',
          'x-b3-sampled': '1'
        }

        const spanContext = tracer.extract('text_map', carrier)

        expect(spanContext).to.be.null
      })
    })

    describe('with B3 propagation as a single header', () => {
      beforeEach(() => {
        config.experimental.b3 = true
        tracer.init(config)
      })

      it('should extract the header', () => {
        carrier = {
          'b3': '0000000000000123-0000000000000456'
        }

        const spanContext = tracer.extract('text_map', carrier)

        expect(spanContext._traceId.toString(16)).to.equal('123')
        expect(spanContext._spanId.toString(16)).to.equal('456')
      })

      it('should extract sampling', () => {
        carrier = {
          'b3': '0000000000000123-0000000000000456-1'
        }

        const spanContext = tracer.extract('text_map', carrier)

        expect(spanContext._traceId.toString(16)).to.equal('123')
        expect(spanContext._spanId.toString(16)).to.equal('456')
        expect(spanContext._sampling.priority).to.equal(AUTO_KEEP)
      })

      it('should support the full syntax', () => {
        carrier = {
          'b3': '0000000000000123-0000000000000456-1-0000000000000789'
        }

        const spanContext = tracer.extract('text_map', carrier)

        expect(spanContext._traceId.toString(16)).to.equal('123')
        expect(spanContext._spanId.toString(16)).to.equal('456')
        expect(spanContext._sampling.priority).to.equal(AUTO_KEEP)
      })

      it('should support unsampled traces', () => {
        carrier = {
          'b3': '0'
        }

        const spanContext = tracer.extract('text_map', carrier)

        expect(spanContext._traceId.toString(16)).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0')
        expect(spanContext._spanId.toString()).to.equal('0')
        expect(spanContext._sampling.priority).to.equal(AUTO_REJECT)
      })

      it('should support sampled traces', () => {
        carrier = {
          'b3': '1'
        }

        const spanContext = tracer.extract('text_map', carrier)

        expect(spanContext._traceId.toString(16)).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0')
        expect(spanContext._spanId.toString()).to.equal('0')
        expect(spanContext._sampling.priority).to.equal(AUTO_KEEP)
      })

      it('should support the debug flag', () => {
        carrier = {
          'b3': 'd'
        }

        const spanContext = tracer.extract('text_map', carrier)

        expect(spanContext._traceId.toString(16)).to.match(idExpr)
        expect(spanContext._traceId.toString()).to.not.equal('0')
        expect(spanContext._spanId.toString()).to.equal('0')
        expect(spanContext._sampling.priority).to.equal(USER_KEEP)
      })

      it('should skip extraction without the feature flag', () => {
        config.experimental.b3 = false
        tracer.init(config)

        carrier = {
          'b3': '0000000000000123-0000000000000456-1-0000000000000789'
        }

        const spanContext = tracer.extract('text_map', carrier)

        expect(spanContext).to.be.null
      })
    })
  })
})
