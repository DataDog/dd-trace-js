'use strict'

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')

require('./setup/core')

const MEASURED = require('../../../ext/tags').MEASURED

describe('analyticsSampler', () => {
  let sampler
  let span

  beforeEach(() => {
    sampler = require('../src/analytics_sampler')
    span = {
      context: sinon.stub().returns({
        _name: 'web.request',
      }),
      setTag: sinon.spy(),
    }
  })

  describe('sample', () => {
    it('should sample a span', () => {
      sampler.sample(span, true)

      sinon.assert.calledWith(span.setTag, MEASURED, true)
    })

    it('should sample a span by span name', () => {
      sampler.sample(span, {
        'web.request': 1,
      })

      sinon.assert.calledWith(span.setTag, MEASURED, true)
    })

    it('should not sample by default', () => {
      sampler.sample(span, undefined)

      sinon.assert.notCalled(span.setTag)
    })

    it('should sample if `measuredByDefault` is true', () => {
      sampler.sample(span, undefined, true)

      sinon.assert.calledWith(span.setTag, MEASURED, true)
    })
  })
})
