'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')

const { createWrapRouterMethod } = require('../src/router')
const { assertObjectContains } = require('../../../integration-tests/helpers')

// `createWrapRouterMethod` is exercised end-to-end by the express and router
// plugin specs, but those run over real HTTP and only ever dispatch 3-arg
// request handlers with a single matcher path. The new arity split, the
// multi-matcher loop, the no-subscriber fast paths, the sync-throw catches,
// and the `_name` resolution chain need explicit unit coverage so a future
// regression on any of them shows up here, not in a downstream tracer test.

/**
 * Minimal subset of an express/router `Layer` the wrap code reads. `regexp` is
 * the host's compiled mount regex — only `fast_star` / `fast_slash` matter for
 * the wrap-time short-circuit.
 * @typedef {{
 *   handle: Function,
 *   __handle?: Function,
 *   name?: string,
 *   path?: string,
 *   regexp?: { fast_star?: boolean, fast_slash?: boolean },
 * }} FakeLayer
 *
 * @typedef {{ stack: FakeLayer[] }} FakeRouter
 */

describe('createWrapRouterMethod', () => {
  let counter = 0
  let namespace
  let enterChannel
  let exitChannel
  let nextChannel
  let finishChannel
  let errorChannel
  let events
  let subscriptions

  beforeEach(() => {
    namespace = `router-spec-${++counter}`
    enterChannel = dc.channel(`apm:${namespace}:middleware:enter`)
    exitChannel = dc.channel(`apm:${namespace}:middleware:exit`)
    nextChannel = dc.channel(`apm:${namespace}:middleware:next`)
    finishChannel = dc.channel(`apm:${namespace}:middleware:finish`)
    errorChannel = dc.channel(`apm:${namespace}:middleware:error`)
    events = []
    subscriptions = []
  })

  afterEach(() => {
    for (const [channel, listener] of subscriptions) {
      channel.unsubscribe(listener)
    }
  })

  // Subscribe to the per-request middleware channels only. `apm:*:route:added`
  // publishes during the wrap step, before any request fires, so leaving it
  // unsubscribed keeps the recorded `events` ordering aligned with the
  // per-request lifecycle the assertions below check.
  function subscribeAll () {
    const all = [
      ['enter', enterChannel],
      ['exit', exitChannel],
      ['next', nextChannel],
      ['finish', finishChannel],
      ['error', errorChannel],
    ]
    for (const [label, channel] of all) {
      const listener = (data) => events.push({ label, data })
      channel.subscribe(listener)
      subscriptions.push([channel, listener])
    }
  }

  /**
   * Build a fake `.use`-shaped router method whose body appends one layer per
   * handler to `this.stack`. `layerPath` is the request-time `layer.path`
   * value the wrapped handler sees during the multi-matcher loop.
   *
   * @param {object} [options]
   * @param {string} [options.layerPath] Request path the layer reports.
   * @param {object} [options.regexp]    `{ fast_star, fast_slash }` overrides.
   * @returns {Function} The fake `.use` implementation.
   */
  function makeFakeUse ({ layerPath = '/some-path', regexp = {} } = {}) {
    function use (...args) {
      // Mirror the host shape: the first arg is a path or array of paths, the
      // rest are middleware. Plain handlers (`use(handler)`) start at index 0.
      const startIdx = typeof args[0] === 'function' ? 0 : 1
      for (let i = startIdx; i < args.length; i++) {
        const handler = args[i]
        if (typeof handler !== 'function') continue
        this.stack.push({ handle: handler, path: layerPath, regexp })
      }
    }
    return use
  }

  function compileRegex (pattern) {
    if (pattern instanceof RegExp) return pattern
    if (typeof pattern !== 'string') return undefined
    return new RegExp(`^${pattern.replace(/\//g, '\\/')}$`)
  }

  describe('request handler (3-arg) wrap', () => {
    it('publishes enter/next/finish/exit and captures the single-pattern route', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', function namedHandler (req, res, next) {
        next()
      })

      const req = { url: '/' }
      const res = {}
      const downstreamNext = () => events.push({ label: 'downstream-next' })

      router.stack[0].handle.call({}, req, res, downstreamNext)

      assert.deepStrictEqual(events.map(e => e.label), [
        'enter', 'next', 'finish', 'downstream-next', 'exit',
      ])
      assertObjectContains(events[0].data, {
        name: 'namedHandler',
        req,
        route: '/foo',
        layer: router.stack[0],
      })
    })

    it('matches a multi-pattern path against layer.path and captures the matching route', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/users' }))
      wrappedUse.call(router, ['/users', '/products'], function pickedFromList (req, res, next) {
        next()
      })

      const req = {}
      router.stack[0].handle.call({}, req, {}, () => {})

      const enterEvent = events.find(e => e.label === 'enter')
      assert.strictEqual(enterEvent.data.route, '/users')
    })

    it('leaves route undefined when no multi-pattern matcher matches', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/unrelated' }))
      wrappedUse.call(router, ['/users', '/products'], function noMatch (req, res, next) {
        next()
      })

      router.stack[0].handle.call({}, {}, {}, () => {})

      const enterEvent = events.find(e => e.label === 'enter')
      assert.strictEqual(enterEvent.data.route, undefined)
    })

    it('skips matcher analysis when the host passes a handler with no mount path', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      // `.use(handler)` with no mount path produces an empty matchers list.
      const wrappedUse = wrapMethod(makeFakeUse())
      wrappedUse.call(router, function rootHandler (req, res, next) {
        next()
      })

      router.stack[0].handle.call({}, {}, {}, () => {})

      const enterEvent = events.find(e => e.label === 'enter')
      assert.strictEqual(enterEvent.data.route, undefined)
    })

    it('short-circuits the matcher loop on a fast-star (`*`) layer', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const wrappedUse = wrapMethod(makeFakeUse({ regexp: { fast_star: true } }))
      wrappedUse.call(router, '*', function starHandler (req, res, next) {
        next()
      })

      router.stack[0].handle.call({}, {}, {}, () => {})

      const enterEvent = events.find(e => e.label === 'enter')
      assert.strictEqual(enterEvent.data.route, undefined)
    })

    it('short-circuits the matcher loop on a fast-slash (`/`) layer', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const wrappedUse = wrapMethod(makeFakeUse({ regexp: { fast_slash: true } }))
      wrappedUse.call(router, '/', function slashHandler (req, res, next) {
        next()
      })

      router.stack[0].handle.call({}, {}, {}, () => {})

      const enterEvent = events.find(e => e.label === 'enter')
      assert.strictEqual(enterEvent.data.route, undefined)
    })

    it('skips wrapping work when enterChannel has no subscribers', () => {
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      // With no subscriber on enterChannel the wrapped handler should forward
      // `this`, `req`, `res`, `next` and the return value straight through —
      // no allocation, no wrapNext, no channel publish.
      const captured = { thisArg: undefined, args: /** @type {unknown[]} */ ([]) }
      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', function (req, res, next) {
        captured.thisArg = this
        captured.args = [req, res, next]
        return 'forwarded-return'
      })

      const req = {}
      const res = {}
      const next = () => 'original-next'
      const ctx = { tag: 'this-arg' }

      const result = router.stack[0].handle.call(ctx, req, res, next)

      assert.strictEqual(result, 'forwarded-return')
      assert.strictEqual(captured.thisArg, ctx)
      assert.deepStrictEqual(captured.args, [req, res, next])
    })

    it('passes a non-function next through unchanged', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const captured = { next: /** @type {unknown} */ (undefined) }
      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', function (req, res, next) {
        captured.next = next
      })

      router.stack[0].handle.call({}, {}, {}, 'not-a-function')

      assert.strictEqual(captured.next, 'not-a-function')
    })

    it('publishes error/next/finish/exit when the handler throws synchronously', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const failure = new Error('boom')
      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', function thrower (req, res, next) {
        throw failure
      })

      const req = {}
      assert.throws(() => {
        router.stack[0].handle.call({}, req, {}, () => {})
      }, error => error === failure)

      // The throw skips the wrapped-next path; finish/exit publish via the
      // catch block before the throw is re-raised.
      assert.deepStrictEqual(events.map(e => e.label), [
        'enter', 'error', 'next', 'finish', 'exit',
      ])
      assert.strictEqual(events[1].data.error, failure)
      assert.strictEqual(events[1].data.req, req)
    })
  })

  describe('error handler (4-arg) wrap', () => {
    it('publishes enter/next/finish/exit and forwards error/req/res/next to the original', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      const received = /** @type {{ error?: Error, req?: object, res?: object }} */ ({})
      wrappedUse.call(router, '/foo', function errorHandler (error, req, res, next) {
        received.error = error
        received.req = req
        received.res = res
        // Real error handlers either call next() to continue, or next(error)
        // to keep propagating; both shapes go through wrappedNext.
        next()
      })

      const failure = new Error('upstream')
      const req = {}
      const res = {}
      const downstreamNext = () => events.push({ label: 'downstream-next' })

      router.stack[0].handle.call({}, failure, req, res, downstreamNext)

      assert.deepStrictEqual(events.map(e => e.label), [
        'enter', 'next', 'finish', 'downstream-next', 'exit',
      ])
      assert.strictEqual(received.error, failure)
      assert.strictEqual(received.req, req)
      assert.strictEqual(received.res, res)

      assertObjectContains(events[0].data, {
        name: 'errorHandler',
        req,
        route: '/foo',
        layer: router.stack[0],
      })
    })

    it('matches a multi-pattern path against layer.path and captures the matching route', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/products' }))
      wrappedUse.call(router, ['/users', '/products'], function (error, req, res, next) {
        next()
      })

      router.stack[0].handle.call({}, new Error('e'), {}, {}, () => {})

      const enterEvent = events.find(e => e.label === 'enter')
      assert.strictEqual(enterEvent.data.route, '/products')
    })

    it('leaves route undefined when no multi-pattern matcher matches', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/none' }))
      wrappedUse.call(router, ['/users', '/products'], function (error, req, res, next) {
        next()
      })

      router.stack[0].handle.call({}, new Error('e'), {}, {}, () => {})

      const enterEvent = events.find(e => e.label === 'enter')
      assert.strictEqual(enterEvent.data.route, undefined)
    })

    it('skips wrapping work when enterChannel has no subscribers', () => {
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const captured = { thisArg: undefined, args: /** @type {unknown[]} */ ([]) }
      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', function (error, req, res, next) {
        captured.thisArg = this
        captured.args = [error, req, res, next]
        return 'forwarded-return'
      })

      const failure = new Error('e')
      const req = {}
      const res = {}
      const next = () => {}
      const ctx = { tag: 'this-arg' }

      const result = router.stack[0].handle.call(ctx, failure, req, res, next)

      assert.strictEqual(result, 'forwarded-return')
      assert.strictEqual(captured.thisArg, ctx)
      assert.deepStrictEqual(captured.args, [failure, req, res, next])
    })

    it('passes a non-function next through unchanged', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const captured = { next: /** @type {unknown} */ (undefined) }
      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', function (error, req, res, next) {
        captured.next = next
      })

      router.stack[0].handle.call({}, new Error('e'), {}, {}, 'not-a-function')

      assert.strictEqual(captured.next, 'not-a-function')
    })

    it('publishes error/next/finish/exit when the handler throws synchronously', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const failure = new Error('throws-in-error-handler')
      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', function (error, req, res, next) {
        throw failure
      })

      const req = {}
      assert.throws(() => {
        router.stack[0].handle.call({}, new Error('upstream'), req, {}, () => {})
      }, error => error === failure)

      assert.deepStrictEqual(events.map(e => e.label), [
        'enter', 'error', 'next', 'finish', 'exit',
      ])
      assert.strictEqual(events[1].data.error, failure)
      assert.strictEqual(events[1].data.req, req)
    })
  })

  describe('handler name resolution', () => {
    it('prefers `original._name` when it is already set', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const handler = /** @type {Function & { _name?: string }} */ (
        function handlerWithCachedName (req, res, next) { next() }
      )
      handler._name = 'pre-cached'

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', handler)

      router.stack[0].handle.call({}, {}, {}, () => {})

      assert.strictEqual(events.find(e => e.label === 'enter').data.name, 'pre-cached')
    })

    it('falls back to `layer.name` when `_name` is missing and `layer.name` is set', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const wrappedUse = wrapMethod((handler) => {
        router.stack.push({ handle: handler, name: 'layer-named', path: '/foo', regexp: {} })
      })
      // The fake use above doesn't follow the standard signature; pass the
      // handler at the head of args so extractMatchers sees a function and
      // returns an empty matcher list.
      wrappedUse.call(router, (req, res, next) => next())

      router.stack[0].handle.call({}, {}, {}, () => {})

      assert.strictEqual(events.find(e => e.label === 'enter').data.name, 'layer-named')
    })

    it('falls back to `original.name` when both `_name` and `layer.name` are missing', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', function fallbackToOriginalName (req, res, next) {
        next()
      })

      router.stack[0].handle.call({}, {}, {}, () => {})

      assert.strictEqual(
        events.find(e => e.label === 'enter').data.name,
        'fallbackToOriginalName'
      )
    })

    it('caches the resolved name on `original._name` so the next wrap reuses it', () => {
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const handler = /** @type {Function & { _name?: string }} */ (
        function originalName (req, res, next) { next() }
      )
      assert.strictEqual(handler._name, undefined)

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', handler)

      assert.strictEqual(handler._name, 'originalName')
    })
  })

  describe('wrapNext', () => {
    it('does not publish errorChannel when next is called with no argument', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', (req, res, next) => next())

      router.stack[0].handle.call({}, {}, {}, () => {})

      assert.strictEqual(events.some(e => e.label === 'error'), false)
    })

    it('does not publish errorChannel on next("route")', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', (req, res, next) => next('route'))

      let receivedRouteToken
      router.stack[0].handle.call({}, {}, {}, (token) => { receivedRouteToken = token })

      assert.strictEqual(receivedRouteToken, 'route')
      assert.strictEqual(events.some(e => e.label === 'error'), false)
    })

    it('does not publish errorChannel on next("router")', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', (req, res, next) => next('router'))

      let receivedRouterToken
      router.stack[0].handle.call({}, {}, {}, (token) => { receivedRouterToken = token })

      assert.strictEqual(receivedRouterToken, 'router')
      assert.strictEqual(events.some(e => e.label === 'error'), false)
    })

    it('publishes errorChannel with the error when next is called with an Error', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      const failure = new Error('downstream-error')
      wrappedUse.call(router, '/foo', (req, res, next) => next(failure))

      const req = {}
      router.stack[0].handle.call({}, req, {}, () => {})

      const errorEvent = events.find(e => e.label === 'error')
      assert.ok(errorEvent, 'errorChannel should publish on next(error)')
      assert.strictEqual(errorEvent.data.error, failure)
      assert.strictEqual(errorEvent.data.req, req)
    })
  })

  describe('layer.__handle (express-async-errors compatibility)', () => {
    it('wraps `__handle` instead of `handle` when the layer exposes both', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const originalHandle = (req, res, next) => next()
      const originalUnderscoreHandle = function patchedHandle (req, res, next) {
        events.push({ label: '__handle-called' })
        next()
      }

      function fakeUseWithUnderscoreHandle (path, handler) {
        this.stack.push({
          handle: originalHandle,
          __handle: originalUnderscoreHandle,
          path: '/foo',
          regexp: {},
        })
      }

      const wrappedUse = wrapMethod(fakeUseWithUnderscoreHandle)
      wrappedUse.call(router, '/foo', () => {})

      // `handle` should be left alone; `__handle` should be the new wrapper.
      const wrappedLayer = router.stack[0]
      assert.strictEqual(wrappedLayer.handle, originalHandle)
      assert.notStrictEqual(wrappedLayer.__handle, originalUnderscoreHandle)
      assert.strictEqual(typeof wrappedLayer.__handle, 'function')

      const wrappedUnderscoreHandle = /** @type {Function} */ (wrappedLayer.__handle)
      wrappedUnderscoreHandle.call({}, {}, {}, () => {})

      assert.ok(
        events.find(e => e.label === '__handle-called'),
        'the inner __handle should run via the wrap'
      )
      assert.ok(events.find(e => e.label === 'enter'), 'enterChannel should publish for __handle')
    })
  })

  describe('re-entrant error subscriber', () => {
    it('drops the re-entrant publish when an error subscriber re-runs the layer', () => {
      // enterChannel needs a subscriber or the layer wrap takes the
      // no-subscriber fast path and never reaches wrapNext.
      const enterListener = () => {}
      enterChannel.subscribe(enterListener)
      subscriptions.push([enterChannel, enterListener])

      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = /** @type {FakeRouter} */ ({ stack: [] })

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', (req, res, next) => next(new Error('boom')))
      const handle = router.stack[0].handle

      // A subscriber that re-runs the same layer while handling the error loops
      // errorChannel -> subscriber -> next(error) -> errorChannel until the
      // stack overflows. The guard runs the subscriber once.
      let depth = 0
      const errorListener = () => {
        depth++
        if (depth > 50) return // safety stop: a regressed guard fails the assert, not the runner
        handle.call({}, {}, {}, () => {})
      }
      errorChannel.subscribe(errorListener)
      subscriptions.push([errorChannel, errorListener])

      handle.call({}, {}, {}, () => {})

      assert.strictEqual(depth, 1)
    })
  })
})
