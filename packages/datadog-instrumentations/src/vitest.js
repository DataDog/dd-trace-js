const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
// Needs removing specifiers check in
// node_modules/.pnpm/import-in-the-middle@1.7.3/node_modules/import-in-the-middle/index.js
// TODO: why?

// needs creating a fake file node_modules/vitest/dist/@vitest/spy
// TODO: why?
const testStartCh = channel('ci:vitest:test:start')
const testFinishCh = channel('ci:vitest:test:finish')
const testErrorCh = channel('ci:vitest:test:error')

const testSuiteStartCh = channel('ci:vitest:test-suite:start')
const testSuiteFinishCh = channel('ci:vitest:test-suite:finish')
const testSuiteErrorCh = channel('ci:vitest:test-suite:error')

const testSessionStartCh = channel('ci:vitest:session:start')
const testSessionFinishCh = channel('ci:vitest:session:finish')

const taskToAsync = new WeakMap()

const sessionAsyncResource = new AsyncResource('bound-anonymous-fn')

const isVitestTestRunner = (vitestPackage) => {
  return vitestPackage.VitestTestRunner
}

function isCac (vitestPackage) {
  return vitestPackage.c?.name === 'createCLI'
}

function isReporterPackage (vitestPackage) {
  return vitestPackage.B?.name === 'BaseSequencer'
}

function getSessionStatus (state) {
  if (state.getCountOfFailedTests() > 0) {
    return 'fail'
  }
  if (state.pathsSet.size === 0) {
    return 'skip'
  }
  return 'pass'
}

// eslint-disable-next-line
// From https://github.com/vitest-dev/vitest/blob/51c04e2f44d91322b334f8ccbcdb368facc3f8ec/packages/runner/src/run.ts#L243-L250
function getVitestTestStatus (test, retryCount) {
  if (test.result.state !== 'fail') {
    if (!test.repeats) {
      return 'pass'
    } else if (test.repeats && (test.retry ?? 0) === retryCount) {
      return 'pass'
    }
  }
  return 'fail'
}

function getTypeTasks (fileTasks, type = 'test') {
  const typeTasks = []

  function getTasks (tasks) {
    for (const task of tasks) {
      if (task.type === type) {
        typeTasks.push(task)
      } else if (task.tasks) {
        getTasks(task.tasks)
      }
    }
  }

  getTasks(fileTasks)

  return typeTasks
}

function getTestName (task) {
  let testName = ''
  let currentTask = task

  while (currentTask.suite) {
    if (currentTask.name) {
      testName = `${currentTask.name} ${testName}`
    }
    currentTask = currentTask.suite
  }

  return testName
}

