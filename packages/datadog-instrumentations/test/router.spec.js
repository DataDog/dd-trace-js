'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')

const { createWrapRouterMethod, createLayerDispatchWrappers } = require('../src/router')
const { assertObjectContains } = require('../../../integration-tests/helpers')

// `createWrapRouterMethod` annotates each layer with dispatch metadata;
// `createLayerDispatchWrappers` wraps the host's `Layer.prototype` dispatch to
// emit the middleware spans, without ever replacing `layer.handle`. The express
// and router plugin specs exercise this end-to-end over real HTTP, but only ever
// dispatch 3-arg request handlers with a single matcher path. The arity gate,
// the multi-matcher loop, the no-subscriber fast paths, the host-converted error
// path, and the `name` resolution chain need explicit unit coverage so a
// regression shows up here, not in a downstream tracer test.

/**
 * Build an express/router-shaped `Layer` whose prototype dispatch is wrapped by
 * the tracer. The `handle_request` / `handle_error` bodies mirror express 4 /
 * router 1.x: the arity gate and the host-owned try/catch that turns a thrown
 * handler into `next(error)`. The user handler stays on `this.handle`.
 *
 * @param {(original: Function) => Function} wrapLayerRequest
 * @param {(original: Function) => Function} wrapLayerError
 * @returns {new (handle: Function, options?: { path?: string, regexp?: object, name?: string }) => object}
 */
function makeLayerClass (wrapLayerRequest, wrapLayerError) {
  function FakeLayer (handle, { path = '/some-path', regexp = {}, name } = {}) {
    this.handle = handle
    this.path = path
    this.regexp = regexp
    if (name !== undefined) this.name = name
  }

  FakeLayer.prototype.handle_request = wrapLayerRequest(function hostHandleRequest (req, res, next) {
    const fn = this.handle
    if (fn.length > 3) return next()
    try {
      fn(req, res, next)
    } catch (error) {
      next(error)
    }
  })

  FakeLayer.prototype.handle_error = wrapLayerError(function hostHandleError (error, req, res, next) {
    const fn = this.handle
    if (fn.length !== 4) return next(error)
    try {
      fn(error, req, res, next)
    } catch (caught) {
      next(caught)
    }
  })

  return FakeLayer
}

