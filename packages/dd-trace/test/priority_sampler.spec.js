'use strict'

const assert = require('node:assert/strict')

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('./setup/core')

const ext = require('../../../ext')

const {
  SAMPLING_MECHANISM_DEFAULT,
  SAMPLING_MECHANISM_AGENT,
  SAMPLING_MECHANISM_RULE,
  SAMPLING_MECHANISM_MANUAL,
  SAMPLING_MECHANISM_REMOTE_USER,
  SAMPLING_MECHANISM_REMOTE_DYNAMIC,
  DECISION_MAKER_KEY,
  SAMPLING_MECHANISM_APPSEC
} = require('../src/constants')
const { ASM } = require('../src/standalone/product')

const SERVICE_NAME = ext.tags.SERVICE_NAME
const SAMPLING_PRIORITY = ext.tags.SAMPLING_PRIORITY
const MANUAL_KEEP = ext.tags.MANUAL_KEEP
const MANUAL_DROP = ext.tags.MANUAL_DROP
const USER_REJECT = ext.priority.USER_REJECT
const AUTO_REJECT = ext.priority.AUTO_REJECT
const AUTO_KEEP = ext.priority.AUTO_KEEP
const USER_KEEP = ext.priority.USER_KEEP

describe('PrioritySampler', () => {
  let PrioritySampler
  let prioritySampler
  let SamplingRule
  let Sampler
  let sampler
  let context
  let span

  beforeEach(() => {
    context = {
      _tags: {
        'service.name': 'test',
        'resource.name': 'resource'
      },
      _sampling: {},
      _trace: {
        started: [],
        tags: {}
      },
      getTags () { return this._tags },
      getTag (key) { return this._tags[key] }
    }

    span = {
      context: sinon.stub().returns(context)
    }

    context._trace.started.push(span)

    sampler = {
      isSampled: sinon.stub(),
      rate: sinon.stub().returns(0.5)
    }
    sampler.isSampled.onFirstCall().returns(true)
    sampler.isSampled.onSecondCall().returns(false)

    Sampler = sinon.stub()
    Sampler.withArgs(0).returns({
      isSampled: sinon.stub().returns(false),
      rate: sinon.stub().returns(0)
    })
    Sampler.withArgs(1).returns({
      isSampled: sinon.stub().returns(true),
      rate: sinon.stub().returns(1)
    })
    Sampler.withArgs(0.5).returns(sampler)

    SamplingRule = proxyquire('../src/sampling_rule', {
      './sampler': Sampler
    })

    PrioritySampler = proxyquire('../src/priority_sampler', {
      './sampler': Sampler,
      './sampling_rule': SamplingRule
    })

    prioritySampler = new PrioritySampler('test')
  })

  describe('validate', () => {
    it('should accept valid values', () => {
      assert.strictEqual(prioritySampler.validate(USER_REJECT), true)
      assert.strictEqual(prioritySampler.validate(AUTO_REJECT), true)
      assert.strictEqual(prioritySampler.validate(AUTO_KEEP), true)
      assert.strictEqual(prioritySampler.validate(USER_KEEP), true)
    })

    it('should not accept invalid values', () => {
      assert.strictEqual(prioritySampler.validate('foo'), false)
      assert.strictEqual(prioritySampler.validate(0.5), false)
      assert.strictEqual(prioritySampler.validate({}), false)
    })
  })

  describe('isSampled', () => {
    it('should sample by default', () => {
      assert.strictEqual(prioritySampler.isSampled(span), true)
    })

    it('should accept a span context', () => {
      assert.strictEqual(prioritySampler.isSampled(context), true)
    })
  })

  describe('sample', () => {
    it('should set the correct priority by default', () => {
      prioritySampler.sample(span)

      assert.strictEqual(context._sampling.priority, AUTO_KEEP)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_DEFAULT)
    })

    it('should set the priority from the corresponding tag', () => {
      context._tags[SAMPLING_PRIORITY] = `${USER_KEEP}`

      prioritySampler.sample(span)

      assert.strictEqual(context._sampling.priority, USER_KEEP)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_MANUAL)
    })

    it('should freeze the sampling priority once set', () => {
      prioritySampler.sample(span)

      context._tags[SAMPLING_PRIORITY] = `${USER_KEEP}`

      prioritySampler.sample(span)

      assert.strictEqual(context._sampling.priority, AUTO_KEEP)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_DEFAULT)
    })

    it('should accept a span context', () => {
      prioritySampler.sample(context)

      assert.strictEqual(context._sampling.priority, AUTO_KEEP)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_DEFAULT)
    })

    it('should support manual keep', () => {
      context._tags[MANUAL_KEEP] = undefined

      prioritySampler.sample(context)

      assert.strictEqual(context._sampling.priority, USER_KEEP)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_MANUAL)
    })

    it('should support manual drop', () => {
      context._tags[MANUAL_DROP] = undefined

      prioritySampler.sample(context)

      assert.strictEqual(context._sampling.priority, USER_REJECT)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_MANUAL)
    })

    it('should support opentracing keep', () => {
      context._tags['sampling.priority'] = 1

      prioritySampler.sample(context)

      assert.strictEqual(context._sampling.priority, USER_KEEP)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_MANUAL)
    })

    it('should support opentracing drop', () => {
      context._tags['sampling.priority'] = 0

      prioritySampler.sample(context)

      assert.strictEqual(context._sampling.priority, USER_REJECT)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_MANUAL)
    })

    it('should support a global sample rate', () => {
      prioritySampler = new PrioritySampler('test', { sampleRate: 0.5 })
      prioritySampler.sample(context)

      assert.strictEqual(context._sampling.priority, USER_KEEP)

      delete context._sampling.priority

      prioritySampler.sample(context)

      assert.strictEqual(context._sampling.priority, USER_REJECT)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_RULE)
    })

    it('should support a rule-based sampling', () => {
      prioritySampler = new PrioritySampler('test', {
        rules: [
          { sampleRate: 0, service: 'foo', resource: /res.*/ },
          { sampleRate: 1, service: 'test', resource: /res.*/ }
        ]
      })
      prioritySampler.sample(context)

      assert.strictEqual(context._sampling.priority, USER_KEEP)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_RULE)
    })

    it('should support a customer-defined remote configuration sampling', () => {
      prioritySampler = new PrioritySampler('test', {
        rules: [
          { sampleRate: 1, service: 'test', resource: /res.*/, provenance: 'customer' }
        ]
      })
      prioritySampler.sample(context)

      assert.strictEqual(context._sampling.priority, USER_KEEP)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_REMOTE_USER)
    })

    it('should support a dynamic remote configuration sampling', () => {
      prioritySampler = new PrioritySampler('test', {
        rules: [
          { sampleRate: 0, service: 'test', resource: /res.*/, provenance: 'dynamic' }
        ]
      })
      prioritySampler.sample(context)

      assert.strictEqual(context._sampling.priority, USER_REJECT)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_REMOTE_DYNAMIC)
    })

    it('should validate JSON rule into an array', () => {
      context._name = 'test'
      context._tags['service.name'] = 'test'

      prioritySampler = new PrioritySampler('test', {
        rules: {
          name: 'test',
          sampleRate: 0
        }
      })

      // Should not throw
      prioritySampler.sample(context)
      assert.strictEqual(context._sampling.priority, USER_REJECT)
    })

    it('should validate and ignore non-JSON sampling rules', () => {
      prioritySampler = new PrioritySampler('test', {
        rules: 5
      })

      // Should not throw
      prioritySampler.sample(context)
      assert.strictEqual(context._sampling.priority, AUTO_KEEP)
    })

    it('should default to no rules if rules are set to null', () => {
      prioritySampler = new PrioritySampler('test', { rules: null })

      prioritySampler.sample(context)
      assert.strictEqual(context._sampling.priority, AUTO_KEEP)
    })

    it('should fallback to the global sample rate', () => {
      context._name = 'foo'

      prioritySampler = new PrioritySampler('test', {
        sampleRate: 1,
        rules: [
          { sampleRate: 0, name: 'bar' }
        ]
      })
      prioritySampler.sample(context)

      assert.strictEqual(context._sampling.priority, USER_KEEP)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_RULE)
    })

    it('should support a rate limit', () => {
      prioritySampler = new PrioritySampler('test', {
        sampleRate: 1,
        rateLimit: 1
      })
      prioritySampler.sample(context)

      assert.strictEqual(context._sampling.priority, USER_KEEP)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_RULE)

      delete context._sampling.priority

      prioritySampler.sample(context)

      assert.strictEqual(context._sampling.priority, USER_REJECT)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_RULE)
    })

    it('should support a global rate limit', () => {
      prioritySampler = new PrioritySampler('test', {
        sampleRate: 1,
        rateLimit: 1,
        rules: [{
          service: 'test',
          sampleRate: 1,
          rateLimit: 1000
        }]
      })
      prioritySampler.sample(context)

      assert.strictEqual(context._sampling.priority, USER_KEEP)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_RULE)

      delete context._sampling.priority

      prioritySampler.sample(context)

      assert.strictEqual(context._sampling.priority, USER_REJECT)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_RULE)
    })

    it('should support disabling the rate limit', () => {
      prioritySampler = new PrioritySampler('test', {
        sampleRate: 1,
        rateLimit: -1
      })
      prioritySampler.sample(context)

      assert.strictEqual(context._sampling.priority, USER_KEEP)
      assert.strictEqual(context._sampling.mechanism, 3)

      delete context._sampling.priority

      prioritySampler.sample(context)

      assert.strictEqual(context._sampling.priority, USER_KEEP)
      assert.strictEqual(context._sampling.mechanism, 3)
    })

    it('should add metrics for agent sample rate', () => {
      prioritySampler.sample(span)

      assert.strictEqual(context._trace['_dd.agent_psr'], 1)
    })

    it('should add metrics for rule sample rate', () => {
      prioritySampler = new PrioritySampler('test', {
        sampleRate: 0
      })
      prioritySampler.sample(span)

      assert.strictEqual(context._trace['_dd.rule_psr'], 0)
      assert.ok(!('_dd.limit_psr' in context._trace))
    })

    it('should add metrics for rate limiter sample rate', () => {
      prioritySampler = new PrioritySampler('test', {
        sampleRate: 0.5,
        rateLimit: 1
      })
      prioritySampler.sample(span)

      assert.strictEqual(context._trace['_dd.rule_psr'], 0.5)
      assert.strictEqual(context._trace['_dd.limit_psr'], 1)
    })

    it('should ignore empty span', () => {
      assert.doesNotThrow(() => {
        prioritySampler.sample()
      })
      prioritySampler.sample()
    })

    it('should support manual only sampling', () => {
      prioritySampler.sample(span, false)

      assert.strictEqual(context._sampling.priority, undefined)
      assert.strictEqual(context._sampling.mechanism, undefined)
    })

    it('should support noop spans', () => {
      context._trace.started.length = 0

      prioritySampler.sample(span)

      assert.strictEqual(context._sampling.priority, undefined)
      assert.strictEqual(context._sampling.mechanism, undefined)
    })

    it('should set the decision maker tag', () => {
      prioritySampler.sample(span)

      assert.strictEqual(context._trace.tags[DECISION_MAKER_KEY], '-0')
    })

    it('should not alter the decision maker tag', () => {
      context._trace.tags[DECISION_MAKER_KEY] = '-3'
      context._sampling.priority = 1

      prioritySampler.sample(span)

      assert.strictEqual(context._trace.tags[DECISION_MAKER_KEY], '-3')
    })

    it.skip('should remove the decision maker tag when dropping the trace', () => { })

    it('should not crash on prototype-free tags objects', () => {
      context._tags = Object.create(null)

      prioritySampler.sample(span)
    })
  })

  describe('update', () => {
    let rootSpan
    let rootContext

    beforeEach(() => {
      rootContext = {
        ...context,
        _tags: {
          ...context._tags
        }
      }

      rootSpan = {
        context: sinon.stub().returns(rootContext)
      }

      rootContext._trace.started.unshift(rootSpan)
    })

    it('should update the default rate', () => {
      prioritySampler.update({
        'service:,env:': AUTO_REJECT
      })

      prioritySampler.sample(span)

      assert.strictEqual(context._sampling.priority, AUTO_REJECT)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_AGENT)
    })

    it('should update service rates', () => {
      rootContext._tags[SERVICE_NAME] = 'foo'
      context._tags[SERVICE_NAME] = 'bar'

      prioritySampler.update({
        'service:foo,env:test': AUTO_REJECT
      })

      prioritySampler.sample(span)

      assert.strictEqual(context._sampling.priority, AUTO_REJECT)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_AGENT)
    })
  })

  describe('setPriority', () => {
    it('should set sampling priority and default mechanism', () => {
      prioritySampler.setPriority(span, USER_KEEP)

      assert.strictEqual(context._sampling.priority, USER_KEEP)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_MANUAL)
    })

    it('should set sampling priority and mechanism', () => {
      prioritySampler.setPriority(span, USER_KEEP, ASM)

      assert.strictEqual(context._sampling.priority, USER_KEEP)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_APPSEC)
    })

    it('should filter out invalid priorities', () => {
      prioritySampler.setPriority(span, 42)

      assert.strictEqual(context._sampling.priority, undefined)
      assert.strictEqual(context._sampling.mechanism, undefined)
    })

    it('should add decision maker tag if not set before', () => {
      prioritySampler.setPriority(span, USER_KEEP, ASM)

      assert.strictEqual(context._trace.tags[DECISION_MAKER_KEY], '-5')
    })

    it('should set sampling priority if no product is provided', () => {
      prioritySampler.setPriority(span, USER_KEEP)

      assert.strictEqual(context._sampling.priority, USER_KEEP)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_MANUAL)
    })

    it('should override previous priority but mantain previous decision maker tag', () => {
      prioritySampler.sample(span)

      prioritySampler.setPriority(span, USER_KEEP, ASM)

      assert.strictEqual(context._sampling.priority, USER_KEEP)
      assert.strictEqual(context._sampling.mechanism, SAMPLING_MECHANISM_APPSEC)
      assert.strictEqual(context._trace.tags[DECISION_MAKER_KEY], '-0')
    })

    it('should ignore noop spans', () => {
      context._trace.started[0] = undefined // noop

      prioritySampler.setPriority(span, USER_KEEP, SAMPLING_MECHANISM_APPSEC)

      assert.strictEqual(context._sampling.priority, undefined)
      assert.strictEqual(context._sampling.mechanism, undefined)
      assert.strictEqual(context._trace.tags[DECISION_MAKER_KEY], undefined)
    })
  })

  describe('keepTrace', () => {
    it('should not fail if no _prioritySampler', () => {
      assert.doesNotThrow(() => {
        PrioritySampler.keepTrace(span, SAMPLING_MECHANISM_APPSEC)
      })
    })

    it('should call setPriority with span USER_KEEP and mechanism', () => {
      const setPriority = sinon.stub(prioritySampler, 'setPriority')

      span._prioritySampler = prioritySampler

      PrioritySampler.keepTrace(span, SAMPLING_MECHANISM_APPSEC)

      expect(setPriority).to.be.calledOnceWithExactly(span, USER_KEEP, SAMPLING_MECHANISM_APPSEC)
    })
  })
})
