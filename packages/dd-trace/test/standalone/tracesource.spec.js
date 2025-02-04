'use strict'

require('../setup/tap')

const { assert } = require('chai')
const { ASM } = require('../../src/standalone/product')
const { TRACE_SOURCE_PROPAGATION_KEY } = require('../../src/constants')
const { addTraceSourceTag } = require('../../src/standalone/tracesource')

describe('Tracesource propagation tag', () => {
  let tags

  beforeEach(() => {
    tags = {}
  })

  describe('addTraceSourceTag', () => {
    it('should not fail', () => {
      assert.propertyVal(addTraceSourceTag(tags), TRACE_SOURCE_PROPAGATION_KEY, '00')
    })

    it('should add product', () => {
      assert.propertyVal(addTraceSourceTag(tags, ASM), TRACE_SOURCE_PROPAGATION_KEY, '02')
    })

    it('should not modify existing product', () => {
      tags[TRACE_SOURCE_PROPAGATION_KEY] = '02'
      assert.propertyVal(addTraceSourceTag(tags, ASM), TRACE_SOURCE_PROPAGATION_KEY, '02')
    })

    it('should add new product to existing product', () => {
      tags[TRACE_SOURCE_PROPAGATION_KEY] = '04'
      assert.propertyVal(addTraceSourceTag(tags, ASM), TRACE_SOURCE_PROPAGATION_KEY, '06')
    })
  })
})
