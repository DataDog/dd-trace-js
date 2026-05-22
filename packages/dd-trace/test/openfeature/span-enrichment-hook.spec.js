'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

describe('SpanEnrichmentHook', () => {
  let SpanEnrichmentHook
  let mockTracer
  let mockSpan
  let mockRootSpan
  let mockScope
  let mockFinishChannel
  let finishSubscriber
  let log

  beforeEach(() => {
    // Create mock spans
    mockRootSpan = {
      context: sinon.stub().returns({
        _parentId: null,
        _trace: null,
      }),
      setTag: sinon.spy(),
    }

    mockSpan = {
      context: sinon.stub().returns({
        _parentId: 'parent-123',
        _trace: {
          started: [mockRootSpan, { context: () => ({ _parentId: 'parent-123' }) }],
        },
      }),
      setTag: sinon.spy(),
    }

    mockScope = {
      active: sinon.stub().returns(mockSpan),
    }

    mockTracer = {
      scope: sinon.stub().returns(mockScope),
    }

    // Capture the subscriber function when subscribe is called
    finishSubscriber = null
    mockFinishChannel = {
      subscribe: sinon.stub().callsFake((fn) => {
        finishSubscriber = fn
      }),
      unsubscribe: sinon.spy(),
    }

    log = {
      warn: sinon.spy(),
      debug: sinon.spy(),
    }

    SpanEnrichmentHook = proxyquire('../../src/openfeature/span-enrichment-hook', {
      'dc-polyfill': {
        channel: sinon.stub().returns(mockFinishChannel),
      },
      '../log': log,
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  function hookContext (overrides = {}) {
    return {
      flagKey: 'test-flag',
      context: { targetingKey: 'user-123' },
      ...overrides,
    }
  }

  function evalDetails (overrides = {}) {
    return {
      flagMetadata: { __dd_split_serial_id: 100, __dd_do_log: false },
      reason: 'TARGETING_MATCH',
      value: true,
      ...overrides,
    }
  }

  describe('constructor', () => {
    it('should subscribe to span finish channel', () => {
      new SpanEnrichmentHook(mockTracer) // eslint-disable-line no-new

      sinon.assert.calledOnce(mockFinishChannel.subscribe)
      assert.strictEqual(typeof finishSubscriber, 'function')
    })
  })

  describe('finally()', () => {
    it('should do nothing when no active span', () => {
      mockScope.active.returns(null)
      const hook = new SpanEnrichmentHook(mockTracer)

      hook.finally(hookContext(), evalDetails())

      // Should not throw and should not have any state
      sinon.assert.notCalled(log.warn)
    })

    it('should add serial ID when present in flagMetadata', () => {
      const hook = new SpanEnrichmentHook(mockTracer)

      hook.finally(hookContext(), evalDetails({ flagMetadata: { __dd_split_serial_id: 42 } }))

      // Trigger span finish to verify state was accumulated
      finishSubscriber(mockRootSpan)

      sinon.assert.called(mockRootSpan.setTag)
      const tagCall = mockRootSpan.setTag.getCalls().find(c => c.args[0] === 'ffe_flags_enc')
      assert.ok(tagCall, 'ffe_flags_enc tag should be set')
    })

    it('should add subject when __dd_do_log is true and targetingKey present', () => {
      const hook = new SpanEnrichmentHook(mockTracer)

      hook.finally(
        hookContext({ context: { targetingKey: 'user-456' } }),
        evalDetails({ flagMetadata: { __dd_split_serial_id: 100, __dd_do_log: true } })
      )

      finishSubscriber(mockRootSpan)

      const tagCall = mockRootSpan.setTag.getCalls().find(c => c.args[0] === 'ffe_subjects_enc')
      assert.ok(tagCall, 'ffe_subjects_enc tag should be set')
      const subjects = JSON.parse(tagCall.args[1])
      assert.strictEqual(Object.keys(subjects).length, 1)
    })

    it('should not add subject when __dd_do_log is false', () => {
      const hook = new SpanEnrichmentHook(mockTracer)

      hook.finally(
        hookContext({ context: { targetingKey: 'user-456' } }),
        evalDetails({ flagMetadata: { __dd_split_serial_id: 100, __dd_do_log: false } })
      )

      finishSubscriber(mockRootSpan)

      const tagCall = mockRootSpan.setTag.getCalls().find(c => c.args[0] === 'ffe_subjects_enc')
      assert.strictEqual(tagCall, undefined, 'ffe_subjects_enc should not be set when doLog is false')
    })

    it('should not add subject when targetingKey is missing', () => {
      const hook = new SpanEnrichmentHook(mockTracer)

      hook.finally(
        hookContext({ context: {} }),
        evalDetails({ flagMetadata: { __dd_split_serial_id: 100, __dd_do_log: true } })
      )

      finishSubscriber(mockRootSpan)

      const tagCall = mockRootSpan.setTag.getCalls().find(c => c.args[0] === 'ffe_subjects_enc')
      assert.strictEqual(tagCall, undefined, 'ffe_subjects_enc should not be set without targetingKey')
    })

    it('should add default when reason is DEFAULT and no serialId', () => {
      const hook = new SpanEnrichmentHook(mockTracer)

      hook.finally(
        hookContext({ flagKey: 'missing-flag' }),
        evalDetails({ flagMetadata: {}, reason: 'DEFAULT', value: 'fallback' })
      )

      finishSubscriber(mockRootSpan)

      const tagCall = mockRootSpan.setTag.getCalls().find(c => c.args[0] === 'ffe_runtime_defaults')
      assert.ok(tagCall, 'ffe_runtime_defaults tag should be set')
      const defaults = JSON.parse(tagCall.args[1])
      assert.strictEqual(defaults['missing-flag'], 'fallback')
    })

    it('should add default when reason is ERROR and no serialId', () => {
      const hook = new SpanEnrichmentHook(mockTracer)

      hook.finally(
        hookContext({ flagKey: 'error-flag' }),
        evalDetails({ flagMetadata: {}, reason: 'ERROR', value: false })
      )

      finishSubscriber(mockRootSpan)

      const tagCall = mockRootSpan.setTag.getCalls().find(c => c.args[0] === 'ffe_runtime_defaults')
      assert.ok(tagCall, 'ffe_runtime_defaults tag should be set')
      const defaults = JSON.parse(tagCall.args[1])
      assert.strictEqual(defaults['error-flag'], 'false')
    })

    it('should not add default when serialId is present', () => {
      const hook = new SpanEnrichmentHook(mockTracer)

      hook.finally(
        hookContext(),
        evalDetails({ flagMetadata: { __dd_split_serial_id: 100 }, reason: 'DEFAULT', value: 'ignored' })
      )

      finishSubscriber(mockRootSpan)

      const tagCall = mockRootSpan.setTag.getCalls().find(c => c.args[0] === 'ffe_runtime_defaults')
      assert.strictEqual(tagCall, undefined, 'ffe_runtime_defaults should not be set when serialId present')
    })

    it('should accumulate multiple flag evaluations on same span', () => {
      const hook = new SpanEnrichmentHook(mockTracer)

      hook.finally(hookContext(), evalDetails({ flagMetadata: { __dd_split_serial_id: 100 } }))
      hook.finally(hookContext(), evalDetails({ flagMetadata: { __dd_split_serial_id: 200 } }))
      hook.finally(hookContext(), evalDetails({ flagMetadata: { __dd_split_serial_id: 300 } }))

      finishSubscriber(mockRootSpan)

      const tagCall = mockRootSpan.setTag.getCalls().find(c => c.args[0] === 'ffe_flags_enc')
      assert.ok(tagCall, 'ffe_flags_enc should be set')
      // Decode to verify all 3 IDs are present
      const decoded = Buffer.from(tagCall.args[1], 'base64')
      // [100, 200, 300] sorted -> deltas [100, 100, 100]
      assert.deepStrictEqual([...decoded], [100, 100, 100])
    })

    it('should handle null/undefined inputs gracefully', () => {
      const hook = new SpanEnrichmentHook(mockTracer)

      hook.finally(null, evalDetails())
      hook.finally(hookContext(), null)
      hook.finally(hookContext(), { reason: 'TARGETING_MATCH' })

      sinon.assert.notCalled(log.warn)
    })

    it('should catch and log errors', () => {
      const hook = new SpanEnrichmentHook(mockTracer)
      // Force an error by making context() throw
      mockSpan.context.throws(new Error('context error'))

      hook.finally(hookContext(), evalDetails())

      sinon.assert.calledOnce(log.warn)
      assert.ok(
        log.warn.firstCall.args[1].includes('context error'),
        `Expected warning message to include 'context error', got: ${log.warn.firstCall.args[1]}`
      )
    })
  })

  describe('_getRootSpan()', () => {
    it('should return null when no active span', () => {
      mockScope.active.returns(null)
      const hook = new SpanEnrichmentHook(mockTracer)

      const result = hook._getRootSpan()

      assert.strictEqual(result, null)
    })

    it('should return current span when no trace object', () => {
      mockSpan.context.returns({ _parentId: 'parent', _trace: null })
      const hook = new SpanEnrichmentHook(mockTracer)

      const result = hook._getRootSpan()

      assert.strictEqual(result, mockSpan)
    })

    it('should return current span when trace.started is missing', () => {
      mockSpan.context.returns({ _parentId: 'parent', _trace: {} })
      const hook = new SpanEnrichmentHook(mockTracer)

      const result = hook._getRootSpan()

      assert.strictEqual(result, mockSpan)
    })

    it('should find root span in trace.started array', () => {
      const hook = new SpanEnrichmentHook(mockTracer)

      const result = hook._getRootSpan()

      assert.strictEqual(result, mockRootSpan)
    })

    it('should return first span in trace.started as root', () => {
      const firstSpan = { context: () => ({ _parentId: null }) }
      const secondSpan = { context: () => ({ _parentId: 'p1' }) }
      mockSpan.context.returns({
        _parentId: 'parent',
        _trace: {
          started: [firstSpan, secondSpan],
        },
      })
      const hook = new SpanEnrichmentHook(mockTracer)

      const result = hook._getRootSpan()

      assert.strictEqual(result, firstSpan)
    })
  })

  describe('_getOrCreateState()', () => {
    it('should create new state for span', () => {
      const hook = new SpanEnrichmentHook(mockTracer)

      const state1 = hook._getOrCreateState(mockSpan)
      const state2 = hook._getOrCreateState(mockSpan)

      assert.strictEqual(state1, state2, 'Should return same state for same span')
    })

    it('should create different state for different spans', () => {
      const hook = new SpanEnrichmentHook(mockTracer)
      const otherSpan = { context: () => ({}) }

      const state1 = hook._getOrCreateState(mockSpan)
      const state2 = hook._getOrCreateState(otherSpan)

      assert.notStrictEqual(state1, state2, 'Should return different state for different spans')
    })
  })

  describe('_onSpanFinish()', () => {
    it('should do nothing when span has no state', () => {
      new SpanEnrichmentHook(mockTracer) // eslint-disable-line no-new

      finishSubscriber(mockSpan)

      sinon.assert.notCalled(mockSpan.setTag)
    })

    it('should do nothing when state has no data', () => {
      const hook = new SpanEnrichmentHook(mockTracer)
      // Create empty state
      hook._getOrCreateState(mockSpan)

      finishSubscriber(mockSpan)

      sinon.assert.notCalled(mockSpan.setTag)
    })

    it('should apply all tag types when present', () => {
      const hook = new SpanEnrichmentHook(mockTracer)
      const state = hook._getOrCreateState(mockSpan)
      state.addSerialId(100)
      state.addSubject('user-123', 100)
      state.addDefault('flag-key', 'value')

      finishSubscriber(mockSpan)

      assert.strictEqual(mockSpan.setTag.callCount, 3)
      const tagNames = mockSpan.setTag.getCalls().map(c => c.args[0])
      assert.ok(tagNames.includes('ffe_flags_enc'), `Expected tagNames to include 'ffe_flags_enc', got: ${tagNames}`)
      assert.ok(tagNames.includes('ffe_subjects_enc'), `Expected tagNames to include 'ffe_subjects_enc', got: ${tagNames}`)
      assert.ok(
        tagNames.includes('ffe_runtime_defaults'),
        `Expected tagNames to include 'ffe_runtime_defaults', got: ${tagNames}`
      )
    })

    it('should clean up state after applying tags', () => {
      const hook = new SpanEnrichmentHook(mockTracer)
      const state = hook._getOrCreateState(mockSpan)
      state.addSerialId(100)

      finishSubscriber(mockSpan)

      // Second call should do nothing since state was deleted
      mockSpan.setTag.resetHistory()
      finishSubscriber(mockSpan)

      sinon.assert.notCalled(mockSpan.setTag)
    })

    it('should catch and log errors when applying tags', () => {
      const hook = new SpanEnrichmentHook(mockTracer)
      const state = hook._getOrCreateState(mockSpan)
      state.addSerialId(100)
      mockSpan.setTag = sinon.stub().throws(new Error('setTag failed'))

      finishSubscriber(mockSpan)

      sinon.assert.calledOnce(log.warn)
      assert.ok(
        log.warn.firstCall.args[1].includes('setTag failed'),
        `Expected warning message to include 'setTag failed', got: ${log.warn.firstCall.args[1]}`
      )
    })

    it('should clean up state even when setTag throws', () => {
      const hook = new SpanEnrichmentHook(mockTracer)
      const state = hook._getOrCreateState(mockSpan)
      state.addSerialId(100)
      mockSpan.setTag = sinon.stub().throws(new Error('setTag failed'))

      finishSubscriber(mockSpan)

      // State should be cleaned up even after error
      mockSpan.setTag = sinon.spy() // Reset to non-throwing
      finishSubscriber(mockSpan)

      sinon.assert.notCalled(mockSpan.setTag)
    })

    it('should not set tag when value is falsy', () => {
      const hook = new SpanEnrichmentHook(mockTracer)
      const state = hook._getOrCreateState(mockSpan)
      // Mock toSpanTags to return an empty string value
      state.toSpanTags = () => ({ ffe_flags_enc: '', ffe_runtime_defaults: null })

      finishSubscriber(mockSpan)

      sinon.assert.notCalled(mockSpan.setTag)
    })
  })

  describe('destroy()', () => {
    it('should unsubscribe from finish channel', () => {
      const hook = new SpanEnrichmentHook(mockTracer)
      const subscribedFn = finishSubscriber

      hook.destroy()

      sinon.assert.calledOnce(mockFinishChannel.unsubscribe)
      // Verify the same function that was subscribed is unsubscribed
      sinon.assert.calledWith(mockFinishChannel.unsubscribe, subscribedFn)
    })
  })
})
