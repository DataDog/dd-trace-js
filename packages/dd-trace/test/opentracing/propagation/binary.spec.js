'use strict'

const t = require('tap')
require('../../setup/core')

const id = require('../../../src/id')
const SpanContext = require('../../../src/opentracing/span_context')

t.test('BinaryPropagator', t => {
  let BinaryPropagator
  let propagator

  t.beforeEach(() => {
    BinaryPropagator = require('../../../src/opentracing/propagation/binary')
    propagator = new BinaryPropagator()
  })

  t.test('inject', t => {
    t.test('should not be supported', t => {
      const carrier = {}
      const spanContext = new SpanContext({
        traceId: id('123', 10),
        spanId: id('456', 10)
      })

      propagator.inject(spanContext, carrier)

      expect(carrier).to.deep.equal(carrier)
      t.end()
    })
    t.end()
  })

  t.test('extract', t => {
    t.test('should not be supported', t => {
      expect(propagator.extract({})).to.equal(null)
      t.end()
    })
    t.end()
  })
  t.end()
})
