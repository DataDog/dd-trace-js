'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { after, before, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const log = require('../../dd-trace/src/log')
const instrumentations = require('../src/helpers/instrumentations')

const CUCUMBER_PATH = require.resolve('../src/cucumber')
const FLUSH_TIMEOUT = 10_000

/**
 * @typedef {object} LibraryConfiguration
 * @property {Record<string, unknown>} libraryConfig
 * @property {string} repositoryRoot
 */

class Coordinator {
  constructor () {
    this.options = {}
    this.sourcedPickles = []
  }

  async run () {
    return true
  }
}

/**
 * @param {{ onDone: (configuration: LibraryConfiguration) => void }} message
 */
function onLibraryConfiguration ({ onDone }) {
  onDone({
    libraryConfig: {},
    repositoryRoot: process.cwd(),
  })
}

describe('packages/datadog-instrumentations/src/cucumber.js', () => {
  let clock
  let coordinatorHook
  let cucumberHooks
  let hadCucumberHooks
  let originalHookCount
  let WrappedCoordinator

  before(() => {
    clock = sinon.useFakeTimers()
    hadCucumberHooks = instrumentations['@cucumber/cucumber'] !== undefined
    originalHookCount = instrumentations['@cucumber/cucumber']?.length ?? 0
    delete require.cache[CUCUMBER_PATH]
    require(CUCUMBER_PATH)
    cucumberHooks = instrumentations['@cucumber/cucumber']
    coordinatorHook = cucumberHooks.slice(originalHookCount)
      .find((entry) => entry.file === 'lib/runtime/coordinator.js').hook
    WrappedCoordinator = coordinatorHook({ Coordinator }, '13.0.0').Coordinator
  })

  beforeEach(() => {
    clock.reset()
  })

  after(() => {
    if (hadCucumberHooks) {
      cucumberHooks.length = originalHookCount
    } else {
      delete instrumentations['@cucumber/cucumber']
    }
    delete require.cache[CUCUMBER_PATH]
    clock.restore()
  })

  it('waits for session finalization before resolving the coordinator run', async () => {
    const libraryConfigurationCh = channel('ci:cucumber:library-configuration')
    const sessionFinishCh = channel('ci:cucumber:session:finish')
    let onDone
    let resolveSessionFinish
    const sessionFinishPromise = new Promise(resolve => {
      resolveSessionFinish = resolve
    })
    const onSessionFinish = ({ onDone: finish }) => {
      onDone = finish
      resolveSessionFinish()
    }

    libraryConfigurationCh.subscribe(onLibraryConfiguration)
    sessionFinishCh.subscribe(onSessionFinish)

    try {
      const runPromise = new WrappedCoordinator().run()

      await sessionFinishPromise

      assert.strictEqual(typeof onDone, 'function')

      let hasCompleted = false
      const completedPromise = (async () => {
        await runPromise
        hasCompleted = true
      })()

      await Promise.resolve()

      assert.strictEqual(hasCompleted, false)
      onDone()
      assert.strictEqual(await runPromise, true)
      await completedPromise
      assert.strictEqual(clock.countTimers(), 0)
    } finally {
      libraryConfigurationCh.unsubscribe(onLibraryConfiguration)
      sessionFinishCh.unsubscribe(onSessionFinish)
    }
  })

  it('completes when the session finish subscriber disables itself', async () => {
    const libraryConfigurationCh = channel('ci:cucumber:library-configuration')
    const sessionFinishCh = channel('ci:cucumber:session:finish')
    let resolveSessionFinish
    const sessionFinishPromise = new Promise(resolve => {
      resolveSessionFinish = resolve
    })
    const onSessionFinish = () => {
      sessionFinishCh.unsubscribe(onSessionFinish)
      resolveSessionFinish()
    }

    libraryConfigurationCh.subscribe(onLibraryConfiguration)
    sessionFinishCh.subscribe(onSessionFinish)

    try {
      const runPromise = new WrappedCoordinator().run()
      let result
      const completedPromise = (async () => {
        result = await runPromise
      })()

      await sessionFinishPromise
      await clock.tickAsync(0)

      assert.strictEqual(result, true)
      await completedPromise
    } finally {
      libraryConfigurationCh.unsubscribe(onLibraryConfiguration)
      sessionFinishCh.unsubscribe(onSessionFinish)
    }
  })

  it('starts the flush timeout only after a long-running test run completes', async () => {
    const libraryConfigurationCh = channel('ci:cucumber:library-configuration')
    const sessionFinishCh = channel('ci:cucumber:session:finish')
    let onDone
    let resolveRun
    let resolveRunStarted
    let resolveSessionFinish
    const runStartedPromise = new Promise(resolve => {
      resolveRunStarted = resolve
    })
    const sessionFinishPromise = new Promise(resolve => {
      resolveSessionFinish = resolve
    })
    const onSessionFinish = ({ onDone: finish }) => {
      onDone = finish
      resolveSessionFinish()
    }
    class LongRunningCoordinator extends Coordinator {
      run () {
        resolveRunStarted()
        return new Promise(resolve => {
          resolveRun = resolve
        })
      }
    }

    libraryConfigurationCh.subscribe(onLibraryConfiguration)
    sessionFinishCh.subscribe(onSessionFinish)

    try {
      const { Coordinator: WrappedCoordinator } = coordinatorHook({ Coordinator: LongRunningCoordinator }, '13.0.0')
      const runPromise = new WrappedCoordinator().run()
      let result
      const completedPromise = (async () => {
        result = await runPromise
      })()

      await runStartedPromise
      await clock.tickAsync(FLUSH_TIMEOUT + 1)

      assert.strictEqual(onDone, undefined)

      resolveRun(true)
      await sessionFinishPromise
      await clock.runMicrotasks()

      assert.strictEqual(result, undefined)

      onDone()
      await completedPromise

      assert.strictEqual(result, true)
    } finally {
      onDone?.()
      libraryConfigurationCh.unsubscribe(onLibraryConfiguration)
      sessionFinishCh.unsubscribe(onSessionFinish)
    }
  })

  it('stops waiting when the final flush reaches its timeout', async () => {
    const libraryConfigurationCh = channel('ci:cucumber:library-configuration')
    const sessionFinishCh = channel('ci:cucumber:session:finish')
    let onDone
    let resolveSessionFinish
    let result
    const logError = sinon.stub(log, 'error')
    const sessionFinishPromise = new Promise(resolve => {
      resolveSessionFinish = resolve
    })
    const onSessionFinish = ({ onDone: finish }) => {
      onDone = finish
      resolveSessionFinish()
    }

    libraryConfigurationCh.subscribe(onLibraryConfiguration)
    sessionFinishCh.subscribe(onSessionFinish)

    try {
      const completedPromise = (async () => {
        result = await new WrappedCoordinator().run()
      })()

      await sessionFinishPromise
      await clock.tickAsync(FLUSH_TIMEOUT - 1)
      assert.strictEqual(result, undefined)

      await clock.tickAsync(1)
      await clock.runAllAsync()
      assert.strictEqual(result, true)
      await completedPromise
      sinon.assert.calledOnceWithExactly(logError, 'Timeout waiting for the tracer to flush')
    } finally {
      onDone?.()
      logError.restore()
      libraryConfigurationCh.unsubscribe(onLibraryConfiguration)
      sessionFinishCh.unsubscribe(onSessionFinish)
    }
  })
})
