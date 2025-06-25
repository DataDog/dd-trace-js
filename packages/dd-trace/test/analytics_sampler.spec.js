'use strict'

const t = require('tap')
require('./setup/core')

const MEASURED = require('../../../ext/tags').MEASURED

t.test('analyticsSampler', t => {
  let sampler
  let span

  t.beforeEach(() => {
    sampler = require('../src/analytics_sampler')
    span = {
      context: sinon.stub().returns({
        _name: 'web.request'
      }),
      setTag: sinon.spy()
    }
  })

  t.test('sample', t => {
    t.test('should sample a span', t => {
      sampler.sample(span, true)

      expect(span.setTag).to.have.been.calledWith(MEASURED, true)
      t.end()
    })

    t.test('should sample a span by span name', t => {
      sampler.sample(span, {
        'web.request': 1
      })

      expect(span.setTag).to.have.been.calledWith(MEASURED, true)
      t.end()
    })

    t.test('should not sample by default', t => {
      sampler.sample(span, undefined)

      expect(span.setTag).to.not.have.been.called
      t.end()
    })

    t.test('should sample if `measuredByDefault` is true', t => {
      sampler.sample(span, undefined, true)

      expect(span.setTag).to.have.been.calledWith(MEASURED, true)
      t.end()
    })
    t.end()
  })
  t.end()
})
