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
    it('should use a sample rate of 1 by default', () => {
      sampler.sample(span, {
        enabled: true
      }, true)

      expect(span.setTag).to.have.been.calledWith(ANALYTICS, 1)
    })

    it('should sample a span with the provided rate', () => {
      sampler.sample(span, {
        enabled: true,
        sampleRate: 0.5
      }, true)

      expect(span.setTag).to.have.been.calledWith(ANALYTICS, 0.5)
    })

    it('should sample only when enabled', () => {
      sampler.sample(span, {
        sampleRate: 0.5
      }, true)

      expect(span.setTag).to.not.have.been.called
    })

    it('should sample only with the flag to use the default', () => {
      sampler.sample(span, {
        enabled: true,
        sampleRate: 0.5
      })

      expect(span.setTag).to.not.have.been.called
    })

    it('should sample a span with the operation specific rate', () => {
      sampler.sample(span, {
        enabled: true,
        sampleRates: {
          'web.request': 0.5
        }
      })

      expect(span.setTag).to.have.been.calledWith(ANALYTICS, 0.5)
    })

    it('should ignore invalid values', () => {
      sampler.sample(span)
      sampler.sample(span, 2)
      sampler.sample(span, -1)
      sampler.sample(span, 'foo')

      expect(span.setTag).to.not.have.been.called
    })

    it('should ignore rates for different operation names', () => {
      sampler.sample(span, {
        enabled: true,
        sampleRates: {
          'other.request': 0.5
        }
      })

      expect(span.setTag).to.not.have.been.called
    })
  })
})
