'use strict'

const assert = require('node:assert/strict')
const { setImmediate } = require('node:timers/promises')

const { channel } = require('dc-polyfill')
const { describe, it } = require('mocha')

require('../src/playwright')

const PLAYWRIGHT_HOOKS = globalThis[Symbol.for('_ddtrace_instrumentations')].playwright
const RUNNER_HOOK = PLAYWRIGHT_HOOKS.find(entry => entry.file === 'lib/runner/runner.js').hook
const WORKER_HOOK = PLAYWRIGHT_HOOKS.find(entry => entry.file === 'lib/worker/workerMain.js').hook

class Runner {
  constructor () {
    this._config = {
      config: {
        rootDir: process.cwd(),
      },
      projects: [],
    }
  }

  /**
   * @returns {Promise<string>}
   */
  async runAllTests () {
    return 'passed'
  }
}

class WorkerMain {
  constructor () {
    this._project = { project: { name: 'chromium' } }
  }

  /**
   * @param {object} test
   * @returns {Promise<string>}
   */
  async _runTest (test) {
    this._currentTest = {
      annotations: [],
      retry: 0,
      status: 'passed',
      testId: test.id,
    }
    return 'passed'
  }

  runTestGroup () {}

  dispatchEvent () {}
}

RUNNER_HOOK({ Runner }, '1.38.0')
WORKER_HOOK({ WorkerMain }, '1.38.0')

describe('packages/datadog-instrumentations/src/playwright.js', () => {
  it('waits for session finalization before resolving the run', async () => {
    const libraryConfigurationCh = channel('ci:playwright:library-configuration')
    const sessionFinishCh = channel('ci:playwright:session:finish')
    let onDone
    let resolveSessionFinish
    const sessionFinishPromise = new Promise(resolve => {
      resolveSessionFinish = resolve
    })
    const onLibraryConfiguration = ({ onDone }) => onDone({ libraryConfig: {} })
    const onSessionFinish = ({ onDone: finish }) => {
      onDone = finish
      resolveSessionFinish()
    }

    libraryConfigurationCh.subscribe(onLibraryConfiguration)
    sessionFinishCh.subscribe(onSessionFinish)

    try {
      const runPromise = new Runner().runAllTests()

      await sessionFinishPromise

      let hasCompleted = false
      const completedPromise = (async () => {
        await runPromise
        hasCompleted = true
      })()

      await Promise.resolve()

      assert.strictEqual(hasCompleted, false)
      onDone()
      assert.strictEqual(await runPromise, 'passed')
      await completedPromise
    } finally {
      libraryConfigurationCh.unsubscribe(onLibraryConfiguration)
      sessionFinishCh.unsubscribe(onSessionFinish)
    }
  })

  it('completes when the session finish subscriber disables itself', async () => {
    const libraryConfigurationCh = channel('ci:playwright:library-configuration')
    const sessionFinishCh = channel('ci:playwright:session:finish')
    let resolveSessionFinish
    const sessionFinishPromise = new Promise(resolve => {
      resolveSessionFinish = resolve
    })
    const onLibraryConfiguration = ({ onDone }) => onDone({ libraryConfig: {} })
    const onSessionFinish = () => {
      sessionFinishCh.unsubscribe(onSessionFinish)
      resolveSessionFinish()
    }

    libraryConfigurationCh.subscribe(onLibraryConfiguration)
    sessionFinishCh.subscribe(onSessionFinish)

    try {
      const runPromise = new Runner().runAllTests()
      let result
      const completedPromise = (async () => {
        result = await runPromise
      })()

      await sessionFinishPromise
      await setImmediate()

      assert.strictEqual(result, 'passed')
      await completedPromise
    } finally {
      libraryConfigurationCh.unsubscribe(onLibraryConfiguration)
      sessionFinishCh.unsubscribe(onSessionFinish)
    }
  })

  it('completes a worker test when the finish subscriber disables itself', async () => {
    const testFinishCh = channel('ci:playwright:test:finish')
    let resolveTestFinish
    const testFinishPromise = new Promise(resolve => {
      resolveTestFinish = resolve
    })
    const onTestFinish = () => {
      testFinishCh.unsubscribe(onTestFinish)
      resolveTestFinish()
    }
    const test = {
      id: 'test-id',
      expectedStatus: 'passed',
      location: {
        file: '/project/test.spec.js',
        line: 1,
      },
      parent: {
        _hooks: [],
      },
      title: 'test name',
      _requireFile: '/project/test.spec.js',
    }

    testFinishCh.subscribe(onTestFinish)

    try {
      const runPromise = new WorkerMain()._runTest(test)
      let result
      const completedPromise = (async () => {
        result = await runPromise
      })()

      await testFinishPromise
      await setImmediate()

      assert.strictEqual(result, 'passed')
      await completedPromise
    } finally {
      testFinishCh.unsubscribe(onTestFinish)
    }
  })
})
