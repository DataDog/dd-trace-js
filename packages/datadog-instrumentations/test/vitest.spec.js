'use strict'

const assert = require('node:assert/strict')
const { setImmediate } = require('node:timers/promises')

const { channel } = require('dc-polyfill')
const { describe, it } = require('mocha')

require('../src/vitest-worker')

const VITEST_HOOKS = globalThis[Symbol.for('_ddtrace_instrumentations')]['@vitest/runner']

/**
 * Applies both `@vitest/runner` hooks (the fn/hook extractor and the `startTests`
 * suite-finish wrapper) to a package, matching what runs in a real worker, and
 * returns the wrapped `startTests`.
 *
 * @param {() => Promise<Array<{ tasks: unknown[], result: { state: string } }>>} startTests
 * @returns {() => Promise<Array<{ tasks: unknown[], result: { state: string } }>>}
 */
function wrapStartTests (startTests) {
  let vitestPackage = { startTests }
  for (const { hook } of VITEST_HOOKS) {
    vitestPackage = hook(vitestPackage, '3.0.0')
  }
  return vitestPackage.startTests
}

/**
 * @returns {() => Promise<Array<{ tasks: unknown[], result: { state: string } }>>}
 */
function createStartTests () {
  return async () => [{ tasks: [], result: { state: 'pass' } }]
}

describe('packages/datadog-instrumentations/src/vitest-worker.js', () => {
  it('waits for suite finalization before resolving startTests', async () => {
    const testSuiteFinishCh = channel('ci:vitest:test-suite:finish')
    let onDone
    let resolveSuiteFinish
    const suiteFinishPromise = new Promise(resolve => {
      resolveSuiteFinish = resolve
    })
    const onSuiteFinish = ({ onDone: finish, status }) => {
      assert.strictEqual(status, 'pass')
      onDone = finish
      resolveSuiteFinish()
    }

    testSuiteFinishCh.subscribe(onSuiteFinish)

    try {
      const startTests = wrapStartTests(createStartTests())

      let hasCompleted = false
      const startPromise = startTests([{ filepath: '/project/test.spec.js' }]).then(response => {
        hasCompleted = true
        return response
      })

      await suiteFinishPromise
      await Promise.resolve()

      assert.strictEqual(hasCompleted, false)
      onDone()

      const [{ result }] = await startPromise
      assert.strictEqual(result.state, 'pass')
    } finally {
      testSuiteFinishCh.unsubscribe(onSuiteFinish)
    }
  })

  it('completes when the suite finish subscriber disables itself during publication', async () => {
    const testSuiteFinishCh = channel('ci:vitest:test-suite:finish')
    let resolveSuiteFinish
    const suiteFinishPromise = new Promise(resolve => {
      resolveSuiteFinish = resolve
    })
    const onSuiteFinish = () => {
      testSuiteFinishCh.unsubscribe(onSuiteFinish)
      resolveSuiteFinish()
    }

    testSuiteFinishCh.subscribe(onSuiteFinish)

    try {
      const startTests = wrapStartTests(createStartTests())

      let response
      const startPromise = startTests([{ filepath: '/project/test.spec.js' }]).then(result => {
        response = result
      })

      await suiteFinishPromise
      await setImmediate()

      assert.deepStrictEqual(response, [{ tasks: [], result: { state: 'pass' } }])
      await startPromise
    } finally {
      testSuiteFinishCh.unsubscribe(onSuiteFinish)
    }
  })
})
