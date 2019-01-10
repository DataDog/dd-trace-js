'use strict'

const EVENT_SAMPLE_RATE = require('../ext/tags').EVENT_SAMPLE_RATE

describe('eventSampler', () => {
  let eventSampler
  let span

  beforeEach(() => {
    eventSampler = require('../src/event_sampler')
    span = {
      context: sinon.stub().returns({
        _name: 'web.request'
      }),
      setTag: sinon.spy()
    }
  })

  describe('sample', () => {
    it('should sample a span with the provided rate', () => {
      eventSampler.sample(span, 0.5)

      expect(span.setTag).to.have.been.calledWith(EVENT_SAMPLE_RATE, 0.5)
    })

    it('should sample a span with the operation specific rate', () => {
      eventSampler.sample(span, {
        'web.request': 0.5
      })

      expect(span.setTag).to.have.been.calledWith(EVENT_SAMPLE_RATE, 0.5)
    })

    it('should ignore invalid values', () => {
      eventSampler.sample(span)
      eventSampler.sample(span, 2)
      eventSampler.sample(span, -1)
      eventSampler.sample(span, 'foo')

      expect(span.setTag).to.not.have.been.called
    })

    it('should ignore rates for different operation names', () => {
      eventSampler.sample(span, {
        'other.request': 0.5
      })

      expect(span.setTag).to.not.have.been.called
    })
  })
})
