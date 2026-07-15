'use strict'

const assert = require('node:assert/strict')

const { channel } = require('dc-polyfill')
const { after, before, describe, it } = require('mocha')
const sinon = require('sinon')

function createCli () {
  const result = {
    globalConfig: {
      rootDir: process.cwd(),
    },
    results: {
      numFailedTestSuites: 0,
      numFailedTests: 0,
      numTotalTests: 1,
      numTotalTestSuites: 1,
      success: true,
      testResults: [],
    },
  }
  return {
    result,
    cli: {
      async runCLI () {
        return result
      },
    },
  }
}

/**
 * @param {{ onDone: (result: object) => void }} options
 */
function onLibraryConfiguration ({ onDone }) {
  onDone({
    libraryConfig: {
      isCodeCoverageEnabled: false,
      isCoverageReportUploadEnabled: false,
      isItrEnabled: false,
      isEarlyFlakeDetectionEnabled: false,
      isKnownTestsEnabled: false,
      isTestManagementEnabled: false,
      isImpactedTestsEnabled: false,
    },
  })
}

describe('packages/datadog-instrumentations/src/jest.js', () => {
  let clock
  let jestAdapterHook
  let jestWorkerId
  let runCLIHook

  before(() => {
    jestWorkerId = process.env.JEST_WORKER_ID
    process.env.JEST_WORKER_ID = '1'
    clock = sinon.useFakeTimers()
    require('../src/jest')
    const instrumentationHooks = globalThis[Symbol.for('_ddtrace_instrumentations')]
    runCLIHook = instrumentationHooks['@jest/core'].find(entry => entry.file === 'build/cli/index.js').hook
    jestAdapterHook = instrumentationHooks['jest-circus']
      .find(entry => entry.file === 'build/legacy-code-todo-rewrite/jestAdapter.js')
      .hook
  })

  after(() => {
    clock.restore()
    if (jestWorkerId === undefined) {
      delete process.env.JEST_WORKER_ID
    } else {
      process.env.JEST_WORKER_ID = jestWorkerId
    }
  })

  it('completes when the session finish subscriber disables itself during publication', async () => {
    const libraryConfigurationCh = channel('ci:jest:library-configuration')
    const sessionFinishCh = channel('ci:jest:session:finish')
    let resolveSessionFinish
    const sessionFinishPromise = new Promise(resolve => {
      resolveSessionFinish = resolve
    })
    const onSessionFinish = () => {
      sessionFinishCh.unsubscribe(onSessionFinish)
      resolveSessionFinish()
    }
    const { cli, result: expectedResult } = createCli()

    libraryConfigurationCh.subscribe(onLibraryConfiguration)
    sessionFinishCh.subscribe(onSessionFinish)

    try {
      const wrappedCli = runCLIHook(cli, '29.0.0')
      const timerCount = clock.countTimers()
      const runPromise = wrappedCli.runCLI()
      let result
      const completedPromise = (async () => {
        result = await runPromise
      })()

      await sessionFinishPromise
      await clock.tickAsync(0)

      assert.strictEqual(result, expectedResult)
      assert.strictEqual(clock.countTimers(), timerCount)
      await completedPromise
    } finally {
      libraryConfigurationCh.unsubscribe(onLibraryConfiguration)
      sessionFinishCh.unsubscribe(onSessionFinish)
    }
  })

  it('completes when the coverage subscriber disables itself during publication', async () => {
    const libraryConfigurationCh = channel('ci:jest:library-configuration')
    const sessionFinishCh = channel('ci:jest:session:finish')
    const coverageReportCh = channel('ci:jest:coverage-report')
    let resolveCoverageReport
    const coverageReportPromise = new Promise(resolve => {
      resolveCoverageReport = resolve
    })
    const onSessionFinish = ({ onDone }) => onDone()
    const onCoverageReport = () => {
      coverageReportCh.unsubscribe(onCoverageReport)
      resolveCoverageReport()
    }
    const { cli, result: expectedResult } = createCli()

    libraryConfigurationCh.subscribe(onLibraryConfiguration)
    sessionFinishCh.subscribe(onSessionFinish)
    coverageReportCh.subscribe(onCoverageReport)

    try {
      const wrappedCli = runCLIHook(cli, '29.0.0')
      const runPromise = wrappedCli.runCLI()
      let result
      const completedPromise = (async () => {
        result = await runPromise
      })()

      await coverageReportPromise
      await clock.tickAsync(0)

      assert.strictEqual(result, expectedResult)
      await completedPromise
    } finally {
      libraryConfigurationCh.unsubscribe(onLibraryConfiguration)
      sessionFinishCh.unsubscribe(onSessionFinish)
      coverageReportCh.unsubscribe(onCoverageReport)
    }
  })

  it('completes when an awaited suite finish subscriber disables itself', async () => {
    const suiteFinishCh = channel('ci:jest:test-suite:finish')
    let resolveSuiteFinish
    const suiteFinishPromise = new Promise(resolve => {
      resolveSuiteFinish = resolve
    })
    const onSuiteFinish = () => {
      suiteFinishCh.unsubscribe(onSuiteFinish)
      resolveSuiteFinish()
    }
    const expectedResult = {
      failureMessage: undefined,
      numFailingTests: 0,
      skipped: false,
    }
    const environment = {
      globalConfig: {
        workerIdleMemoryLimit: '512MB',
      },
      testEnvironmentOptions: {},
      testSuiteAbsolutePath: '/project/test.spec.js',
    }
    const adapter = async () => expectedResult

    suiteFinishCh.subscribe(onSuiteFinish)

    try {
      const wrappedAdapter = jestAdapterHook(adapter, '29.0.0')
      const adapterPromise = wrappedAdapter(undefined, undefined, environment)
      let result
      const completedPromise = (async () => {
        result = await adapterPromise
      })()

      await suiteFinishPromise
      await clock.tickAsync(0)

      assert.strictEqual(result, expectedResult)
      await completedPromise
    } finally {
      suiteFinishCh.unsubscribe(onSuiteFinish)
    }
  })
})