describe('createWrapRouterMethod', () => {
  let counter = 0
  let namespace
  let FakeLayer
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
    const { wrapLayerRequest, wrapLayerError } = createLayerDispatchWrappers(namespace)
    FakeLayer = makeLayerClass(wrapLayerRequest, wrapLayerError)
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
   * Build a fake `.use`-shaped router method whose body appends one `FakeLayer`
   * per handler to `this.stack`. `wrapMethod` then annotates each new layer.
   *
   * @param {object} [options]
   * @param {string} [options.layerPath] Request path the layer reports.
   * @param {object} [options.regexp]    `{ fast_star, fast_slash }` overrides.
   * @returns {Function} The fake `.use` implementation.
   */
  function makeFakeUse ({ layerPath = '/some-path', regexp = {} } = {}) {
    return function use (...args) {
      // Mirror the host shape: the first arg is a path or array of paths, the
      // rest are middleware. Plain handlers (`use(handler)`) start at index 0.
      const startIdx = typeof args[0] === 'function' ? 0 : 1
      for (let i = startIdx; i < args.length; i++) {
        const handler = args[i]
        if (typeof handler !== 'function') continue
        this.stack.push(new FakeLayer(handler, { path: layerPath, regexp }))
      }
    }
  }

  function compileRegex (pattern) {
    if (pattern instanceof RegExp) return pattern
    if (typeof pattern !== 'string') return undefined
    return new RegExp(`^${pattern.replace(/\//g, '\\/')}$`)
  }

  describe('request handler (3-arg) dispatch', () => {
    it('publishes enter/next/finish/exit and captures the single-pattern route', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', function namedHandler (req, res, next) {
        next()
      })

      const req = { url: '/' }
      const res = {}
      const layer = router.stack[0]
      const downstreamNext = () => events.push({ label: 'downstream-next' })

      layer.handle_request(req, res, downstreamNext)

      assert.deepStrictEqual(events.map(e => e.label), [
        'enter', 'next', 'finish', 'downstream-next', 'exit',
      ])
      assertObjectContains(events[0].data, {
        name: 'namedHandler',
        req,
        route: '/foo',
        layer,
      })
    })

    it('matches a multi-pattern path against layer.path and captures the matching route', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/users' }))
      wrappedUse.call(router, ['/users', '/products'], function pickedFromList (req, res, next) {
        next()
      })

      router.stack[0].handle_request({}, {}, () => {})

      assert.strictEqual(events.find(e => e.label === 'enter').data.route, '/users')
    })

    it('leaves route undefined when no multi-pattern matcher matches', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/unrelated' }))
      wrappedUse.call(router, ['/users', '/products'], function noMatch (req, res, next) {
        next()
      })

      router.stack[0].handle_request({}, {}, () => {})

      assert.strictEqual(events.find(e => e.label === 'enter').data.route, undefined)
    })

    it('skips matcher analysis when the host passes a handler with no mount path', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      // `.use(handler)` with no mount path produces an empty matchers list.
      const wrappedUse = wrapMethod(makeFakeUse())
      wrappedUse.call(router, function rootHandler (req, res, next) {
        next()
      })

      router.stack[0].handle_request({}, {}, () => {})

      assert.strictEqual(events.find(e => e.label === 'enter').data.route, undefined)
    })

    it('short-circuits the matcher loop on a fast-star (`*`) layer', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const wrappedUse = wrapMethod(makeFakeUse({ regexp: { fast_star: true } }))
      wrappedUse.call(router, '*', function starHandler (req, res, next) {
        next()
      })

      router.stack[0].handle_request({}, {}, () => {})

      assert.strictEqual(events.find(e => e.label === 'enter').data.route, undefined)
    })

    it('short-circuits the matcher loop on a fast-slash (`/`) layer', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const wrappedUse = wrapMethod(makeFakeUse({ regexp: { fast_slash: true } }))
      wrappedUse.call(router, '/', function slashHandler (req, res, next) {
        next()
      })

      router.stack[0].handle_request({}, {}, () => {})

      assert.strictEqual(events.find(e => e.label === 'enter').data.route, undefined)
    })

    it('forwards the raw next and publishes nothing when enterChannel has no subscribers', () => {
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      // With no subscriber the wrapped dispatch forwards `req`, `res` and the
      // raw `next` straight through — no allocation, no wrapNext, no publish.
      const captured = { args: /** @type {unknown[]} */ ([]) }
      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', function (req, res, next) {
        captured.args = [req, res, next]
      })

      const req = {}
      const res = {}
      const next = () => {}

      router.stack[0].handle_request(req, res, next)

      assert.deepStrictEqual(captured.args, [req, res, next])
      assert.strictEqual(events.length, 0)
    })

    it('passes a non-function next through unchanged', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const captured = { next: /** @type {unknown} */ (undefined) }
      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', function (req, res, next) {
        captured.next = next
      })

      router.stack[0].handle_request({}, {}, 'not-a-function')

      assert.strictEqual(captured.next, 'not-a-function')
    })

    it('forwards through without a span when the layer was never annotated', () => {
      subscribeAll()

      // A layer the host created but dd-trace never ran through `.use` has no
      // side-table metadata, so the dispatch forwards straight through.
      const layer = new FakeLayer(function (req, res, next) { next() }, { path: '/foo' })

      let forwardedNext = false
      layer.handle_request({}, {}, () => { forwardedNext = true })

      assert.strictEqual(forwardedNext, true)
      assert.strictEqual(events.length, 0)
    })

    it('forwards a 4-arg error handler reached via the request path without a span', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', function errorHandler (error, req, res, next) {
        next()
      })

      // The host dispatches every matching layer through `handle_request`; the
      // arity gate forwards a 4-arg error handler on without a span.
      let forwardedNext = false
      router.stack[0].handle_request({}, {}, () => { forwardedNext = true })

      assert.strictEqual(forwardedNext, true)
      assert.strictEqual(events.length, 0)
    })

    it('routes a synchronous throw through next(error) and publishes error/next/finish/exit', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const failure = new Error('boom')
      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', function thrower (req, res, next) {
        throw failure
      })

      // The host dispatch catches the throw and converts it to next(error); the
      // tracer observes it through wrappedNext, never a re-thrown error.
      const req = {}
      let downstreamError
      router.stack[0].handle_request(req, {}, (error) => { downstreamError = error })

      assert.deepStrictEqual(events.map(e => e.label), [
        'enter', 'error', 'next', 'finish', 'exit',
      ])
      assert.strictEqual(events[1].data.error, failure)
      assert.strictEqual(events[1].data.req, req)
      assert.strictEqual(downstreamError, failure)
    })
  })

  describe('error handler (4-arg) dispatch', () => {
    it('publishes enter/next/finish/exit and forwards error/req/res/next to the handler', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      const received = /** @type {{ error?: Error, req?: object, res?: object }} */ ({})
      wrappedUse.call(router, '/foo', function errorHandler (error, req, res, next) {
        received.error = error
        received.req = req
        received.res = res
        next()
      })

      const failure = new Error('upstream')
      const req = {}
      const res = {}
      const downstreamNext = () => events.push({ label: 'downstream-next' })

      router.stack[0].handle_error(failure, req, res, downstreamNext)

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
      const router = { stack: [] }

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/products' }))
      wrappedUse.call(router, ['/users', '/products'], function (error, req, res, next) {
        next()
      })

      router.stack[0].handle_error(new Error('e'), {}, {}, () => {})

      assert.strictEqual(events.find(e => e.label === 'enter').data.route, '/products')
    })

    it('skips work when the layer is a 3-arg handler the host would not run as an error handler', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', function requestHandler (req, res, next) {
        next()
      })

      // A 3-arg handler reached via the error path: the arity gate forwards the
      // error to the next layer and publishes nothing.
      const failure = new Error('e')
      let forwarded
      router.stack[0].handle_error(failure, {}, {}, (error) => { forwarded = error })

      assert.strictEqual(forwarded, failure)
      assert.strictEqual(events.length, 0)
    })

    it('forwards the raw next and publishes nothing when enterChannel has no subscribers', () => {
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const captured = { args: /** @type {unknown[]} */ ([]) }
      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', function (error, req, res, next) {
        captured.args = [error, req, res, next]
      })

      const failure = new Error('e')
      const req = {}
      const res = {}
      const next = () => {}

      router.stack[0].handle_error(failure, req, res, next)

      assert.deepStrictEqual(captured.args, [failure, req, res, next])
      assert.strictEqual(events.length, 0)
    })

    it('forwards through without a span when the layer was never annotated', () => {
      subscribeAll()

      const layer = new FakeLayer(function (error, req, res, next) { next(error) }, { path: '/foo' })

      const failure = new Error('e')
      let forwarded
      layer.handle_error(failure, {}, {}, (error) => { forwarded = error })

      assert.strictEqual(forwarded, failure)
      assert.strictEqual(events.length, 0)
    })

    it('passes a non-function next through unchanged', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const captured = { next: /** @type {unknown} */ (undefined) }
      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', function (error, req, res, next) {
        captured.next = next
      })

      router.stack[0].handle_error(new Error('e'), {}, {}, 'not-a-function')

      assert.strictEqual(captured.next, 'not-a-function')
    })

    it('routes a synchronous throw through next(error) and publishes error/next/finish/exit', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const failure = new Error('throws-in-error-handler')
      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', function (error, req, res, next) {
        throw failure
      })

      const req = {}
      let downstreamError
      router.stack[0].handle_error(new Error('upstream'), req, {}, (error) => { downstreamError = error })

      assert.deepStrictEqual(events.map(e => e.label), [
        'enter', 'error', 'next', 'finish', 'exit',
      ])
      assert.strictEqual(events[1].data.error, failure)
      assert.strictEqual(events[1].data.req, req)
      assert.strictEqual(downstreamError, failure)
    })
  })

  describe('handler name resolution', () => {
    it('prefers `original._name` when it is already set', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const handler = /** @type {Function & { _name?: string }} */ (
        function handlerWithCachedName (req, res, next) { next() }
      )
      handler._name = 'pre-cached'

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', handler)

      router.stack[0].handle_request({}, {}, () => {})

      assert.strictEqual(events.find(e => e.label === 'enter').data.name, 'pre-cached')
    })

    it('falls back to `layer.name` when `_name` is missing and `layer.name` is set', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const wrappedUse = wrapMethod(function use (handler) {
        this.stack.push(new FakeLayer(handler, { name: 'layer-named', path: '/foo' }))
      })
      wrappedUse.call(router, (req, res, next) => next())

      router.stack[0].handle_request({}, {}, () => {})

      assert.strictEqual(events.find(e => e.label === 'enter').data.name, 'layer-named')
    })

    it('falls back to `original.name` when both `_name` and `layer.name` are missing', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', function fallbackToOriginalName (req, res, next) {
        next()
      })

      router.stack[0].handle_request({}, {}, () => {})

      assert.strictEqual(
        events.find(e => e.label === 'enter').data.name,
        'fallbackToOriginalName'
      )
    })

    it('does not mutate the user handler to cache the resolved name', () => {
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const handler = /** @type {Function & { _name?: string }} */ (
        function originalName (req, res, next) { next() }
      )

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', handler)

      // The resolved name lives in the layer-meta side table; the user's handler
      // function is left untouched (no `_name` written back onto it).
      assert.strictEqual(handler._name, undefined)
      assert.strictEqual(router.stack[0].handle, handler)
    })
  })

  describe('wrapNext', () => {
    it('does not publish errorChannel when next is called with no argument', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', (req, res, next) => next())

      router.stack[0].handle_request({}, {}, () => {})

      assert.strictEqual(events.some(e => e.label === 'error'), false)
    })

    it('does not publish errorChannel on next("route")', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', (req, res, next) => next('route'))

      let receivedRouteToken
      router.stack[0].handle_request({}, {}, (token) => { receivedRouteToken = token })

      assert.strictEqual(receivedRouteToken, 'route')
      assert.strictEqual(events.some(e => e.label === 'error'), false)
    })

    it('does not publish errorChannel on next("router")', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', (req, res, next) => next('router'))

      let receivedRouterToken
      router.stack[0].handle_request({}, {}, (token) => { receivedRouterToken = token })

      assert.strictEqual(receivedRouterToken, 'router')
      assert.strictEqual(events.some(e => e.label === 'error'), false)
    })

    it('publishes errorChannel with the error when next is called with an Error', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      const failure = new Error('downstream-error')
      wrappedUse.call(router, '/foo', (req, res, next) => next(failure))

      const req = {}
      router.stack[0].handle_request(req, {}, () => {})

      const errorEvent = events.find(e => e.label === 'error')
      assert.ok(errorEvent, 'errorChannel should publish on next(error)')
      assert.strictEqual(errorEvent.data.error, failure)
      assert.strictEqual(errorEvent.data.req, req)
    })
  })

  describe('pristine layer.handle', () => {
    it('leaves layer.handle as the user function so phase-sorting hosts can find it', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      function userHandler (req, res, next) { next() }

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', userHandler)

      // The whole point of the prototype-dispatch design: the layer's handle is
      // never swapped for a wrapper, so loopback's `_findLayerByHandler` can map
      // the layer back to the user handler.
      assert.strictEqual(router.stack[0].handle, userHandler)

      // Tracing still happens, via the wrapped prototype dispatch.
      router.stack[0].handle_request({}, {}, () => {})
      assert.ok(events.find(e => e.label === 'enter'))
    })
  })

  describe('express-async-errors on a prototype-dispatch host', () => {
    // express-async-errors (on express 4.3.0+) redefines `handle` as a
    // getter/setter that stores a wrapped fn in `__handle` and turns a rejected
    // promise into `next(error)`. The wrap preserves the handler arity. It
    // patches `handle` only, never `handle_request`, so the tracer's prototype
    // dispatch wrap survives and the arity gate still sees the real handler.
    function asyncErrorsWrap (fn) {
      const wrapped = function (...args) {
        const ret = fn.apply(this, args)
        const next = args.at(-1)
        if (typeof ret?.catch === 'function') ret.catch(error => next(error))
        return ret
      }
      Object.defineProperty(wrapped, 'length', { value: fn.length, configurable: true })
      return wrapped
    }

    // A host `.use` that builds a prototype-dispatch layer carrying the
    // express-async-errors `handle` getter/setter, so `layer.handle = fn`
    // stores the wrapped handler in `__handle`.
    function asyncErrorsUse (path, handler) {
      const layer = Object.create(FakeLayer.prototype)
      layer.path = '/foo'
      layer.regexp = {}
      Object.defineProperty(layer, 'handle', {
        enumerable: true,
        get () { return this.__handle },
        set (fn) { this.__handle = asyncErrorsWrap(fn) },
      })
      layer.handle = handler
      this.stack.push(layer)
    }

    it('keeps the handle pristine and the arity gate intact', () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const wrappedUse = wrapMethod(asyncErrorsUse)
      wrappedUse.call(router, '/foo', function requestHandler (req, res, next) { next() })

      const layer = router.stack[0]
      // The async-errors wrap is a 3-arg function, so the request gate runs it.
      assert.strictEqual(layer.handle.length, 3)

      layer.handle_request({}, {}, () => {})
      assert.ok(events.find(e => e.label === 'enter'), 'middleware:enter should publish')
    })

    it('routes a rejected promise through wrappedNext and publishes the error', async () => {
      subscribeAll()
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const failure = new Error('async-boom')
      const wrappedUse = wrapMethod(asyncErrorsUse)
      wrappedUse.call(router, '/foo', async function asyncHandler () { throw failure })

      const req = {}
      let downstreamError
      router.stack[0].handle_request(req, {}, (error) => { downstreamError = error })

      // The rejection settles on a microtask; the async-errors wrap forwards it
      // to `next`, which here is the tracer's wrappedNext.
      await new Promise(resolve => setImmediate(resolve))

      const errorEvent = events.find(e => e.label === 'error')
      assert.ok(errorEvent, 'the rejected promise should reach wrappedNext -> error')
      assert.strictEqual(errorEvent.data.error, failure)
      assert.strictEqual(errorEvent.data.req, req)
      assert.strictEqual(downstreamError, failure)
    })
  })

  describe('legacy handle replacement (host without prototype dispatch)', () => {
    // express <4.6.0 has no `Layer.prototype.handle_request`; the router calls
    // `layer.handle` directly, so the handle is replaced in place.
    function legacyUse (path, handler) {
      this.stack.push({ handle: handler, path: '/foo', regexp: {} })
    }

    // Mirror express <4.6.0's `router.handle`: it runs `layer.handle` itself and,
    // on a synchronous throw, catches *outside* the layer and calls its own
    // `next(error)` — never the `next` the layer was handed. The tracer cannot
    // observe the throw through `wrappedNext`, so the legacy handle wrap has to
    // catch and publish error/next/finish itself before rethrowing.
    function legacyDispatch (layer, { req = {}, res = {}, error } = {}) {
      const hostNext = (nextError) => events.push({ label: 'host-next', error: nextError })
      try {
        if (error === undefined) {
          layer.handle(req, res, hostNext)
        } else {
          layer.handle(error, req, res, hostNext)
        }
      } catch (caught) {
        hostNext(caught)
      }
    }

    it('replaces layer.handle, preserves request arity, and traces the dispatch', () => {
      subscribeAll()
      const { wrapLegacyHandle } = createLayerDispatchWrappers(namespace)
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex, wrapLegacyHandle)
      const router = { stack: [] }

      function originalHandler (req, res, next) { next() }
      const wrappedUse = wrapMethod(legacyUse)
      wrappedUse.call(router, '/foo', originalHandler)

      const layer = router.stack[0]
      assert.notStrictEqual(layer.handle, originalHandler)
      assert.strictEqual(layer.handle.length, 3)

      const req = {}
      const downstreamNext = () => events.push({ label: 'downstream-next' })
      layer.handle(req, {}, downstreamNext)

      assert.deepStrictEqual(events.map(e => e.label), [
        'enter', 'next', 'finish', 'downstream-next', 'exit',
      ])
      assertObjectContains(events[0].data, { name: 'originalHandler', req, route: '/foo', layer })
    })

    it('preserves error-handler arity (4) so the host still routes errors', () => {
      subscribeAll()
      const { wrapLegacyHandle } = createLayerDispatchWrappers(namespace)
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex, wrapLegacyHandle)
      const router = { stack: [] }

      const wrappedUse = wrapMethod(legacyUse)
      wrappedUse.call(router, '/foo', function errorHandler (error, req, res, next) { next() })

      const layer = router.stack[0]
      assert.strictEqual(layer.handle.length, 4)

      const req = {}
      layer.handle(new Error('e'), req, {}, () => {})

      const enterEvent = events.find(e => e.label === 'enter')
      assert.strictEqual(enterEvent.data.name, 'errorHandler')
      assert.strictEqual(enterEvent.data.req, req)
    })

    it('publishes error/next/finish/exit when a request handler throws and rethrows to the host', () => {
      subscribeAll()
      const { wrapLegacyHandle } = createLayerDispatchWrappers(namespace)
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex, wrapLegacyHandle)
      const router = { stack: [] }

      const failure = new Error('boom')
      const wrappedUse = wrapMethod(legacyUse)
      wrappedUse.call(router, '/foo', function thrower (req, res, next) { throw failure })

      const req = {}
      legacyDispatch(router.stack[0], { req })

      // The host catches the rethrown error and routes it through its own next,
      // but the tracer has already tagged and finished the throwing layer.
      assert.deepStrictEqual(events.map(e => e.label), [
        'enter', 'error', 'next', 'finish', 'exit', 'host-next',
      ])
      assert.strictEqual(events[1].data.error, failure)
      assert.strictEqual(events[1].data.req, req)
      assert.strictEqual(events.at(-1).error, failure)
    })

    it('publishes error/next/finish/exit when an error handler throws and rethrows to the host', () => {
      subscribeAll()
      const { wrapLegacyHandle } = createLayerDispatchWrappers(namespace)
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex, wrapLegacyHandle)
      const router = { stack: [] }

      const failure = new Error('throws-in-error-handler')
      const wrappedUse = wrapMethod(legacyUse)
      wrappedUse.call(router, '/foo', function errorHandler (error, req, res, next) { throw failure })

      const req = {}
      legacyDispatch(router.stack[0], { req, error: new Error('upstream') })

      assert.deepStrictEqual(events.map(e => e.label), [
        'enter', 'error', 'next', 'finish', 'exit', 'host-next',
      ])
      assert.strictEqual(events[1].data.error, failure)
      assert.strictEqual(events[1].data.req, req)
      assert.strictEqual(events.at(-1).error, failure)
    })

    it('leaves handle pristine when the layer has a prototype dispatch method', () => {
      const { wrapLegacyHandle } = createLayerDispatchWrappers(namespace)
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex, wrapLegacyHandle)
      const router = { stack: [] }

      function originalHandler (req, res, next) { next() }
      // `makeFakeUse` produces layers with `handle_request`, so the legacy
      // fallback must not touch them even though it is available.
      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', originalHandler)

      assert.strictEqual(router.stack[0].handle, originalHandler)
    })

    it('forwards through without tracing when enterChannel has no subscribers', () => {
      const { wrapLegacyHandle } = createLayerDispatchWrappers(namespace)
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex, wrapLegacyHandle)
      const router = { stack: [] }

      let handlerRan = false
      const wrappedUse = wrapMethod(legacyUse)
      wrappedUse.call(router, '/foo', function (req, res, next) {
        handlerRan = true
        next()
      })

      let nextCalled = false
      router.stack[0].handle({}, {}, () => { nextCalled = true })

      assert.strictEqual(handlerRan, true)
      assert.strictEqual(nextCalled, true)
      assert.strictEqual(events.length, 0)
    })

    it('wraps __handle instead of handle for express-async-errors layers', () => {
      subscribeAll()
      const { wrapLegacyHandle } = createLayerDispatchWrappers(namespace)
      const wrapMethod = createWrapRouterMethod(namespace, compileRegex, wrapLegacyHandle)
      const router = { stack: [] }

      const originalHandle = (req, res, next) => next()
      function underscoreHandle (req, res, next) {
        events.push({ label: '__handle-called' })
        next()
      }

      const wrappedUse = wrapMethod(function use (path, handler) {
        this.stack.push({ handle: originalHandle, __handle: underscoreHandle, path: '/foo', regexp: {} })
      })
      wrappedUse.call(router, '/foo', () => {})

      const layer = router.stack[0]
      assert.strictEqual(layer.handle, originalHandle)
      assert.notStrictEqual(layer.__handle, underscoreHandle)

      layer.__handle({}, {}, () => {})

      assert.ok(events.find(e => e.label === '__handle-called'))
      assert.ok(events.find(e => e.label === 'enter'))
    })
  })

  describe('re-entrant error subscriber', () => {
    it('drops the re-entrant publish when an error subscriber re-runs the layer', () => {
      // enterChannel needs a subscriber or the layer dispatch takes the
      // no-subscriber fast path and never reaches wrapNext.
      const enterListener = () => {}
      enterChannel.subscribe(enterListener)
      subscriptions.push([enterChannel, enterListener])

      const wrapMethod = createWrapRouterMethod(namespace, compileRegex)
      const router = { stack: [] }

      const wrappedUse = wrapMethod(makeFakeUse({ layerPath: '/foo' }))
      wrappedUse.call(router, '/foo', (req, res, next) => next(new Error('boom')))
      const layer = router.stack[0]

      // A subscriber that re-runs the same layer while handling the error loops
      // errorChannel -> subscriber -> next(error) -> errorChannel until the
      // stack overflows. The guard runs the subscriber once.
      let depth = 0
      const errorListener = () => {
        depth++
        if (depth > 50) return // safety stop: a regressed guard fails the assert, not the runner
        layer.handle_request({}, {}, () => {})
      }
      errorChannel.subscribe(errorListener)
      subscriptions.push([errorChannel, errorListener])

      layer.handle_request({}, {}, () => {})

      assert.strictEqual(depth, 1)
    })
  })
})
