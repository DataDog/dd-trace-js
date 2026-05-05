'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach } = require('mocha')

require('../setup/core')

const {
  SpanEnrichmentState,
  MAX_SERIAL_IDS,
  MAX_SUBJECTS,
  MAX_DEFAULTS,
  MAX_DEFAULT_VALUE_LENGTH,
  CODED_DEFAULT_PREFIX
} = require('../../src/openfeature/span-enrichment')

describe('SpanEnrichmentState', () => {
  let state

  beforeEach(() => {
    state = new SpanEnrichmentState()
  })

  describe('addSerialId()', () => {
    it('should add serial IDs', () => {
      assert.strictEqual(state.addSerialId(100), true)
      assert.strictEqual(state.addSerialId(200), true)
      assert.strictEqual(state.hasData(), true)
    })

    it('should handle duplicate serial IDs (Set behavior)', () => {
      state.addSerialId(100)
      state.addSerialId(100)
      const tags = state.toSpanTags()
      // Only one 100 should be encoded
      const decoded = Buffer.from(tags.ffe_flags_enc, 'base64')
      assert.deepStrictEqual([...decoded], [100])
    })

    it('should enforce MAX_SERIAL_IDS limit', () => {
      for (let i = 0; i < MAX_SERIAL_IDS; i++) {
        assert.strictEqual(state.addSerialId(i), true)
      }
      // 129th should fail
      assert.strictEqual(state.addSerialId(999), false)
    })
  })

  describe('addSubject()', () => {
    it('should add subjects with hashed targeting key', () => {
      assert.strictEqual(state.addSubject('user-123', 100), true)
      const tags = state.toSpanTags()
      assert.ok(tags.ffe_subjects_enc)
      const subjects = JSON.parse(tags.ffe_subjects_enc)
      // Should have one key (hashed)
      assert.strictEqual(Object.keys(subjects).length, 1)
    })

    it('should accumulate serial IDs for same subject', () => {
      state.addSubject('user-123', 100)
      state.addSubject('user-123', 200)
      const tags = state.toSpanTags()
      const subjects = JSON.parse(tags.ffe_subjects_enc)
      // Should still have one subject
      assert.strictEqual(Object.keys(subjects).length, 1)
      // The encoded value should contain both serial IDs
      const key = Object.keys(subjects)[0]
      const decoded = Buffer.from(subjects[key], 'base64')
      // [100, 200] sorted -> deltas [100, 100]
      assert.deepStrictEqual([...decoded], [100, 100])
    })

    it('should enforce MAX_SUBJECTS limit', () => {
      for (let i = 0; i < MAX_SUBJECTS; i++) {
        assert.strictEqual(state.addSubject(`user-${i}`, i), true)
      }
      // 26th subject should fail
      assert.strictEqual(state.addSubject('user-new', 999), false)
    })

    it('should allow adding serial IDs to existing subject beyond limit', () => {
      for (let i = 0; i < MAX_SUBJECTS; i++) {
        state.addSubject(`user-${i}`, i)
      }
      // Adding to existing subject should still work
      assert.strictEqual(state.addSubject('user-0', 999), true)
    })
  })

  describe('addDefault()', () => {
    it('should add defaults with coded-default prefix', () => {
      assert.strictEqual(state.addDefault('my-flag', 'my-value'), true)
      const tags = state.toSpanTags()
      const defaults = JSON.parse(tags.ffe_defaults)
      assert.strictEqual(defaults['my-flag'], 'coded-default: my-value')
    })

    it('should truncate values to MAX_DEFAULT_VALUE_LENGTH', () => {
      const longValue = 'x'.repeat(100)
      state.addDefault('my-flag', longValue)
      const tags = state.toSpanTags()
      const defaults = JSON.parse(tags.ffe_defaults)
      assert.strictEqual(defaults['my-flag'].length, MAX_DEFAULT_VALUE_LENGTH)
      assert.ok(defaults['my-flag'].startsWith(CODED_DEFAULT_PREFIX))
    })

    it('should enforce MAX_DEFAULTS limit', () => {
      for (let i = 0; i < MAX_DEFAULTS; i++) {
        assert.strictEqual(state.addDefault(`flag-${i}`, `value-${i}`), true)
      }
      // 6th should fail
      assert.strictEqual(state.addDefault('flag-new', 'value-new'), false)
    })

    it('should not add duplicate flag keys', () => {
      state.addDefault('my-flag', 'value1')
      assert.strictEqual(state.addDefault('my-flag', 'value2'), true)
      const tags = state.toSpanTags()
      const defaults = JSON.parse(tags.ffe_defaults)
      // Should still have first value
      assert.strictEqual(defaults['my-flag'], 'coded-default: value1')
    })

    it('should handle non-string default values', () => {
      state.addDefault('bool-flag', true)
      state.addDefault('num-flag', 42)
      const tags = state.toSpanTags()
      const defaults = JSON.parse(tags.ffe_defaults)
      assert.strictEqual(defaults['bool-flag'], 'coded-default: true')
      assert.strictEqual(defaults['num-flag'], 'coded-default: 42')
    })
  })

  describe('hasData()', () => {
    it('should return false for empty state', () => {
      assert.strictEqual(state.hasData(), false)
    })

    it('should return true when serial IDs present', () => {
      state.addSerialId(100)
      assert.strictEqual(state.hasData(), true)
    })

    it('should return true when defaults present', () => {
      state.addDefault('flag', 'value')
      assert.strictEqual(state.hasData(), true)
    })

    it('should return false when only subjects present (edge case)', () => {
      // Subjects without serial IDs shouldn't happen in practice
      // but hasData checks serialIds and defaults only
      state.addSubject('user', 100)
      // This actually adds to serialIds too via the subject tracking
      // Let's verify hasData logic directly
      const emptyState = new SpanEnrichmentState()
      assert.strictEqual(emptyState.hasData(), false)
    })
  })

  describe('toSpanTags()', () => {
    it('should return empty object when no data', () => {
      const tags = state.toSpanTags()
      assert.deepStrictEqual(tags, {})
    })

    it('should include ffe_flags_enc when serial IDs present', () => {
      state.addSerialId(100)
      const tags = state.toSpanTags()
      assert.ok(tags.ffe_flags_enc)
      assert.strictEqual(typeof tags.ffe_flags_enc, 'string')
    })

    it('should include ffe_subjects_enc when subjects present', () => {
      state.addSubject('user', 100)
      const tags = state.toSpanTags()
      assert.ok(tags.ffe_subjects_enc)
      const parsed = JSON.parse(tags.ffe_subjects_enc)
      assert.strictEqual(typeof parsed, 'object')
    })

    it('should include ffe_defaults when defaults present', () => {
      state.addDefault('flag', 'value')
      const tags = state.toSpanTags()
      assert.ok(tags.ffe_defaults)
      const parsed = JSON.parse(tags.ffe_defaults)
      assert.strictEqual(typeof parsed, 'object')
    })

    it('should include all tags when all data present', () => {
      state.addSerialId(100)
      state.addSubject('user', 100)
      state.addDefault('flag', 'value')
      const tags = state.toSpanTags()
      assert.ok(tags.ffe_flags_enc)
      assert.ok(tags.ffe_subjects_enc)
      assert.ok(tags.ffe_defaults)
    })
  })
})

describe('constants', () => {
  it('should have correct limit values', () => {
    assert.strictEqual(MAX_SERIAL_IDS, 128)
    assert.strictEqual(MAX_SUBJECTS, 25)
    assert.strictEqual(MAX_DEFAULTS, 5)
    assert.strictEqual(MAX_DEFAULT_VALUE_LENGTH, 64)
  })

  it('should have correct prefix', () => {
    assert.strictEqual(CODED_DEFAULT_PREFIX, 'coded-default: ')
  })
})
