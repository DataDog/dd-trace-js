'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')

require('../../setup/core')

const FlagEvalEVPHook = require('../../../src/openfeature/writers/flag_eval_hook')

describe('FlagEvalEVPHook', () => {
  let writer
  let hook

  beforeEach(() => {
    writer = { enqueue: sinon.spy() }
    hook = new FlagEvalEVPHook(writer)
  })

  const lastEnqueued = () => writer.enqueue.firstCall.args[0]

  describe('cheap capture only (async boundary)', () => {
    it('finally() does a single enqueue and nothing else — no aggregation API touched', () => {
      hook.finally(
        { flagKey: 'f', context: { targetingKey: 'u' } },
        { variant: 'on', reason: 'TARGETING_MATCH' }
      )

      sinon.assert.calledOnce(writer.enqueue)
    })

    it('is a no-op when the writer is absent', () => {
      const noWriterHook = new FlagEvalEVPHook(undefined)
      // Must not throw and must not attempt any enqueue.
      noWriterHook.finally({ flagKey: 'f' }, { variant: 'on' })
    })
  })

  describe('G1 — variant comes from evaluationDetails.variant, NOT .value', () => {
    it('emits the OpenFeature variant, not the evaluated value, when they differ', () => {
      hook.finally(
        { flagKey: 'my-flag' },
        { variant: 'on', value: true, reason: 'TARGETING_MATCH' }
      )

      const event = lastEnqueued()
      assert.strictEqual(event.variant, 'on', 'variant must be evaluationDetails.variant')
      assert.notStrictEqual(event.variant, 'true', 'variant must NOT be String(value)')
    })

    it('numeric/boolean values do not leak into variant', () => {
      hook.finally({ flagKey: 'f' }, { variant: 'control', value: 42, reason: 'SPLIT' })
      assert.strictEqual(lastEnqueued().variant, 'control')
    })

    it('absent variant (runtime default) yields empty string even when value is present', () => {
      hook.finally({ flagKey: 'f' }, { variant: undefined, value: false, reason: 'DEFAULT' })
      assert.strictEqual(lastEnqueued().variant, '', 'absent variant signals runtime_default')
    })
  })

  describe('G7 — metadata comes from evaluationDetails.flagMetadata (matching the OTel hook)', () => {
    it('reads allocationKey from evaluationDetails.flagMetadata', () => {
      hook.finally(
        { flagKey: 'f' },
        { variant: 'on', reason: 'TARGETING_MATCH', flagMetadata: { allocationKey: 'alloc-7' } }
      )

      assert.strictEqual(lastEnqueued().allocationKey, 'alloc-7')
    })

    it('does NOT read allocationKey from hookContext (HookContext carries no flagMetadata)', () => {
      // The OpenFeature HookContext has no flagMetadata; only EvaluationDetails does.
      // Putting it on hookContext must be ignored — the value must come from details.
      hook.finally(
        { flagKey: 'f', flagMetadata: { allocationKey: 'from-context' } },
        { variant: 'on', reason: 'TARGETING_MATCH', flagMetadata: { allocationKey: 'from-details' } }
      )

      assert.strictEqual(lastEnqueued().allocationKey, 'from-details',
        'allocationKey must be sourced from evaluationDetails.flagMetadata, not hookContext')
    })

    it('reads dd.eval.timestamp_ms from evaluationDetails.flagMetadata when present', () => {
      hook.finally(
        { flagKey: 'f' },
        { variant: 'on', reason: 'STATIC', flagMetadata: { 'dd.eval.timestamp_ms': 1700000000123 } }
      )

      assert.strictEqual(lastEnqueued().evalTimeMs, 1700000000123)
    })

    it('falls back to hook-fire time when no eval-time stamp is present', () => {
      const before = Date.now()
      hook.finally({ flagKey: 'f' }, { variant: 'on', reason: 'STATIC' })
      const after = Date.now()

      const evalTimeMs = lastEnqueued().evalTimeMs
      assert.ok(evalTimeMs >= before && evalTimeMs <= after,
        'evalTimeMs must fall back to hook-fire Date.now() when unstamped')
    })
  })

  describe('field extraction', () => {
    it('does not include OpenFeature reason in the EVP event snapshot', () => {
      hook.finally({ flagKey: 'f' }, { variant: 'on', reason: 'TARGETING_MATCH' })
      assert.ok(!Object.hasOwn(lastEnqueued(), 'reason'))
    })

    it('does not add a hidden reason value when OpenFeature reason is absent', () => {
      hook.finally({ flagKey: 'f' }, { variant: 'on' })
      assert.ok(!Object.hasOwn(lastEnqueued(), 'reason'))
    })

    it('captures errorMessage without using OpenFeature reason', () => {
      hook.finally(
        { flagKey: 'f' },
        { variant: undefined, reason: 'ERROR', errorMessage: 'type mismatch' }
      )

      const event = lastEnqueued()
      assert.strictEqual(event.errorMessage, 'type mismatch')
      assert.ok(!Object.hasOwn(event, 'reason'))
    })

    it('falls back to errorCode for errorMessage when no message is present', () => {
      hook.finally({ flagKey: 'f' }, { variant: undefined, errorCode: 'FLAG_NOT_FOUND' })

      assert.strictEqual(lastEnqueued().errorMessage, 'FLAG_NOT_FOUND')
    })

    it('reads targetingKey and context attrs from hookContext.context', () => {
      const context = { targetingKey: 'user-1', plan: 'premium' }
      hook.finally({ flagKey: 'f', context }, { variant: 'on', reason: 'SPLIT' })

      const event = lastEnqueued()
      assert.strictEqual(event.targetingKey, 'user-1')
      assert.strictEqual(event.attrs, context)
    })
  })
})
