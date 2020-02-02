'use strict'

const ext = require('../../../ext')

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
  let Sampler
  let sampler
  let context
  let span

  beforeEach(() => {
    context = {
      _tags: {},
      _sampling: {}
    }

    span = {
      context: sinon.stub().returns(context)
    }

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

    PrioritySampler = proxyquire('../src/priority_sampler', {
      './sampler': Sampler
    })

    prioritySampler = new PrioritySampler('test')
  })

  describe('validate', () => {
    it('should accept valid values', () => {
      expect(prioritySampler.validate(USER_REJECT)).to.be.true
      expect(prioritySampler.validate(AUTO_REJECT)).to.be.true
      expect(prioritySampler.validate(AUTO_KEEP)).to.be.true
      expect(prioritySampler.validate(USER_KEEP)).to.be.true
    })

    it('should not accept invalid values', () => {
      expect(prioritySampler.validate('foo')).to.be.false
      expect(prioritySampler.validate(0.5)).to.be.false
      expect(prioritySampler.validate({})).to.be.false
    })
  })

  describe('isSampled', () => {
    it('should sample by default', () => {
      expect(prioritySampler.isSampled(span)).to.be.true
    })

    it('should accept a span context', () => {
      expect(prioritySampler.isSampled(context)).to.be.true
    })
  })

  describe('sample', () => {
    it('should set the correct priority by default', () => {
      prioritySampler.sample(span)

      expect(context._sampling.priority).to.equal(AUTO_KEEP)
    })

    it('should set the priority from the corresponding tag', () => {
      context._tags[SAMPLING_PRIORITY] = `${USER_KEEP}`

      prioritySampler.sample(span)

      expect(context._sampling.priority).to.equal(USER_KEEP)
    })

    it('should freeze the sampling priority once set', () => {
      prioritySampler.sample(span)

      context._tags[SAMPLING_PRIORITY] = `${USER_KEEP}`

      prioritySampler.sample(span)

      expect(context._sampling.priority).to.equal(AUTO_KEEP)
    })

    it('should accept a span context', () => {
      prioritySampler.sample(context)

      expect(context._sampling.priority).to.equal(AUTO_KEEP)
    })

    it('should support manual keep', () => {
      context._tags[MANUAL_KEEP] = undefined

      prioritySampler.sample(context)

      expect(context._sampling.priority).to.equal(USER_KEEP)
    })

    it('should support manual drop', () => {
      context._tags[MANUAL_DROP] = undefined

      prioritySampler.sample(context)

      expect(context._sampling.priority).to.equal(USER_REJECT)
    })

    it('should support opentracing keep', () => {
      context._tags['sampling.priority'] = 1

      prioritySampler.sample(context)

      expect(context._sampling.priority).to.equal(USER_KEEP)
    })

    it('should support opentracing drop', () => {
      context._tags['sampling.priority'] = 0

      prioritySampler.sample(context)

      expect(context._sampling.priority).to.equal(USER_REJECT)
    })

    it('should support a global sample rate', () => {
      prioritySampler = new PrioritySampler('test', { sampleRate: 0.5 })
      prioritySampler.sample(context)

      expect(context._sampling).to.have.property('priority', AUTO_KEEP)

      delete context._sampling.priority

      prioritySampler.sample(context)

      expect(context._sampling).to.have.property('priority', AUTO_REJECT)
    })

    it('should support a sample rate from a rule on service as string', () => {
      context._tags['service.name'] = 'test'

      prioritySampler = new PrioritySampler('test', {
        rules: [
          { sampleRate: 0, service: 'foo' },
          { sampleRate: 1, service: 'test' }
        ]
      })
      prioritySampler.sample(context)

      expect(context._sampling).to.have.property('priority', AUTO_KEEP)
    })

    it('should support a sample rate from a rule on service as string as regex', () => {
      context._tags['service.name'] = 'test'

      prioritySampler = new PrioritySampler('test', {
        rules: [
          { sampleRate: 0, service: /fo/ },
          { sampleRate: 1, service: /tes/ }
        ]
      })
      prioritySampler.sample(context)

      expect(context._sampling).to.have.property('priority', AUTO_KEEP)
    })

    it('should support a sample rate from a rule on name as string', () => {
      context._name = 'foo'
      context._tags['service.name'] = 'test'

      prioritySampler = new PrioritySampler('test', {
        rules: [
          { sampleRate: 0, name: 'bar' },
          { sampleRate: 1, name: 'foo' }
        ]
      })
      prioritySampler.sample(context)

      expect(context._sampling).to.have.property('priority', AUTO_KEEP)
    })

    it('should support a sample rate from a rule on name as regex', () => {
      context._name = 'foo'
      context._tags['service.name'] = 'test'

      prioritySampler = new PrioritySampler('test', {
        rules: [
          { sampleRate: 0, name: /ba/ },
          { sampleRate: 1, name: /fo/ }
        ]
      })
      prioritySampler.sample(context)

      expect(context._sampling).to.have.property('priority', AUTO_KEEP)
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

      expect(context._sampling).to.have.property('priority', AUTO_KEEP)
    })

    it('should support a rate limit', () => {
      prioritySampler = new PrioritySampler('test', {
        sampleRate: 1,
        rateLimit: 1
      })
      prioritySampler.sample(context)

      expect(context._sampling).to.have.property('priority', AUTO_KEEP)

      delete context._sampling.priority

      prioritySampler.sample(context)

      expect(context._sampling).to.have.property('priority', AUTO_REJECT)
    })

    it('should support disabling the rate limit', () => {
      prioritySampler = new PrioritySampler('test', {
        sampleRate: 1,
        rateLimit: -1
      })
      prioritySampler.sample(context)

      expect(context._sampling).to.have.property('priority', AUTO_KEEP)

      delete context._sampling.priority

      prioritySampler.sample(context)

      expect(context._sampling).to.have.property('priority', AUTO_KEEP)
    })

    it('should add metrics for agent sample rate', () => {
      prioritySampler.sample(span)

      expect(context._tags).to.have.property('_dd.agent_psr', 1)
    })

    it('should add metrics for rule sample rate', () => {
      prioritySampler = new PrioritySampler('test', {
        sampleRate: 0
      })
      prioritySampler.sample(span)

      expect(context._tags).to.have.property('_dd.rule_psr', 0)
      expect(context._tags).to.not.have.property('_dd.limit_psr')
    })

    it('should add metrics for rate limiter sample rate', () => {
      prioritySampler = new PrioritySampler('test', {
        sampleRate: 0.5,
        rateLimit: 1
      })
      prioritySampler.sample(span)

      expect(context._tags).to.have.property('_dd.rule_psr', 0.5)
      expect(context._tags).to.have.property('_dd.limit_psr', 1)
    })
  })

  describe('update', () => {
    it('should update the default rate', () => {
      prioritySampler.update({
        'service:,env:': AUTO_REJECT
      })

      prioritySampler.sample(span)

      expect(context._sampling.priority).to.equal(AUTO_REJECT)
    })

    it('should update service rates', () => {
      context._tags[SERVICE_NAME] = 'hello'

      prioritySampler.update({
        'service:hello,env:test': AUTO_REJECT
      })

      prioritySampler.sample(span)

      expect(context._sampling.priority).to.equal(AUTO_REJECT)
    })
  })
})
