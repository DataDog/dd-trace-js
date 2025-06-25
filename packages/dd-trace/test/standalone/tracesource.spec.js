'use strict'

const t = require('tap')
require('../setup/core')

const { assert } = require('chai')
const { ASM } = require('../../src/standalone/product')
const { TRACE_SOURCE_PROPAGATION_KEY } = require('../../src/constants')
const { addTraceSourceTag } = require('../../src/standalone/tracesource')

t.test('Disabled APM Tracing or Standalone - Tracesource propagation tag', t => {
  let tags

  t.beforeEach(() => {
    tags = {}
  })

  t.test('addTraceSourceTag', t => {
    t.test('should not fail', t => {
      assert.notProperty(addTraceSourceTag(tags), TRACE_SOURCE_PROPAGATION_KEY)
      t.end()
    })

    t.test('should not modify original tag value', t => {
      tags[TRACE_SOURCE_PROPAGATION_KEY] = '04'
      assert.propertyVal(addTraceSourceTag(tags), TRACE_SOURCE_PROPAGATION_KEY, '04')
      t.end()
    })

    t.test('should add product', t => {
      assert.propertyVal(addTraceSourceTag(tags, ASM), TRACE_SOURCE_PROPAGATION_KEY, '02')
      t.end()
    })

    t.test('should not modify existing product', t => {
      tags[TRACE_SOURCE_PROPAGATION_KEY] = '02'
      assert.propertyVal(addTraceSourceTag(tags, ASM), TRACE_SOURCE_PROPAGATION_KEY, '02')
      t.end()
    })

    t.test('should add new product to existing product', t => {
      tags[TRACE_SOURCE_PROPAGATION_KEY] = '04'
      assert.propertyVal(addTraceSourceTag(tags, ASM), TRACE_SOURCE_PROPAGATION_KEY, '06')
      t.end()
    })

    t.test('should handle 32 bits tag values', t => {
      const FUTURE_PRODUCT_TAG = ((1 << 31) >>> 0).toString(16) // 80000000
      tags[TRACE_SOURCE_PROPAGATION_KEY] = FUTURE_PRODUCT_TAG

      assert.propertyVal(addTraceSourceTag(tags, ASM), TRACE_SOURCE_PROPAGATION_KEY, '80000002')
      t.end()
    })
    t.end()
  })
  t.end()
})
