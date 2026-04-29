'use strict'

// Drop afterAll/afterEach errors when an earlier runnable in the same test or suite already failed,
// so mocha reports the original cause instead of a teardown error masking it.

/** @typedef {import('mocha')} Mocha */

const { Hook, Runner } = require('mocha')

const patched = new WeakSet()
const failedSuites = new WeakSet()
const failedTests = new WeakSet()

if (!patched.has(Runner.prototype)) {
  patched.add(Runner.prototype)

  const fail = Runner.prototype.fail
  const runHook = Hook.prototype.run

  /**
   * @this {Mocha.Runner}
   * @param {Mocha.Runnable} runnable
   * @param {Error} err
   * @param {boolean} [force]
   */
  Runner.prototype.fail = function patchedFail (runnable, err, force) {
    if (shouldSuppress(runnable)) return

    fail.call(this, runnable, err, force)
    markFailed(runnable)
  }

  /**
   * @this {Mocha.Hook}
   * @param {(err?: Error) => void} fn
   */
  Hook.prototype.run = function patchedRunHook (fn) {
    try {
      return runHook.call(this, (err) => {
        return fn(err && shouldSuppress(this) ? undefined : err)
      })
    } catch (err) {
      if (shouldSuppress(this)) return fn()
      throw err
    }
  }
}

/** @param {Mocha.Runnable} runnable */
function markFailed (runnable) {
  const test = currentTest(runnable)
  if (test) failedTests.add(test)

  let suite = runnable.parent
  while (suite) {
    failedSuites.add(suite)
    suite = suite.parent
  }
}

/**
 * @param {Mocha.Runnable} runnable
 * @returns {boolean}
 */
function shouldSuppress (runnable) {
  if (isAfterEach(runnable)) {
    const test = currentTest(runnable)
    return test ? failedTests.has(test) : false
  }

  return isAfterAll(runnable) && failedSuites.has(runnable.parent)
}

/**
 * @param {Mocha.Runnable} runnable
 * @returns {Mocha.Test | undefined}
 */
function currentTest (runnable) {
  return runnable.type === 'test' ? runnable : runnable.ctx?.currentTest
}

/**
 * @param {Mocha.Runnable} runnable
 * @returns {boolean}
 */
function isAfterAll (runnable) {
  return runnable.type === 'hook' && runnable.title.startsWith('"after all" hook')
}

/**
 * @param {Mocha.Runnable} runnable
 * @returns {boolean}
 */
function isAfterEach (runnable) {
  return runnable.type === 'hook' && runnable.title.startsWith('"after each" hook')
}