// Can't specify file because compiled vitest includes hashes in their files
addHook({
  name: 'vitest',
  versions: ['>=1.6.0']
}, (vitestPackage, frameworkVersion) => {
  if (isCac(vitestPackage)) {
    shimmer.wrap(vitestPackage, 'c', oldCreateCli => function () {
      sessionAsyncResource.runInAsyncScope(() => {
        const processArgv = process.argv.slice(2).join(' ')
        testSessionStartCh.publish({ command: `vitest ${processArgv}`, frameworkVersion })
      })
      return oldCreateCli.apply(this, arguments)
    })
  }
  if (isReporterPackage(vitestPackage)) {
    shimmer.wrap(vitestPackage.B.prototype, 'sort', sort => async function () {
      shimmer.wrap(this.ctx, 'exit', exit => async function () {
        let onFinish

        const flushPromise = new Promise(resolve => {
          onFinish = resolve
        })
        const failedSuites = this.state.getFailedFilepaths()
        let error
        if (failedSuites.length) {
          error = new Error(`Test suites failed: ${failedSuites.length}.`)
        }

        sessionAsyncResource.runInAsyncScope(() => {
          testSessionFinishCh.publish({
            status: getSessionStatus(this.state),
            onFinish,
            error
          })
        })

        await flushPromise

        return exit.apply(this, arguments)
      })

      return sort.apply(this, arguments)
    })
  }

  if (isVitestTestRunner(vitestPackage)) {
    const { VitestTestRunner } = vitestPackage
    // test start
    // TODO: add test for beforeEach / afterEach and before/after hooks: they're likely tasks too
    shimmer.wrap(VitestTestRunner.prototype, 'onBeforeTryTask', onBeforeTryTask => async function (task) {
      const asyncResource = new AsyncResource('bound-anonymous-fn')
      taskToAsync.set(task, asyncResource)

      asyncResource.runInAsyncScope(() => {
        testStartCh.publish({ testName: getTestName(task), testSuiteAbsolutePath: task.suite.file.filepath })
      })
      return onBeforeTryTask.apply(this, arguments)
    })

    // test finish
    // TODO: add test for beforeEach / afterEach and before/after hooks: they're likely tasks too
    shimmer.wrap(VitestTestRunner.prototype, 'onAfterTryTask', onAfterTryTask =>
      async function (task, { retry: retryCount }) {
        const result = await onAfterTryTask.apply(this, arguments)

        const testStatus = getVitestTestStatus(task, retryCount)
        const asyncResource = taskToAsync.get(task)

        asyncResource.runInAsyncScope(() => {
          testFinishCh.publish(testStatus)
        })
        return result
      })
  }
  return vitestPackage
})

// test suite start and finish
// only relevant for workers
addHook({
  name: '@vitest/runner',
  versions: ['>=1.6.0']
}, vitestPackage => {
  if (vitestPackage.startTests) {
    shimmer.wrap(vitestPackage, 'startTests', startTests => async function (testPath) {
      let testSuiteError = null

      const testSuiteAsyncResource = new AsyncResource('bound-anonymous-fn')
      testSuiteAsyncResource.runInAsyncScope(() => {
        testSuiteStartCh.publish(testPath[0])
      })
      const startTestsResponse = await startTests.apply(this, arguments)

      let onFinish = null
      const onFinishPromise = new Promise(resolve => {
        onFinish = resolve
      })

      const testTasks = getTypeTasks(startTestsResponse[0].tasks)
      // we don't use getVitestTestStatus here because every hook call has finished, so it's already set
      // unlike on onAfterTryTask
      const failedTests = testTasks.filter(task => task.result?.state === 'fail')

      // Errored tests do not go through onAfterTryTask, so we need to handle them here
      failedTests.forEach(failedTask => {
        const testAsyncResource = taskToAsync.get(failedTask)
        const { result: { duration, errors } } = failedTask
        let testError

        if (errors?.length) {
          testError = errors[0]
        }

        testAsyncResource.runInAsyncScope(() => {
          testErrorCh.publish({ duration, error: testError })
        })
        if (errors?.length) {
          testSuiteError = testError // we store the error to bubble it up to the suite
        }
      })

      const testSuiteResult = startTestsResponse[0].result

      if (testSuiteResult.errors?.length) { // Errors from root level hooks
        testSuiteError = testSuiteResult.errors[0]
      } else if (testSuiteResult.state === 'fail') { // Errors from `describe` level hooks
        const suiteTasks = getTypeTasks(startTestsResponse[0].tasks, 'suite')
        const failedSuites = suiteTasks.filter(task => task.result?.state === 'fail')
        if (failedSuites.length && failedSuites[0].result?.errors?.length) {
          testSuiteError = failedSuites[0].result.errors[0]
        }
      }

      if (testSuiteError) {
        testSuiteAsyncResource.runInAsyncScope(() => {
          testSuiteErrorCh.publish({ error: testSuiteError })
        })
      }

      testSuiteAsyncResource.runInAsyncScope(() => {
        testSuiteFinishCh.publish({ status: testSuiteResult.state, onFinish })
      })

      // TODO: fix too frequent flushes
      await onFinishPromise

      return startTestsResponse
    })
  }

  return vitestPackage
})
