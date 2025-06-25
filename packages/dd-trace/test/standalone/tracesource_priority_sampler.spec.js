'use strict'

const t = require('tap')
require('../setup/core')

const { assert } = require('chai')
const proxyquire = require('proxyquire')
const { USER_KEEP, AUTO_KEEP } = require('../../../../ext/priority')
const DatadogSpan = require('../../src/opentracing/span')
const TraceSourcePrioritySampler = require('../../src/standalone/tracesource_priority_sampler')
const { TRACE_SOURCE_PROPAGATION_KEY } = require('../../src/constants')
const { ASM } = require('../../src/standalone/product')

t.test('Disabled APM Tracing or Standalone - TraceSourcePrioritySampler', t => {
  let prioritySampler
  let tags
  let context
  let root

  t.beforeEach(() => {
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

  t.test('sample', t => {
    t.test('should provide the context when invoking _getPriorityFromTags', t => {
      const span = new DatadogSpan({}, {}, prioritySampler, {
        operationName: 'operation'
      })

      const _getPriorityFromTags = sinon.stub(prioritySampler, '_getPriorityFromTags')

      prioritySampler.sample(span, false)

      sinon.assert.calledWithExactly(_getPriorityFromTags, context._tags, context)
      t.end()
    })
    t.end()
  })

  t.test('_getPriorityFromTags', t => {
    t.test('should keep the trace if manual.keep and _dd.p.ts are present', t => {
      context._trace.tags[TRACE_SOURCE_PROPAGATION_KEY] = '02'
      assert.strictEqual(prioritySampler._getPriorityFromTags(tags, context), USER_KEEP)
      t.end()
    })

    t.test('should return undefined if manual.keep or _dd.p.ts are not present', t => {
      assert.isUndefined(prioritySampler._getPriorityFromTags(tags, context))
      t.end()
    })
    t.end()
  })

  t.test('_getPriorityFromAuto', t => {
    t.test('should keep trace if it contains _dd.p.ts tag', t => {
      const span = {
        _trace: {}
      }

      context._trace.tags[TRACE_SOURCE_PROPAGATION_KEY] = '02'

      assert.strictEqual(prioritySampler._getPriorityFromAuto(span), USER_KEEP)
      t.end()
    })

    t.test('should use rate limiter if it does not contain _dd.p.ts tag', t => {
      const span = {
        _trace: {}
      }

      sinon.stub(prioritySampler, '_isSampledByRateLimit').returns(true)

      assert.strictEqual(prioritySampler._getPriorityFromAuto(span), AUTO_KEEP)
      t.end()
    })
    t.end()
  })

  t.test('setPriority', t => {
    let prioritySampler
    let setPriority
    let addTraceSourceTag

    t.beforeEach(() => {
      setPriority = sinon.stub()
      addTraceSourceTag = sinon.stub()

      const PrioritySampler = class {
        get setPriority () {
          return setPriority
        }
      }
      const TraceSourcePrioritySampler = proxyquire('../../src/standalone/tracesource_priority_sampler', {
        '../priority_sampler': PrioritySampler,
        './tracesource': {
          addTraceSourceTag
        }
      })

      prioritySampler = new TraceSourcePrioritySampler('test')

      sinon.stub(prioritySampler, '_getContext').returns(context)
    })

    t.test('should add tracesource tag for the corresponding product', t => {
      const span = {
        _trace: {}
      }

      prioritySampler.setPriority(span, USER_KEEP, ASM)

      sinon.assert.calledOnceWithExactly(setPriority, span, USER_KEEP, ASM)
      sinon.assert.calledOnceWithExactly(addTraceSourceTag, context._trace.tags, ASM)
      t.end()
    })
    t.end()
  })
  t.end()
})
