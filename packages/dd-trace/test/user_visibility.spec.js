'use strict'

const assert = require('node:assert/strict')
const { describe, it } = require('mocha')

require('./setup/core')

const { SVC_SRC_KEY } = require('../src/constants')
const {
  applyUserSourceStamps,
  isUserVisible,
  markUserVisible,
  stampManualServiceInOptions,
} = require('../src/user_visibility')

function fakeSpan () {
  return { _spanContext: { _tags: {} } }
}

describe('user_visibility', () => {
  describe('markUserVisible / isUserVisible', () => {
    it('marks an object span as user-visible', () => {
      const span = fakeSpan()
      assert.equal(isUserVisible(span), false)
      assert.equal(markUserVisible(span), span)
      assert.equal(isUserVisible(span), true)
    })

    it('returns the value untouched when not an object', () => {
      assert.equal(markUserVisible(null), null)
      assert.equal(markUserVisible(undefined), undefined)
      assert.equal(markUserVisible('not-a-span'), 'not-a-span')
      assert.equal(markUserVisible(7), 7)
    })

    it('reports false for unmarked objects', () => {
      assert.equal(isUserVisible(fakeSpan()), false)
    })
  })

  describe('applyUserSourceStamps', () => {
    it('stamps _dd.svc_src when user-visible span receives a service tag', () => {
      const span = markUserVisible(fakeSpan())
      applyUserSourceStamps(span, { service: 'custom' })
      assert.equal(span._spanContext._tags[SVC_SRC_KEY], 'm')
    })

    it('stamps _dd.svc_src when user-visible span receives a service.name tag', () => {
      const span = markUserVisible(fakeSpan())
      applyUserSourceStamps(span, { 'service.name': 'custom' })
      assert.equal(span._spanContext._tags[SVC_SRC_KEY], 'm')
    })

    it('does not stamp when span is not user-visible', () => {
      const span = fakeSpan()
      applyUserSourceStamps(span, { service: 'custom' })
      assert.equal(SVC_SRC_KEY in span._spanContext._tags, false)
    })

    it('does not stamp when blob has no service-related key', () => {
      const span = markUserVisible(fakeSpan())
      applyUserSourceStamps(span, { resource: 'r' })
      assert.equal(SVC_SRC_KEY in span._spanContext._tags, false)
    })

    it('overrides a previously-set internal source (manual wins)', () => {
      const span = markUserVisible(fakeSpan())
      span._spanContext._tags[SVC_SRC_KEY] = 'opt.plugin'
      applyUserSourceStamps(span, { service: 'custom' })
      assert.equal(span._spanContext._tags[SVC_SRC_KEY], 'm')
    })

    it('handles null/undefined blob without throwing', () => {
      const span = markUserVisible(fakeSpan())
      applyUserSourceStamps(span, null)
      applyUserSourceStamps(span, undefined)
      assert.equal(SVC_SRC_KEY in span._spanContext._tags, false)
    })
  })

  describe('stampManualServiceInOptions', () => {
    it('stamps tags._dd.svc_src when options.service is set', () => {
      const out = stampManualServiceInOptions({ service: 'custom' })
      assert.deepEqual(out.tags, { [SVC_SRC_KEY]: 'm' })
      assert.equal(out.service, 'custom')
    })

    it('stamps tags._dd.svc_src when options.tags has service.name', () => {
      const out = stampManualServiceInOptions({ tags: { 'service.name': 'custom' } })
      assert.equal(out.tags[SVC_SRC_KEY], 'm')
      assert.equal(out.tags['service.name'], 'custom')
    })

    it('returns the same object reference when no service is set', () => {
      const opts = { resource: 'r' }
      assert.equal(stampManualServiceInOptions(opts), opts)
    })

    it('returns the input untouched when nullish', () => {
      assert.equal(stampManualServiceInOptions(undefined), undefined)
      assert.equal(stampManualServiceInOptions(null), null)
    })
  })
})
