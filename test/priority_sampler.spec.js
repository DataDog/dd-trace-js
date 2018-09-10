'use strict'

const SERVICE_NAME = 'service.name'
const SAMPLING_PRIORITY = 'sampling.priority'

describe('PrioritySampler', () => {
  let PrioritySampler
  let prioritySampler
  let context
  let span

  beforeEach(() => {
    context = {
      tags: {},
      sampling: {}
    }

    span = {
      context: sinon.stub().returns(context)
    }

    PrioritySampler = require('../src/priority_sampler')

    prioritySampler = new PrioritySampler('test')
  })

  describe('validate', () => {
    it('should accept valid values', () => {
      expect(prioritySampler.validate(-1)).to.be.true
      expect(prioritySampler.validate(0)).to.be.true
      expect(prioritySampler.validate(1)).to.be.true
      expect(prioritySampler.validate(2)).to.be.true
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

      expect(context.sampling.priority).to.equal(1)
    })

    it('should set the priority from the corresponding tag', () => {
      context.tags[SAMPLING_PRIORITY] = '2'

      prioritySampler.sample(span)

      expect(context.sampling.priority).to.equal(2)
    })

    it('should freeze the sampling priority once set', () => {
      prioritySampler.sample(span)

      expect(context.sampling.priority).to.equal(1)

      context.tags[SAMPLING_PRIORITY] = '2'

      prioritySampler.sample(span)

      expect(context.sampling.priority).to.equal(1)
    })

    it('should accept a span context', () => {
      prioritySampler.sample(context)

      expect(context.sampling.priority).to.equal(1)
    })
  })

  describe('update', () => {
    it('should update the default rate', () => {
      prioritySampler.update({
        'service:,env:': 0
      })

      prioritySampler.sample(span)

      expect(context.sampling.priority).to.equal(0)
    })

    it('should update service rates', () => {
      context.tags[SERVICE_NAME] = 'hello'

      prioritySampler.update({
        'service:hello,env:test': 0
      })

      prioritySampler.sample(span)

      expect(context.sampling.priority).to.equal(0)
    })
  })
})
