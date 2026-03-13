'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')

require('../setup/core')

const {
  buildFeatureFlagTags,
  countFlagTags,
  tagSpansForEvaluation,
} = require('../../src/openfeature/span_tagger')

describe('span_tagger', () => {
  describe('buildFeatureFlagTags', () => {
    it('should build a tag mapping flag key to variant', () => {
      const tags = buildFeatureFlagTags('my-feature-flag', 'control')

      assert.deepStrictEqual(tags, {
        'feature_flags.my-feature-flag': 'control',
      })
    })

    it('should handle flag keys with dots', () => {
      const tags = buildFeatureFlagTags('org.feature.enabled', 'variant-a')

      assert.deepStrictEqual(tags, {
        'feature_flags.org.feature.enabled': 'variant-a',
      })
    })

    it('should handle flag keys with hyphens', () => {
      const tags = buildFeatureFlagTags('my-cool-feature', 'treatment')

      assert.deepStrictEqual(tags, {
        'feature_flags.my-cool-feature': 'treatment',
      })
    })

    it('should return empty tags when variantKey is undefined', () => {
      const tags = buildFeatureFlagTags('flag-1', undefined)

      assert.deepStrictEqual(tags, {})
    })
  })

  describe('tagSpansForEvaluation', () => {
    let activeSpan, traceTags, tracer

    beforeEach(() => {
      traceTags = {}

      const activeContext = {
        _spanId: 'span-2',
        _parentId: 'span-1',
        _trace: { tags: traceTags },
        _tags: {},
      }

      activeSpan = {
        addTags (tags) { Object.assign(activeContext._tags, tags) },
        get _tags () { return activeContext._tags },
        context: () => activeContext,
      }

      tracer = {
        scope: () => ({
          active: () => activeSpan,
        }),
      }
    })

    it('should tag the active span', () => {
      tagSpansForEvaluation(tracer, {
        flagKey: 'test-flag',
        variantKey: 'control',
      })

      assert.deepStrictEqual(activeSpan._tags, {
        'feature_flags.test-flag': 'control',
      })
    })

    it('should add tags to _trace.tags for trace-level propagation', () => {
      tagSpansForEvaluation(tracer, {
        flagKey: 'test-flag',
        variantKey: 'control',
      })

      assert.deepStrictEqual(traceTags, {
        'feature_flags.test-flag': 'control',
      })
    })

    it('should be a no-op when there is no active span', () => {
      const noActiveTracer = {
        scope: () => ({
          active: () => undefined,
        }),
      }

      // Should not throw
      tagSpansForEvaluation(noActiveTracer, {
        flagKey: 'test-flag',
        variantKey: 'control',
      })
    })

    it('should handle undefined variant gracefully', () => {
      tagSpansForEvaluation(tracer, {
        flagKey: 'test-flag',
        variantKey: undefined,
      })

      assert.deepStrictEqual(activeSpan._tags, {})
      assert.deepStrictEqual(traceTags, {})
    })

    it('should skip tagging when maxFlagTags is reached', () => {
      tagSpansForEvaluation(tracer, { flagKey: 'flag-1', variantKey: 'v1', maxFlagTags: 2 })
      tagSpansForEvaluation(tracer, { flagKey: 'flag-2', variantKey: 'v2', maxFlagTags: 2 })
      tagSpansForEvaluation(tracer, { flagKey: 'flag-3', variantKey: 'v3', maxFlagTags: 2 })

      assert.strictEqual(countFlagTags(activeSpan), 2)
      assert.strictEqual(traceTags['feature_flags.flag-1'], 'v1')
      assert.strictEqual(traceTags['feature_flags.flag-2'], 'v2')
      assert.strictEqual(traceTags['feature_flags.flag-3'], undefined)
    })

    it('should not enforce limit when maxFlagTags is undefined', () => {
      for (let i = 0; i < 5; i++) {
        tagSpansForEvaluation(tracer, { flagKey: `flag-${i}`, variantKey: `v${i}` })
      }

      assert.strictEqual(countFlagTags(activeSpan), 5)
    })
  })
})
