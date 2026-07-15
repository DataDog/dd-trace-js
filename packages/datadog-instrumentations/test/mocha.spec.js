'use strict'

const assert = require('node:assert/strict')
const { setImmediate } = require('node:timers/promises')

const { channel } = require('dc-polyfill')
const Mocha = require('mocha')

require('../src/mocha/main')

const MOCHA_HOOKS = globalThis[Symbol.for('_ddtrace_instrumentations')].mocha
const RUNNER_HOOK = MOCHA_HOOKS.find(entry => entry.file === 'lib/runner.js').hook

RUNNER_HOOK(Mocha.Runner, '11.7.6')

class SilentReporter {}

/**
 * @returns {Mocha}
 */
function createMocha () {
  const mocha = new Mocha({ reporter: SilentReporter })
  const suite = Mocha.Suite.create(mocha.suite, 'suite')
  const test = new Mocha.Test('passes', () => {})

  suite.file = '/project/test.spec.js'
  test.file = suite.file
  suite.addTest(test)

  return mocha
}

describe('packages/datadog-instrumentations/src/mocha/main.js', () => {
  it('waits for session finalization before completing the run', async () => {
    const testFinishCh = channel('ci:mocha:test:finish')
    const sessionFinishCh = channel('ci:mocha:session:finish')
    let onDone
    let resolveSessionFinish
    const sessionFinishPromise = new Promise(resolve => {
      resolveSessionFinish = resolve
    })
    const onTestFinish = () => {}
    const onSessionFinish = ({ onDone: finish }) => {
      onDone = finish
      resolveSessionFinish()
    }

    testFinishCh.subscribe(onTestFinish)
    sessionFinishCh.subscribe(onSessionFinish)

    try {
      let result
      const runPromise = new Promise(resolve => {
        createMocha().run(failures => {
          result = failures
          resolve(failures)
        })
      })

      await sessionFinishPromise
      await Promise.resolve()

      assert.strictEqual(result, undefined)
      onDone()
      assert.strictEqual(await runPromise, 0)
    } finally {
      testFinishCh.unsubscribe(onTestFinish)
      sessionFinishCh.unsubscribe(onSessionFinish)
    }
  })

  it('completes when the session finish subscriber disables itself', async () => {
    const testFinishCh = channel('ci:mocha:test:finish')
    const sessionFinishCh = channel('ci:mocha:session:finish')
    let resolveSessionFinish
    const sessionFinishPromise = new Promise(resolve => {
      resolveSessionFinish = resolve
    })
    const onTestFinish = () => {}
    const onSessionFinish = () => {
      sessionFinishCh.unsubscribe(onSessionFinish)
      resolveSessionFinish()
    }

    testFinishCh.subscribe(onTestFinish)
    sessionFinishCh.subscribe(onSessionFinish)

    try {
      let result
      const runPromise = new Promise(resolve => {
        createMocha().run(failures => {
          result = failures
          resolve(failures)
        })
      })

      await sessionFinishPromise
      await setImmediate()

      assert.strictEqual(result, 0)
      await runPromise
    } finally {
      testFinishCh.unsubscribe(onTestFinish)
      sessionFinishCh.unsubscribe(onSessionFinish)
    }
  })
})
