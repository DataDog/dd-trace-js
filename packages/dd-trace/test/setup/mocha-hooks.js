'use strict'

// Drop afterAll/afterEach errors when an earlier runnable in the same suite already
// failed, so mocha reports the original cause instead of a teardown error masking it.

/** @typedef {import('mocha')} Mocha */
/**
 * Structural view of `Mocha.Suite` exposing the private hook arrays we need to
 * inspect; the runtime object is still a real `Mocha.Suite`.
 *
 * @typedef {object} Suite
 * @property {Mocha.Hook[]} [_beforeAll]
 * @property {Mocha.Hook[]} [_beforeEach]
 * @property {Mocha.Hook[]} [_afterEach]
 * @property {Mocha.Test[]} [tests]
 */
/** @typedef {(suite: Suite, ctx: Mocha.Context) => boolean} ShouldSuppress */
/** @typedef {Mocha.Func | Mocha.AsyncFunc} HookFn */

const { Suite: MochaSuite } = require('mocha')

const patched = new WeakSet()
if (!patched.has(MochaSuite.prototype)) {
  patched.add(MochaSuite.prototype)
  patchAfter('afterAll', shouldSuppressAfterAll)
  patchAfter('afterEach', shouldSuppressAfterEach)
}

/** @type {ShouldSuppress} */
function shouldSuppressAfterAll (suite) {
  return anyFailed(suite._beforeAll) ||
    anyFailed(suite._beforeEach) ||
    anyFailed(suite._afterEach) ||
    anyFailed(suite.tests)
}

/** @type {ShouldSuppress} */
function shouldSuppressAfterEach (suite, ctx) {
  return ctx.currentTest?.isFailed() === true || anyFailed(suite._beforeEach)
}

/** @param {Mocha.Runnable[] | undefined} runnables */
function anyFailed (runnables) {
  if (!Array.isArray(runnables)) return false
  for (const r of runnables) if (r?.isFailed?.()) return true
  return false
}

/**
 * @param {unknown} value
 * @returns {value is PromiseLike<unknown>}
 */
function isThenable (value) {
  return typeof value?.then === 'function'
}

/**
 * @param {'afterAll'|'afterEach'} method
 * @param {ShouldSuppress} shouldSuppress
 */
function patchAfter (method, shouldSuppress) {
  const proto = /** @type {Record<string, (title: string | HookFn, fn?: HookFn) => Mocha.Suite>} */ (
    /** @type {unknown} */ (MochaSuite.prototype)
  )
  const original = proto[method]
  /**
   * @this {Mocha.Suite}
   * @param {string | HookFn} title
   * @param {HookFn} [fn]
   */
  proto[method] = function patchedAfter (title, fn) {
    if (typeof title === 'function') {
      fn = title
      title = title.name
    }
    const suite = /** @type {Suite} */ (/** @type {unknown} */ (this))
    if (typeof fn !== 'function') return original.call(this, title, fn)
    return original.call(this, title, wrapAfter(fn, suite, shouldSuppress))
  }
}

/**
 * @param {HookFn} fn
 * @param {Suite} suite
 * @param {ShouldSuppress} shouldSuppress
 * @returns {HookFn}
 */
function wrapAfter (fn, suite, shouldSuppress) {
  // Preserve `fn.length` so mocha picks the right execution path (`this.async = fn && fn.length`).
  if (fn.length === 0) {
    /** @this {Mocha.Context} */
    return function wrappedAfter () {
      let result
      try {
        result = (/** @type {Mocha.AsyncFunc} */ (fn)).call(this)
      } catch (err) {
        if (shouldSuppress(suite, this)) return
        throw err
      }
      if (isThenable(result)) {
        return Promise.resolve(result).then(undefined, (err) => {
          if (shouldSuppress(suite, this)) return
          throw err
        })
      }
      return result
    }
  }

  /**
   * @this {Mocha.Context}
   * @param {Mocha.Done} done
   */
  return function wrappedAfter (done) {
    let result
    try {
      result = (/** @type {Mocha.Func} */ (fn)).call(this, (err) => {
        if (err && shouldSuppress(suite, this)) return done()
        return done(err)
      })
    } catch (err) {
      if (shouldSuppress(suite, this)) return done()
      throw err
    }
    // Returned for mocha's overspecification detection (callback + Promise return).
    return result
  }
}
