'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach } = require('tap').mocha

require('../../setup/core')

const id = require('../../../src/id')
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
        traceId: id('123', 10),
        spanId: id('456', 10)
      })

      propagator.inject(spanContext, carrier)

      assert.deepStrictEqual(carrier, carrier)
    })
  })

  describe('extract', () => {
    it('should not be supported', () => {
      assert.strictEqual(propagator.extract({}), null)
    })
  })
})
