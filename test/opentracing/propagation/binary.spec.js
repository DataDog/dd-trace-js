'use strict'

const Uint64BE = require('int64-buffer').Uint64BE
const SpanContext = require('../../../src/opentracing/span_context')

describe('BinaryPropagator', () => {
  let BinaryPropagator
  let propagator

  beforeEach(() => {
    BinaryPropagator = require('../../../src/opentracing/propagation/binary')
    propagator = new BinaryPropagator()
  })

  describe('inject', () => {
    it('should not be supported', () => {
      const carrier = {}
      const spanContext = new SpanContext({
        traceId: new Uint64BE(0, 123),
        spanId: new Uint64BE(0, 456)
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.deep.equal(carrier)
    })
  })

  describe('extract', () => {
    it('should not be supported', () => {
      expect(propagator.extract({})).to.equal(null)
    })
  })
})
