'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')

require('../setup/core')
const { ASM } = require('../../src/standalone/product')
const { TRACE_SOURCE_PROPAGATION_KEY } = require('../../src/constants')
const { addTraceSourceTag } = require('../../src/standalone/tracesource')

describe('Disabled APM Tracing or Standalone - Tracesource propagation tag', () => {
  let tags

  beforeEach(() => {
    tags = {}
  })

  describe('addTraceSourceTag', () => {
    it('should not fail', () => {
      assert.ok(!(TRACE_SOURCE_PROPAGATION_KEY in addTraceSourceTag(tags)))
    })

    it('should not modify original tag value', () => {
      tags[TRACE_SOURCE_PROPAGATION_KEY] = '04'
      assert.strictEqual(addTraceSourceTag(tags)[TRACE_SOURCE_PROPAGATION_KEY], '04')
    })

    it('should add product', () => {
      assert.strictEqual(addTraceSourceTag(tags, ASM)[TRACE_SOURCE_PROPAGATION_KEY], '02')
    })

    it('should not modify existing product', () => {
      tags[TRACE_SOURCE_PROPAGATION_KEY] = '02'
      assert.strictEqual(addTraceSourceTag(tags, ASM)[TRACE_SOURCE_PROPAGATION_KEY], '02')
    })

    it('should add new product to existing product', () => {
      tags[TRACE_SOURCE_PROPAGATION_KEY] = '04'
      assert.strictEqual(addTraceSourceTag(tags, ASM)[TRACE_SOURCE_PROPAGATION_KEY], '06')
    })

    it('should handle 32 bits tag values', () => {
      const FUTURE_PRODUCT_TAG = ((1 << 31) >>> 0).toString(16) // 80000000
      tags[TRACE_SOURCE_PROPAGATION_KEY] = FUTURE_PRODUCT_TAG

      assert.strictEqual(addTraceSourceTag(tags, ASM)[TRACE_SOURCE_PROPAGATION_KEY], '80000002')
    })
  })
})
