const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

// Needs modifying node_modules/.pnpm/import-in-the-middle@1.7.3/node_modules/import-in-the-middle/index.js
// the specifiers thing I don't understand

// needs creating a fake file node_modules/vitest/dist/@vitest/spy -- why????

const testStartCh = channel('ci:vitest:test:start')
const testFinishCh = channel('ci:vitest:test:finish')

const testSuiteStartCh = channel('ci:vitest:test-suite:start')
const testSuiteFinishCh = channel('ci:vitest:test-suite:finish')

const testSessionStartCh = channel('ci:vitest:session:start')
const testSessionFinishCh = channel('ci:vitest:session:finish')

const taskToAsync = new WeakMap()

const sessionAsyncResource = new AsyncResource('bound-anonymous-fn')

const isVitestTestRunner = (vitestPackage) => {
  return vitestPackage.VitestTestRunner
}

const isVitestPlugin = (vitestPackage) => {
  return vitestPackage.B?.name === 'BaseSequencer'
}

// --- do I need to specify a file? That's problematic because they contain a hash
addHook({
  name: 'vitest',
  versions: ['>=0.0.0']
}, (vitestPackage, frameworkVersion) => {
  if (isVitestPlugin(vitestPackage)) {
    // TODO: will the "s" (minified version) be the same in future versions?
    shimmer.wrap(vitestPackage, 's', startVitest => async function () {
      sessionAsyncResource.runInAsyncScope(() => {
        // TODO: change command to proper command
        testSessionStartCh.publish({ command: 'vitest run', frameworkVersion })
      })
      const res = await startVitest.apply(this, arguments)

      sessionAsyncResource.runInAsyncScope(() => {
        // TODO: get proper status
        testSessionFinishCh.publish('pass')
      })
      return res
    })
  }

  if (isVitestTestRunner(vitestPackage)) {
    // test start
    shimmer.wrap(vitestPackage.VitestTestRunner.prototype, 'onBeforeTryTask', onBeforeTryTask => async function (task) {
      const asyncResource = new AsyncResource('bound-anonymous-fn')
      taskToAsync.set(task, asyncResource)

      asyncResource.runInAsyncScope(() => {
        testStartCh.publish({ testName: task.name, testSuiteAbsolutePath: task.suite.file.filepath })
      })
      return onBeforeTryTask.apply(this, arguments)
    })

    // test finish
    shimmer.wrap(vitestPackage.VitestTestRunner.prototype, 'onAfterTryTask', onAfterTryTask => async function (task) {
      const res = await onAfterTryTask.apply(this, arguments)

      const asyncResource = taskToAsync.get(task)

      asyncResource.runInAsyncScope(() => {
        // TODO: if no error has been found, it's a pass.
        // See logic in packages/runner/src/run.ts in vitest after calling onAfterTryTask
        testFinishCh.publish('pass')
      })
      return res
    })
  }
  return vitestPackage
})

// test suite start and finish
// only relevant for workers
addHook({
  name: '@vitest/runner',
  versions: ['>=0.0.0']
}, vitestPackage => {
  if (vitestPackage.startTests) {
    shimmer.wrap(vitestPackage, 'startTests', startTests => async function (testPath, vitestTestRunner) {
      const asyncResource = new AsyncResource('bound-anonymous-fn')
      asyncResource.runInAsyncScope(() => {
        testSuiteStartCh.publish(testPath[0])
      })
      const startTestsResponse = await startTests.apply(this, arguments)

      let onFinish = null
      const onFinishPromise = new Promise(resolve => {
        onFinish = resolve
      })

      asyncResource.runInAsyncScope(() => {
        testSuiteFinishCh.publish({ status: startTestsResponse[0].result.state, onFinish })
      })

      await onFinishPromise

      return startTestsResponse
    })
  }

  return vitestPackage
})
