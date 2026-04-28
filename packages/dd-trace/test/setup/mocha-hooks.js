'use strict'

// Make `afterAll`/`afterEach` best-effort when the matching `before*` already failed: any error
// they throw is silently dropped so mocha can report the original cause instead of a follow-up
// `TypeError` masking it (`let foo / before assigns / after uses` pattern).

/** @typedef {{ _beforeAll?: { isFailed?: () => boolean }[] } & Record<string, any>} AnySuite */
/** @typedef {{ currentTest?: { state?: string } }} AnyCtx */
/** @typedef {(suite: AnySuite, ctx: AnyCtx) => boolean} ShouldSuppress */
/** @typedef {(...args: any[]) => any} AnyFn */

const Suite = /** @type {any} */ (require('mocha').Suite)

const prototypes = new WeakMap()

if (!prototypes.get(Suite.prototype)) {
  prototypes.set(Suite.prototype, true)

  patchAfter('afterAll', shouldSuppressAfterAll)
  patchAfter('afterEach', shouldSuppressAfterEach)
}

/** @type {ShouldSuppress} */
function shouldSuppressAfterAll (suite) {
  const hooks = suite?._beforeAll
  if (!Array.isArray(hooks)) return false
  for (const hook of hooks) {
    if (hook?.isFailed?.()) return true
  }
  return false
}

/** @type {ShouldSuppress} */
function shouldSuppressAfterEach (_suite, ctx) {
  return ctx?.currentTest?.state === 'failed'
}

/**
 * @param {'afterAll'|'afterEach'} method
 * @param {ShouldSuppress} shouldSuppress
 */
function patchAfter (method, shouldSuppress) {
  const original = Suite.prototype[method]
  Suite.prototype[method] =
    /** @this {AnySuite} @param {any} title @param {AnyFn=} fn */
    function patchedAfter (title, fn) {
      if (typeof title === 'function') {
        fn = title
        title = title.name
      }
      if (typeof fn !== 'function') return original.call(this, title, fn)
      return original.call(this, title, wrapAfter(fn, this, shouldSuppress))
    }
}

/**
 * @param {AnyFn} fn
 * @param {AnySuite} suite
 * @param {ShouldSuppress} shouldSuppress
 */
function wrapAfter (fn, suite, shouldSuppress) {
  // Preserve `fn.length` so mocha picks the right execution path (`this.async = fn && fn.length`).
  if (fn.length === 0) {
    return /** @this {AnyCtx} */ function wrappedAfter () {
      let result
      try {
        result = fn.call(this)
      } catch (err) {
        if (shouldSuppress(suite, this)) return
        throw err
      }
      if (result && typeof result.then === 'function') {
        return result.then(undefined, (/** @type {unknown} */ err) => {
          if (shouldSuppress(suite, this)) return
          throw err
        })
      }
      return result
    }
  }

  return (
    /**
     * @this {AnyCtx}
     * @param {(err?: unknown, ...rest: unknown[]) => void} done
     */
    function wrappedAfter (done) {
      try {
        fn.call(this, (/** @type {unknown} */ err, /** @type {unknown[]} */ ...rest) => {
          if (err && shouldSuppress(suite, this)) return done(undefined, ...rest)
          return done(err, ...rest)
        })
      } catch (err) {
        if (shouldSuppress(suite, this)) return done()
        throw err
      }
    }
  )
}
