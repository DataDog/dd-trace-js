'use strict'

const assert = require('node:assert/strict')
const { setImmediate } = require('node:timers/promises')

const { channel } = require('dc-polyfill')
const { describe, it } = require('mocha')

require('../src/cucumber')

const CUCUMBER_HOOKS = globalThis[Symbol.for('_ddtrace_instrumentations')]['@cucumber/cucumber']
const COORDINATOR_HOOK = CUCUMBER_HOOKS.find((entry) => entry.file === 'lib/runtime/coordinator.js').hook

class Coordinator {
  constructor () {
    this.options = {}
    this.sourcedPickles = []
  }

  async run () {
    return true
  }
}

describe('packages/datadog-instrumentations/src/cucumber.js', () => {
  it('waits for session finalization before resolving the coordinator run', async () => {
    const libraryConfigurationCh = channel('ci:cucumber:library-configuration')
    const sessionFinishCh = channel('ci:cucumber:session:finish')
    let onDone
    let resolveSessionFinish
    const sessionFinishPromise = new Promise(resolve => {
      resolveSessionFinish = resolve
    })
    const onLibraryConfiguration = ({ onDone: configure }) => configure({
      libraryConfig: {},
      repositoryRoot: process.cwd(),
    })
    const onSessionFinish = ({ onDone: finish }) => {
      onDone = finish
      resolveSessionFinish()
    }

    libraryConfigurationCh.subscribe(onLibraryConfiguration)
    sessionFinishCh.subscribe(onSessionFinish)

    try {
      const { Coordinator: WrappedCoordinator } = COORDINATOR_HOOK({ Coordinator }, '13.0.0')
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
    const onLibraryConfiguration = ({ onDone }) => onDone({
      libraryConfig: {},
      repositoryRoot: process.cwd(),
    })
    const onSessionFinish = () => {
      sessionFinishCh.unsubscribe(onSessionFinish)
      resolveSessionFinish()
    }

    libraryConfigurationCh.subscribe(onLibraryConfiguration)
    sessionFinishCh.subscribe(onSessionFinish)

    try {
      const { Coordinator: WrappedCoordinator } = COORDINATOR_HOOK({ Coordinator }, '13.0.0')
      const runPromise = new WrappedCoordinator().run()
      let result
      const completedPromise = (async () => {
        result = await runPromise
      })()

      await sessionFinishPromise
      await setImmediate()

      assert.strictEqual(result, true)
      await completedPromise
    } finally {
      libraryConfigurationCh.unsubscribe(onLibraryConfiguration)
      sessionFinishCh.unsubscribe(onSessionFinish)
    }
  })
})
