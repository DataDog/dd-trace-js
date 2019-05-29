'use strict'

const ANALYTICS = require('../ext/tags').ANALYTICS

describe('analyticsSampler', () => {
  let sampler
  let span

  beforeEach(() => {
    sampler = require('../src/analytics_sampler')
    span = {
      context: sinon.stub().returns({
        _name: 'web.request'
      }),
      setTag: sinon.spy()
    }
  })

  describe('sample', () => {
    it('should sample a span', () => {
      sampler.sample(span, true)

      expect(span.setTag).to.have.been.calledWith(ANALYTICS, true)
    })

    it('should sample a span with the provided rate', () => {
      sampler.sample(span, 0)

      expect(span.setTag).to.have.been.calledWith(ANALYTICS, 0)
    })

    it('should not set a rate by default', () => {
      sampler.sample(span, undefined)

      expect(span.setTag).to.not.have.been.called
    })

    it('should inherit from global setting when unset', () => {
      sampler.enable()
      sampler.sample(span, undefined, true)

      expect(span.setTag).to.have.been.calledWith(ANALYTICS, 1)
    })
  })
})
