'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

require('../setup/core')

const {
  truncateSpan,
  MAX_META_KEY_LENGTH,
  MAX_METRIC_KEY_LENGTH,
} = require('../../src/encode/tags-processors')

describe('tags-processors', () => {
  describe('truncateSpan', () => {
    it('writes a truncated meta key back to span.meta and not span.metrics', () => {
      const longKey = 'a'.repeat(MAX_META_KEY_LENGTH + 50)
      const expectedKey = `${'a'.repeat(MAX_META_KEY_LENGTH)}...`
      const span = {
        meta: { [longKey]: 'value' },
        metrics: {},
      }

      truncateSpan(span)

      assert.deepStrictEqual(span.meta, { [expectedKey]: 'value' })
      assert.deepStrictEqual(span.metrics, {})
    })

    it('writes a truncated metric key back to span.metrics and not span.meta', () => {
      const longKey = 'b'.repeat(MAX_METRIC_KEY_LENGTH + 50)
      const expectedKey = `${'b'.repeat(MAX_METRIC_KEY_LENGTH)}...`
      const span = {
        meta: {},
        metrics: { [longKey]: 42 },
      }

      truncateSpan(span)

      assert.deepStrictEqual(span.meta, {})
      assert.deepStrictEqual(span.metrics, { [expectedKey]: 42 })
    })
  })
})
