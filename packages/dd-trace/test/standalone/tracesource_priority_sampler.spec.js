'use strict'

require('../setup/tap')

const { assert } = require('chai')
const { USER_KEEP } = require('../../../../ext/priority')
const DatadogSpan = require('../../src/opentracing/span')
const TraceSourcePrioritySampler = require('../../src/standalone/tracesource_priority_sampler')
const { TRACE_SOURCE_PROPAGATION_KEY } = require('../../src/constants')

describe('Disabled APM Tracing or Standalone - TraceSourcePrioritySampler', () => {
  let prioritySampler
  let tags
  let context
  let root

  beforeEach(() => {
    tags = { 'manual.keep': 'true' }
    prioritySampler = new TraceSourcePrioritySampler('test')

    root = {}
    context = {
      _sampling: {},
      _trace: {
        tags: {},
        started: [root]
      }
    }
    sinon.stub(prioritySampler, '_getContext').returns(context)
  })

  describe('sample', () => {
    it('should provide the context when invoking _getPriorityFromTags', () => {
      const span = new DatadogSpan({}, {}, prioritySampler, {
        operationName: 'operation'
      })

      const _getPriorityFromTags = sinon.stub(prioritySampler, '_getPriorityFromTags')

      prioritySampler.sample(span, false)

      sinon.assert.calledWithExactly(_getPriorityFromTags, context._tags, context)
    })
  })

  describe('_getPriorityFromTags', () => {
    it('should keep the trace if manual.keep and _dd.p.ts are present', () => {
      context._trace.tags[TRACE_SOURCE_PROPAGATION_KEY] = '02'
      assert.strictEqual(prioritySampler._getPriorityFromTags(tags, context), USER_KEEP)
    })

    it('should return undefined if manual.keep or _dd.p.ts are not present', () => {
      assert.isUndefined(prioritySampler._getPriorityFromTags(tags, context))
    })
  })

  describe('_getPriorityFromAuto', () => {
    it('should keep trace if it contains _dd.p.ts tag', () => {
      const span = {
        _trace: {}
      }

      context._trace.tags[TRACE_SOURCE_PROPAGATION_KEY] = '02'

      assert.strictEqual(prioritySampler._getPriorityFromAuto(span), USER_KEEP)
    })
  })
})
