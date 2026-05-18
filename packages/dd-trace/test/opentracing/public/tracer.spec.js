'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')

require('../../setup/core')
const { SVC_SRC_KEY } = require('../../../src/constants')
const { PublicSpan } = require('../../../src/opentracing/public/span')
const { PublicTracer } = require('../../../src/opentracing/public/tracer')
const { getPublicTracer } = require('../../../src/opentracing/public/tracer-ref')

const MANUAL = 'm'

function createInnerTracer () {
  return {
    startSpan: sinon.stub().returns({}),
    trace: sinon.stub().returns('inner-trace'),
    wrap: sinon.stub().returns('inner-wrap'),
    inject: sinon.stub().returns('inner-inject'),
    extract: sinon.stub().returns('inner-extract'),
    scope: sinon.stub().returns('inner-scope'),
    setUrl: sinon.stub().returns('inner-setUrl'),
    getRumData: sinon.stub().returns('inner-getRumData'),
  }
}

describe('PublicTracer', () => {
  let inner
  let publicTracer

  beforeEach(() => {
    inner = createInnerTracer()
    publicTracer = new PublicTracer(inner)
  })

  describe('constructor', () => {
    it('stamps itself onto the inner tracer so getPublicTracer can resolve it', () => {
      assert.strictEqual(getPublicTracer(inner), publicTracer)
    })

    it('returns undefined when no PublicTracer has been registered', () => {
      assert.strictEqual(getPublicTracer({}), undefined)
    })
  })

  describe('startSpan()', () => {
    it('wraps the returned inner span in a PublicSpan', () => {
      const innerSpan = {}
      inner.startSpan.returns(innerSpan)

      const result = publicTracer.startSpan('name')

      assert.ok(result instanceof PublicSpan)
      sinon.assert.calledOnce(inner.startSpan)
    })

    it('forwards name and options to the inner tracer', () => {
      publicTracer.startSpan('foo', { resource: 'r' })

      sinon.assert.calledWith(inner.startSpan, 'foo', { resource: 'r' })
    })

    it('marks SVC_SRC_KEY when options.service is set', () => {
      publicTracer.startSpan('name', { service: 'custom' })

      sinon.assert.calledWith(inner.startSpan, 'name', {
        service: 'custom',
        tags: { [SVC_SRC_KEY]: MANUAL },
      })
    })

    it('does not mark SVC_SRC_KEY when no service is provided', () => {
      publicTracer.startSpan('name', { resource: 'r' })

      const passed = inner.startSpan.firstCall.args[1]
      assert.ok(!passed.tags || !(SVC_SRC_KEY in passed.tags))
    })

    it('unwraps PublicSpan from options.childOf', () => {
      const innerParent = {}
      const publicParent = new PublicSpan(innerParent)

      publicTracer.startSpan('name', { childOf: publicParent })

      sinon.assert.calledWith(inner.startSpan, 'name', sinon.match({ childOf: innerParent }))
    })

    it('forwards non-PublicSpan childOf unchanged', () => {
      const directParent = {}

      publicTracer.startSpan('name', { childOf: directParent })

      sinon.assert.calledWith(inner.startSpan, 'name', sinon.match({ childOf: directParent }))
    })

    it('works without options', () => {
      const result = publicTracer.startSpan('name')

      assert.ok(result instanceof PublicSpan)
      sinon.assert.calledWith(inner.startSpan, 'name', undefined)
    })
  })

  describe('trace()', () => {
    it('forwards name, options and callback', () => {
      const cb = () => 'r'

      publicTracer.trace('a', { foo: 'bar' }, cb)

      sinon.assert.calledWith(inner.trace, 'a', { foo: 'bar' }, cb)
    })

    it('accepts the (name, fn) signature with default options', () => {
      const cb = () => 'r'

      publicTracer.trace('a', cb)

      sinon.assert.calledWith(inner.trace, 'a', {}, cb)
    })

    it('returns undefined and skips inner.trace when fn is not a function', () => {
      const result = publicTracer.trace('a', 'not-a-fn')

      assert.strictEqual(result, undefined)
      sinon.assert.notCalled(inner.trace)
    })

    it('marks SVC_SRC_KEY when options.service is set', () => {
      const cb = () => 'r'

      publicTracer.trace('a', { service: 'custom' }, cb)

      sinon.assert.calledWith(inner.trace, 'a', {
        service: 'custom',
        tags: { [SVC_SRC_KEY]: MANUAL },
      }, cb)
    })

    it('returns the inner tracer return value', () => {
      inner.trace.returns('inner-result')

      assert.strictEqual(publicTracer.trace('a', {}, () => {}), 'inner-result')
    })
  })

  describe('wrap()', () => {
    it('forwards name, options and callback', () => {
      const cb = () => 'r'

      publicTracer.wrap('a', { foo: 'bar' }, cb)

      sinon.assert.calledWith(inner.wrap, 'a', { foo: 'bar' }, cb)
    })

    it('accepts the (name, fn) signature with default options', () => {
      const cb = () => 'r'

      publicTracer.wrap('a', cb)

      sinon.assert.calledWith(inner.wrap, 'a', {}, cb)
    })

    it('returns the second argument unchanged when fn is not a function', () => {
      const result = publicTracer.wrap('a', 'b')

      assert.strictEqual(result, 'b')
      sinon.assert.notCalled(inner.wrap)
    })

    it('marks SVC_SRC_KEY when options.service is set', () => {
      const cb = () => 'r'

      publicTracer.wrap('a', { service: 'custom' }, cb)

      sinon.assert.calledWith(inner.wrap, 'a', {
        service: 'custom',
        tags: { [SVC_SRC_KEY]: MANUAL },
      }, cb)
    })

    it('returns the inner tracer return value', () => {
      inner.wrap.returns('inner-wrapped-fn')

      assert.strictEqual(publicTracer.wrap('a', {}, () => {}), 'inner-wrapped-fn')
    })
  })

  describe('inject()', () => {
    it('unwraps a PublicSpan before forwarding', () => {
      const innerSpan = {}
      const publicSpan = new PublicSpan(innerSpan)

      publicTracer.inject(publicSpan, 'fmt', 'carrier')

      sinon.assert.calledWith(inner.inject, innerSpan, 'fmt', 'carrier')
    })

    it('forwards non-PublicSpan contexts unchanged', () => {
      publicTracer.inject('ctx', 'fmt', 'carrier')

      sinon.assert.calledWith(inner.inject, 'ctx', 'fmt', 'carrier')
    })

    it('returns the inner tracer return value', () => {
      assert.strictEqual(publicTracer.inject('ctx', 'fmt', 'carrier'), 'inner-inject')
    })
  })

  describe('pure pass-through methods', () => {
    const cases = [
      { name: 'extract', chainable: false },
      { name: 'scope', chainable: false },
      { name: 'getRumData', chainable: false },
      { name: 'setUrl', chainable: true },
    ]

    for (const { name, chainable } of cases) {
      it(`${name}() forwards arguments to the inner tracer`, () => {
        publicTracer[name]('a', 2, { c: 3 })

        sinon.assert.calledOnceWithExactly(inner[name], 'a', 2, { c: 3 })
      })

      it(`${name}() ${chainable ? 'returns the PublicTracer (chainable)' : 'forwards the inner return value'}`, () => {
        const result = publicTracer[name]()

        if (chainable) {
          assert.strictEqual(result, publicTracer)
        } else {
          assert.strictEqual(result, `inner-${name}`)
        }
      })
    }
  })
})
