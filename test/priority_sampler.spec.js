'use strict'

const ext = require('../ext')

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

    PrioritySampler = require('../src/priority_sampler')

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
