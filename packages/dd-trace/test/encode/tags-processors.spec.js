'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../setup/core')

const {
  truncateSpan,
  truncateSpanTestOpt,
  MAX_RESOURCE_NAME_LENGTH,
  MAX_META_VALUE_LENGTH_TEST_OPTIMIZATION,
} = require('../../src/encode/tags-processors')

describe('tags-processors', () => {
  describe('truncateSpan', () => {
    it('leaves a resource at the limit untouched and truncates one past it', () => {
      const accepted = 'a'.repeat(MAX_RESOURCE_NAME_LENGTH)
      const overlong = `${'a'.repeat(MAX_RESOURCE_NAME_LENGTH)}X`

      assert.strictEqual(truncateSpan({ resource: accepted }).resource, accepted)
      assert.strictEqual(
        truncateSpan({ resource: overlong }).resource,
        `${overlong.slice(0, MAX_RESOURCE_NAME_LENGTH)}...`
      )
    })
  })

  describe('truncateSpanTestOpt', () => {
    it('truncates resource the same way truncateSpan does', () => {
      const overlong = `${'a'.repeat(MAX_RESOURCE_NAME_LENGTH)}X`
      assert.strictEqual(
        truncateSpanTestOpt({ resource: overlong }).resource,
        `${overlong.slice(0, MAX_RESOURCE_NAME_LENGTH)}...`
      )
    })

    it('leaves a meta value at the limit untouched and truncates one past it', () => {
      const accepted = 'a'.repeat(MAX_META_VALUE_LENGTH_TEST_OPTIMIZATION)
      const overlong = `${'a'.repeat(MAX_META_VALUE_LENGTH_TEST_OPTIMIZATION)}X`

      assert.strictEqual(truncateSpanTestOpt({ meta: { tag: accepted } }).meta.tag, accepted)
      assert.strictEqual(
        truncateSpanTestOpt({ meta: { tag: overlong } }).meta.tag,
        `${overlong.slice(0, MAX_META_VALUE_LENGTH_TEST_OPTIMIZATION)}...`
      )
    })

    it('truncates all overlong meta values independently', () => {
      const overlong = 'b'.repeat(MAX_META_VALUE_LENGTH_TEST_OPTIMIZATION + 1)
      const fine = 'c'.repeat(10)
      const span = { meta: { big: overlong, small: fine } }

      const result = truncateSpanTestOpt(span)
      assert.strictEqual(result.meta.big, `${'b'.repeat(MAX_META_VALUE_LENGTH_TEST_OPTIMIZATION)}...`)
      assert.strictEqual(result.meta.small, fine)
    })

    it('does nothing when meta is absent', () => {
      assert.deepStrictEqual(truncateSpanTestOpt({ resource: 'r' }), { resource: 'r' })
    })
  })
})
