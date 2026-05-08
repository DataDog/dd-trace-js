'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')

require('../../setup/core')
const { SVC_SRC_KEY } = require('../../../src/constants')
const { PublicSpan, unwrap } = require('../../../src/opentracing/public/span')

const MANUAL = 'm'

function createInnerSpan () {
  return {
    context: sinon.stub().returns('inner-context'),
    tracer: sinon.stub().returns('inner-tracer'),
    setOperationName: sinon.stub().returns('inner-setOperationName'),
    setBaggageItem: sinon.stub().returns('inner-setBaggageItem'),
    getBaggageItem: sinon.stub().returns('inner-getBaggageItem'),
    setTag: sinon.stub().returns('inner-setTag'),
    addTags: sinon.stub().returns('inner-addTags'),
    addLink: sinon.stub().returns('inner-addLink'),
    addLinks: sinon.stub().returns('inner-addLinks'),
    log: sinon.stub().returns('inner-log'),
    logEvent: sinon.stub().returns('inner-logEvent'),
    finish: sinon.stub().returns('inner-finish'),
  }
}

describe('PublicSpan', () => {
  let inner
  let publicSpan

  beforeEach(() => {
    inner = createInnerSpan()
    publicSpan = new PublicSpan(inner)
  })

  describe('constructor / wrapping identity', () => {
    it('returns the same PublicSpan when wrapping the same inner span twice', () => {
      const second = new PublicSpan(inner)
      assert.strictEqual(second, publicSpan)
    })

    it('produces distinct wrappers for distinct inner spans', () => {
      const otherInner = createInnerSpan()
      const otherPublic = new PublicSpan(otherInner)
      assert.notStrictEqual(otherPublic, publicSpan)
    })

    it('exposes the inner span via unwrap()', () => {
      assert.strictEqual(unwrap(publicSpan), inner)
    })
  })

  describe('pure pass-through methods', () => {
    const cases = [
      { name: 'context', chainable: false },
      { name: 'tracer', chainable: false },
      { name: 'setOperationName', chainable: true },
      { name: 'setBaggageItem', chainable: true },
      { name: 'getBaggageItem', chainable: false },
      { name: 'addLink', chainable: false },
      { name: 'addLinks', chainable: false },
      { name: 'log', chainable: true },
      { name: 'logEvent', chainable: false },
      { name: 'finish', chainable: false },
    ]

    for (const { name, chainable } of cases) {
      it(`${name}() forwards arguments to the inner span`, () => {
        publicSpan[name]('a', 2, { c: 3 })
        sinon.assert.calledOnceWithExactly(inner[name], 'a', 2, { c: 3 })
      })

      it(`${name}() ${chainable ? 'returns the PublicSpan (chainable)' : 'forwards the inner return value'}`, () => {
        const result = publicSpan[name]()
        if (chainable) {
          assert.strictEqual(result, publicSpan)
        } else {
          assert.strictEqual(result, `inner-${name}`)
        }
      })
    }
  })

  describe('setTag()', () => {
    it('marks SVC_SRC_KEY=MANUAL when the key is "service"', () => {
      const result = publicSpan.setTag('service', 'foo')

      assert.strictEqual(inner.setTag.callCount, 2)
      sinon.assert.calledWithExactly(inner.setTag.firstCall, SVC_SRC_KEY, MANUAL)
      sinon.assert.calledWithExactly(inner.setTag.secondCall, 'service', 'foo')
      assert.strictEqual(result, publicSpan)
    })

    it('marks SVC_SRC_KEY=MANUAL when the key is "service.name"', () => {
      publicSpan.setTag('service.name', 'foo')

      assert.strictEqual(inner.setTag.callCount, 2)
      sinon.assert.calledWithExactly(inner.setTag.firstCall, SVC_SRC_KEY, MANUAL)
      sinon.assert.calledWithExactly(inner.setTag.secondCall, 'service.name', 'foo')
    })

    it('does not mark SVC_SRC_KEY for unrelated tag keys', () => {
      publicSpan.setTag('http.url', 'https://example.com')

      sinon.assert.calledOnceWithExactly(inner.setTag, 'http.url', 'https://example.com')
    })

    it('returns the PublicSpan (chainable) for non-service tags', () => {
      assert.strictEqual(publicSpan.setTag('http.url', 'x'), publicSpan)
    })
  })

  describe('addTags()', () => {
    it('marks SVC_SRC_KEY=MANUAL when tags contain a "service" key', () => {
      const tags = { service: 'foo', 'http.url': 'x' }
      const result = publicSpan.addTags(tags)

      sinon.assert.calledOnceWithExactly(inner.setTag, SVC_SRC_KEY, MANUAL)
      sinon.assert.calledOnceWithExactly(inner.addTags, tags)
      assert.strictEqual(result, publicSpan)
    })

    it('marks SVC_SRC_KEY=MANUAL when tags contain a "service.name" key', () => {
      publicSpan.addTags({ 'service.name': 'foo' })

      sinon.assert.calledOnceWithExactly(inner.setTag, SVC_SRC_KEY, MANUAL)
    })

    it('does not mark SVC_SRC_KEY for unrelated tag bags', () => {
      publicSpan.addTags({ 'http.url': 'x' })

      sinon.assert.notCalled(inner.setTag)
      sinon.assert.calledOnceWithExactly(inner.addTags, { 'http.url': 'x' })
    })

  })

  describe('unwrap()', () => {
    it('returns the inner span for a PublicSpan input', () => {
      assert.strictEqual(unwrap(publicSpan), inner)
    })

    it('returns undefined for null/undefined inputs (early return)', () => {
      assert.strictEqual(unwrap(null), undefined)
      assert.strictEqual(unwrap(undefined), undefined)
    })

    it('throws when given a non-PublicSpan object (private field access)', () => {
      assert.throws(() => unwrap({ foo: 'bar' }), TypeError)
    })

    it('cannot be reached via PublicSpan._unwrap (stripped from the public surface)', () => {
      assert.strictEqual(PublicSpan._unwrap, undefined)
      assert.strictEqual(PublicSpan.constructor._unwrap, undefined)
    })
  })
})
