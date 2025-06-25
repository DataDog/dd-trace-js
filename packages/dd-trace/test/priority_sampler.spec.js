'use strict'

const t = require('tap')
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

t.test('PrioritySampler', t => {
  let PrioritySampler
  let prioritySampler
  let SamplingRule
  let Sampler
  let sampler
  let context
  let span

  t.beforeEach(() => {
    context = {
      _tags: {
        'service.name': 'test',
        'resource.name': 'resource'
      },
      _sampling: {},
      _trace: {
        started: [],
        tags: {}
      }
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

  t.test('validate', t => {
    t.test('should accept valid values', t => {
      expect(prioritySampler.validate(USER_REJECT)).to.be.true
      expect(prioritySampler.validate(AUTO_REJECT)).to.be.true
      expect(prioritySampler.validate(AUTO_KEEP)).to.be.true
      expect(prioritySampler.validate(USER_KEEP)).to.be.true
      t.end()
    })

    t.test('should not accept invalid values', t => {
      expect(prioritySampler.validate('foo')).to.be.false
      expect(prioritySampler.validate(0.5)).to.be.false
      expect(prioritySampler.validate({})).to.be.false
      t.end()
    })
    t.end()
  })

  t.test('isSampled', t => {
    t.test('should sample by default', t => {
      expect(prioritySampler.isSampled(span)).to.be.true
      t.end()
    })

    t.test('should accept a span context', t => {
      expect(prioritySampler.isSampled(context)).to.be.true
      t.end()
    })
    t.end()
  })

  t.test('sample', t => {
    t.test('should set the correct priority by default', t => {
      prioritySampler.sample(span)

      expect(context._sampling.priority).to.equal(AUTO_KEEP)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_DEFAULT)
      t.end()
    })

    t.test('should set the priority from the corresponding tag', t => {
      context._tags[SAMPLING_PRIORITY] = `${USER_KEEP}`

      prioritySampler.sample(span)

      expect(context._sampling.priority).to.equal(USER_KEEP)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_MANUAL)
      t.end()
    })

    t.test('should freeze the sampling priority once set', t => {
      prioritySampler.sample(span)

      context._tags[SAMPLING_PRIORITY] = `${USER_KEEP}`

      prioritySampler.sample(span)

      expect(context._sampling.priority).to.equal(AUTO_KEEP)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_DEFAULT)
      t.end()
    })

    t.test('should accept a span context', t => {
      prioritySampler.sample(context)

      expect(context._sampling.priority).to.equal(AUTO_KEEP)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_DEFAULT)
      t.end()
    })

    t.test('should support manual keep', t => {
      context._tags[MANUAL_KEEP] = undefined

      prioritySampler.sample(context)

      expect(context._sampling.priority).to.equal(USER_KEEP)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_MANUAL)
      t.end()
    })

    t.test('should support manual drop', t => {
      context._tags[MANUAL_DROP] = undefined

      prioritySampler.sample(context)

      expect(context._sampling.priority).to.equal(USER_REJECT)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_MANUAL)
      t.end()
    })

    t.test('should support opentracing keep', t => {
      context._tags['sampling.priority'] = 1

      prioritySampler.sample(context)

      expect(context._sampling.priority).to.equal(USER_KEEP)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_MANUAL)
      t.end()
    })

    t.test('should support opentracing drop', t => {
      context._tags['sampling.priority'] = 0

      prioritySampler.sample(context)

      expect(context._sampling.priority).to.equal(USER_REJECT)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_MANUAL)
      t.end()
    })

    t.test('should support a global sample rate', t => {
      prioritySampler = new PrioritySampler('test', { sampleRate: 0.5 })
      prioritySampler.sample(context)

      expect(context._sampling).to.have.property('priority', USER_KEEP)

      delete context._sampling.priority

      prioritySampler.sample(context)

      expect(context._sampling).to.have.property('priority', USER_REJECT)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_RULE)
      t.end()
    })

    t.test('should support a rule-based sampling', t => {
      prioritySampler = new PrioritySampler('test', {
        rules: [
          { sampleRate: 0, service: 'foo', resource: /res.*/ },
          { sampleRate: 1, service: 'test', resource: /res.*/ }
        ]
      })
      prioritySampler.sample(context)

      expect(context._sampling).to.have.property('priority', USER_KEEP)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_RULE)
      t.end()
    })

    t.test('should support a customer-defined remote configuration sampling', t => {
      prioritySampler = new PrioritySampler('test', {
        rules: [
          { sampleRate: 1, service: 'test', resource: /res.*/, provenance: 'customer' }
        ]
      })
      prioritySampler.sample(context)

      expect(context._sampling).to.have.property('priority', USER_KEEP)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_REMOTE_USER)
      t.end()
    })

    t.test('should support a dynamic remote configuration sampling', t => {
      prioritySampler = new PrioritySampler('test', {
        rules: [
          { sampleRate: 0, service: 'test', resource: /res.*/, provenance: 'dynamic' }
        ]
      })
      prioritySampler.sample(context)

      expect(context._sampling).to.have.property('priority', USER_REJECT)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_REMOTE_DYNAMIC)
      t.end()
    })

    t.test('should validate JSON rule into an array', t => {
      context._name = 'test'
      context._tags['service.name'] = 'test'

      prioritySampler = new PrioritySampler('test', {
        rules: {
          name: 'test',
          sampleRate: 0
        }
      })

      expect(prioritySampler.sample(context)).to.not.throw
      expect(context._sampling).to.have.property('priority', USER_REJECT)
      t.end()
    })

    t.test('should validate and ignore non-JSON sampling rules', t => {
      prioritySampler = new PrioritySampler('test', {
        rules: 5
      })

      expect(prioritySampler.sample(context)).to.not.throw
      expect(context._sampling).to.have.property('priority', AUTO_KEEP)
      t.end()
    })

    t.test('should default to no rules if rules are set to null', t => {
      prioritySampler = new PrioritySampler('test', { rules: null })

      prioritySampler.sample(context)
      expect(context._sampling).to.have.property('priority', AUTO_KEEP)
      t.end()
    })

    t.test('should fallback to the global sample rate', t => {
      context._name = 'foo'

      prioritySampler = new PrioritySampler('test', {
        sampleRate: 1,
        rules: [
          { sampleRate: 0, name: 'bar' }
        ]
      })
      prioritySampler.sample(context)

      expect(context._sampling).to.have.property('priority', USER_KEEP)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_RULE)
      t.end()
    })

    t.test('should support a rate limit', t => {
      prioritySampler = new PrioritySampler('test', {
        sampleRate: 1,
        rateLimit: 1
      })
      prioritySampler.sample(context)

      expect(context._sampling).to.have.property('priority', USER_KEEP)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_RULE)

      delete context._sampling.priority

      prioritySampler.sample(context)

      expect(context._sampling).to.have.property('priority', USER_REJECT)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_RULE)
      t.end()
    })

    t.test('should support a global rate limit', t => {
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

      expect(context._sampling).to.have.property('priority', USER_KEEP)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_RULE)

      delete context._sampling.priority

      prioritySampler.sample(context)

      expect(context._sampling).to.have.property('priority', USER_REJECT)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_RULE)
      t.end()
    })

    t.test('should support disabling the rate limit', t => {
      prioritySampler = new PrioritySampler('test', {
        sampleRate: 1,
        rateLimit: -1
      })
      prioritySampler.sample(context)

      expect(context._sampling).to.have.property('priority', USER_KEEP)
      expect(context._sampling.mechanism).to.equal(3)

      delete context._sampling.priority

      prioritySampler.sample(context)

      expect(context._sampling).to.have.property('priority', USER_KEEP)
      expect(context._sampling.mechanism).to.equal(3)
      t.end()
    })

    t.test('should add metrics for agent sample rate', t => {
      prioritySampler.sample(span)

      expect(context._trace).to.have.property('_dd.agent_psr', 1)
      t.end()
    })

    t.test('should add metrics for rule sample rate', t => {
      prioritySampler = new PrioritySampler('test', {
        sampleRate: 0
      })
      prioritySampler.sample(span)

      expect(context._trace).to.have.property('_dd.rule_psr', 0)
      expect(context._trace).to.not.have.property('_dd.limit_psr')
      t.end()
    })

    t.test('should add metrics for rate limiter sample rate', t => {
      prioritySampler = new PrioritySampler('test', {
        sampleRate: 0.5,
        rateLimit: 1
      })
      prioritySampler.sample(span)

      expect(context._trace).to.have.property('_dd.rule_psr', 0.5)
      expect(context._trace).to.have.property('_dd.limit_psr', 1)
      t.end()
    })

    t.test('should ignore empty span', t => {
      expect(() => {
        prioritySampler.sample()
      }).to.not.throw()
      prioritySampler.sample()
      t.end()
    })

    t.test('should support manual only sampling', t => {
      prioritySampler.sample(span, false)

      expect(context._sampling.priority).to.be.undefined
      expect(context._sampling.mechanism).to.be.undefined
      t.end()
    })

    t.test('should support noop spans', t => {
      context._trace.started.length = 0

      prioritySampler.sample(span)

      expect(context._sampling.priority).to.be.undefined
      expect(context._sampling.mechanism).to.be.undefined
      t.end()
    })

    t.test('should set the decision maker tag', t => {
      prioritySampler.sample(span)

      expect(context._trace.tags).to.have.property(DECISION_MAKER_KEY, '-0')
      t.end()
    })

    t.test('should not alter the decision maker tag', t => {
      context._trace.tags[DECISION_MAKER_KEY] = '-3'
      context._sampling.priority = 1

      prioritySampler.sample(span)

      expect(context._trace.tags).to.have.property(DECISION_MAKER_KEY, '-3')
      t.end()
    })

    t.skip('should remove the decision maker tag when dropping the trace', t => {
      t.end()
    })

    t.test('should not crash on prototype-free tags objects', t => {
      context._tags = Object.create(null)

      prioritySampler.sample(span)
      t.end()
    })
    t.end()
  })

  t.test('update', t => {
    let rootSpan
    let rootContext

    t.beforeEach(() => {
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

    t.test('should update the default rate', t => {
      prioritySampler.update({
        'service:,env:': AUTO_REJECT
      })

      prioritySampler.sample(span)

      expect(context._sampling.priority).to.equal(AUTO_REJECT)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_AGENT)
      t.end()
    })

    t.test('should update service rates', t => {
      rootContext._tags[SERVICE_NAME] = 'foo'
      context._tags[SERVICE_NAME] = 'bar'

      prioritySampler.update({
        'service:foo,env:test': AUTO_REJECT
      })

      prioritySampler.sample(span)

      expect(context._sampling.priority).to.equal(AUTO_REJECT)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_AGENT)
      t.end()
    })
    t.end()
  })

  t.test('setPriority', t => {
    t.test('should set sampling priority and default mechanism', t => {
      prioritySampler.setPriority(span, USER_KEEP)

      expect(context._sampling.priority).to.equal(USER_KEEP)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_MANUAL)
      t.end()
    })

    t.test('should set sampling priority and mechanism', t => {
      prioritySampler.setPriority(span, USER_KEEP, ASM)

      expect(context._sampling.priority).to.equal(USER_KEEP)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_APPSEC)
      t.end()
    })

    t.test('should filter out invalid priorities', t => {
      prioritySampler.setPriority(span, 42)

      expect(context._sampling.priority).to.be.undefined
      expect(context._sampling.mechanism).to.be.undefined
      t.end()
    })

    t.test('should add decision maker tag if not set before', t => {
      prioritySampler.setPriority(span, USER_KEEP, ASM)

      expect(context._trace.tags[DECISION_MAKER_KEY]).to.equal('-5')
      t.end()
    })

    t.test('should set sampling priority if no product is provided', t => {
      prioritySampler.setPriority(span, USER_KEEP)

      expect(context._sampling.priority).to.equal(USER_KEEP)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_MANUAL)
      t.end()
    })

    t.test('should override previous priority but mantain previous decision maker tag', t => {
      prioritySampler.sample(span)

      prioritySampler.setPriority(span, USER_KEEP, ASM)

      expect(context._sampling.priority).to.equal(USER_KEEP)
      expect(context._sampling.mechanism).to.equal(SAMPLING_MECHANISM_APPSEC)
      expect(context._trace.tags[DECISION_MAKER_KEY]).to.equal('-0')
      t.end()
    })

    t.test('should ignore noop spans', t => {
      context._trace.started[0] = undefined // noop

      prioritySampler.setPriority(span, USER_KEEP, SAMPLING_MECHANISM_APPSEC)

      expect(context._sampling.priority).to.undefined
      expect(context._sampling.mechanism).to.undefined
      expect(context._trace.tags[DECISION_MAKER_KEY]).to.undefined
      t.end()
    })
    t.end()
  })

  t.test('keepTrace', t => {
    t.test('should not fail if no _prioritySampler', t => {
      expect(() => {
        PrioritySampler.keepTrace(span, SAMPLING_MECHANISM_APPSEC)
      }).to.not.throw()
      t.end()
    })

    t.test('should call setPriority with span USER_KEEP and mechanism', t => {
      const setPriority = sinon.stub(prioritySampler, 'setPriority')

      span._prioritySampler = prioritySampler

      PrioritySampler.keepTrace(span, SAMPLING_MECHANISM_APPSEC)

      expect(setPriority).to.be.calledOnceWithExactly(span, USER_KEEP, SAMPLING_MECHANISM_APPSEC)
      t.end()
    })
    t.end()
  })
  t.end()
})
