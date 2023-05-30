'use strict'
const semver = require('semver')

const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')
const { version: ddTraceVersion } = require('../../../package.json')
const {
  getCoveredFilenamesFromCoverage,
  JEST_WORKER_TRACE_PAYLOAD_CODE,
  JEST_WORKER_COVERAGE_PAYLOAD_CODE,
  getTestLineStart,
  getTestSuitePath,
  getTestParametersString
} = require('../../dd-trace/src/plugins/util/test')
const {
  getFormattedJestTestParameters,
  getJestTestName,
  getJestSuitesToRun
} = require('../../datadog-plugin-jest/src/util')

const testSessionStartCh = channel('ci:jest:session:start')
const testSessionFinishCh = channel('ci:jest:session:finish')

const testSessionConfigurationCh = channel('ci:jest:session:configuration')

const testSuiteStartCh = channel('ci:jest:test-suite:start')
const testSuiteFinishCh = channel('ci:jest:test-suite:finish')

const workerReportTraceCh = channel('ci:jest:worker-report:trace')
const workerReportCoverageCh = channel('ci:jest:worker-report:coverage')

const testSuiteCodeCoverageCh = channel('ci:jest:test-suite:code-coverage')

const testStartCh = channel('ci:jest:test:start')
const testSkippedCh = channel('ci:jest:test:skip')
const testRunFinishCh = channel('ci:jest:test:finish')
const testErrCh = channel('ci:jest:test:err')

const skippableSuitesCh = channel('ci:jest:test-suite:skippable')
const jestItrConfigurationCh = channel('ci:jest:itr-configuration')

let skippableSuites = []
let isCodeCoverageEnabled = false
let isSuitesSkippingEnabled = false

const sessionAsyncResource = new AsyncResource('bound-anonymous-fn')

const specStatusToTestStatus = {
  'pending': 'skip',
  'disabled': 'skip',
  'todo': 'skip',
  'passed': 'pass',
  'failed': 'fail'
}

const asyncResources = new WeakMap()
const originalTestFns = new WeakMap()

// based on https://github.com/facebook/jest/blob/main/packages/jest-circus/src/formatNodeAssertErrors.ts#L41
function formatJestError (errors) {
  let error
  if (Array.isArray(errors)) {
    const [originalError, asyncError] = errors
    if (originalError === null || !originalError.stack) {
      error = asyncError
      error.message = originalError
    } else {
      error = originalError
    }
  } else {
    error = errors
  }
  return error
}

function getTestEnvironmentOptions (config) {
  if (config.projectConfig && config.projectConfig.testEnvironmentOptions) { // newer versions
    return config.projectConfig.testEnvironmentOptions
  }
  if (config.testEnvironmentOptions) {
    return config.testEnvironmentOptions
  }
  return {}
}

function getWrappedEnvironment (BaseEnvironment, jestVersion) {
  return class DatadogEnvironment extends BaseEnvironment {
    constructor (config, context) {
      super(config, context)
      const rootDir = config.globalConfig ? config.globalConfig.rootDir : config.rootDir
      this.rootDir = rootDir
      this.testSuite = getTestSuitePath(context.testPath, rootDir)
      this.nameToParams = {}
      this.global._ddtrace = global._ddtrace

      this.testEnvironmentOptions = getTestEnvironmentOptions(config)
    }

    async handleTestEvent (event, state) {
      if (super.handleTestEvent) {
        await super.handleTestEvent(event, state)
      }

      const setNameToParams = (name, params) => { this.nameToParams[name] = params }

      if (event.name === 'setup') {
        if (this.global.test) {
          shimmer.wrap(this.global.test, 'each', each => function () {
            const testParameters = getFormattedJestTestParameters(arguments)
            const eachBind = each.apply(this, arguments)
            return function () {
              const [testName] = arguments
              setNameToParams(testName, testParameters)
              return eachBind.apply(this, arguments)
            }
          })
        }
      }
      if (event.name === 'test_start') {
        const testParameters = getTestParametersString(this.nameToParams, event.test.name)
        // Async resource for this test is created here
        // It is used later on by the test_done handler
        const asyncResource = new AsyncResource('bound-anonymous-fn')
        asyncResources.set(event.test, asyncResource)
        asyncResource.runInAsyncScope(() => {
          testStartCh.publish({
            name: getJestTestName(event.test),
            suite: this.testSuite,
            runner: 'jest-circus',
            testParameters,
            frameworkVersion: jestVersion,
            testStartLine: getTestLineStart(event.test.asyncError, this.testSuite)
          })
          originalTestFns.set(event.test, event.test.fn)
          event.test.fn = asyncResource.bind(event.test.fn)
        })
      }
      if (event.name === 'test_done') {
        const asyncResource = asyncResources.get(event.test)
        asyncResource.runInAsyncScope(() => {
          let status = 'pass'
          if (event.test.errors && event.test.errors.length) {
            status = 'fail'
            const formattedError = formatJestError(event.test.errors[0])
            testErrCh.publish(formattedError)
          }
          testRunFinishCh.publish(status)
          // restore in case it is retried
          event.test.fn = originalTestFns.get(event.test)
        })
      }
      if (event.name === 'test_skip' || event.name === 'test_todo') {
        const asyncResource = new AsyncResource('bound-anonymous-fn')
        asyncResource.runInAsyncScope(() => {
          testSkippedCh.publish({
            name: getJestTestName(event.test),
            suite: this.testSuite,
            runner: 'jest-circus',
            frameworkVersion: jestVersion,
            testStartLine: getTestLineStart(event.test.asyncError, this.testSuite)
          })
        })
      }
    }
  }
}

function getTestEnvironment (pkg, jestVersion) {
  if (pkg.default) {
    const wrappedTestEnvironment = getWrappedEnvironment(pkg.default, jestVersion)
    pkg.default = wrappedTestEnvironment
    pkg.TestEnvironment = wrappedTestEnvironment
    return pkg
  }
  return getWrappedEnvironment(pkg, jestVersion)
}

addHook({
  name: 'jest-environment-node',
  versions: ['>=24.8.0']
}, getTestEnvironment)

addHook({
  name: 'jest-environment-jsdom',
  versions: ['>=24.8.0']
}, getTestEnvironment)

function cliWrapper (cli, jestVersion) {
  const wrapped = shimmer.wrap(cli, 'runCLI', runCLI => async function () {
    let onDone
    const configurationPromise = new Promise((resolve) => {
      onDone = resolve
    })
    if (!jestItrConfigurationCh.hasSubscribers) {
      return runCLI.apply(this, arguments)
    }

    sessionAsyncResource.runInAsyncScope(() => {
      jestItrConfigurationCh.publish({ onDone })
    })

    try {
      const { err, itrConfig } = await configurationPromise
      if (!err) {
        isCodeCoverageEnabled = itrConfig.isCodeCoverageEnabled
        isSuitesSkippingEnabled = itrConfig.isSuitesSkippingEnabled
      }
    } catch (err) {
      log.error(err)
    }

    if (isSuitesSkippingEnabled) {
      const skippableSuitesPromise = new Promise((resolve) => {
        onDone = resolve
      })

      sessionAsyncResource.runInAsyncScope(() => {
        skippableSuitesCh.publish({ onDone })
      })

      try {
        const { err, skippableSuites: receivedSkippableSuites } = await skippableSuitesPromise
        if (!err) {
          skippableSuites = receivedSkippableSuites
        }
      } catch (err) {
        log.error(err)
      }
    }
    const isSuitesSkipped = !!skippableSuites.length

    const processArgv = process.argv.slice(2).join(' ')
    sessionAsyncResource.runInAsyncScope(() => {
      testSessionStartCh.publish({ command: `jest ${processArgv}`, frameworkVersion: jestVersion })
    })

    const result = await runCLI.apply(this, arguments)

    const { results: { success, coverageMap } } = result

    let testCodeCoverageLinesTotal
    try {
      const { pct, total } = coverageMap.getCoverageSummary().lines
      testCodeCoverageLinesTotal = total !== 0 ? pct : 0
    } catch (e) {
      // ignore errors
    }

    sessionAsyncResource.runInAsyncScope(() => {
      testSessionFinishCh.publish({
        status: success ? 'pass' : 'fail',
        isSuitesSkipped,
        isSuitesSkippingEnabled,
        isCodeCoverageEnabled,
        testCodeCoverageLinesTotal
      })
    })

    return result
  })

  cli.runCLI = wrapped.runCLI

  return cli
}

function coverageReporterWrapper (coverageReporter) {
  const CoverageReporter = coverageReporter.default ? coverageReporter.default : coverageReporter

  /**
   * If ITR is active, we're running fewer tests, so of course the total code coverage is reduced.
   * This calculation adds no value, so we'll skip it.
   */
  shimmer.wrap(CoverageReporter.prototype, '_addUntestedFiles', addUntestedFiles => async function () {
    if (isSuitesSkippingEnabled) {
      return Promise.resolve()
    }
    return addUntestedFiles.apply(this, arguments)
  })

  return coverageReporter
}

addHook({
  name: '@jest/reporters',
  file: 'build/coverage_reporter.js',
  versions: ['>=24.8.0 <26.6.2']
}, coverageReporterWrapper)

addHook({
  name: '@jest/reporters',
  file: 'build/CoverageReporter.js',
  versions: ['>=26.6.2']
}, coverageReporterWrapper)

addHook({
  name: '@jest/core',
  file: 'build/cli/index.js',
  versions: ['>=24.8.0']
}, cliWrapper)

function jestAdapterWrapper (jestAdapter, jestVersion) {
  const adapter = jestAdapter.default ? jestAdapter.default : jestAdapter
  const newAdapter = shimmer.wrap(adapter, function () {
    const environment = arguments[2]
    if (!environment) {
      return adapter.apply(this, arguments)
    }
    const asyncResource = new AsyncResource('bound-anonymous-fn')
    return asyncResource.runInAsyncScope(() => {
      testSuiteStartCh.publish({
        testSuite: environment.testSuite,
        testEnvironmentOptions: environment.testEnvironmentOptions,
        frameworkVersion: jestVersion
      })
      return adapter.apply(this, arguments).then(suiteResults => {
        const { numFailingTests, skipped, failureMessage: errorMessage } = suiteResults
        let status = 'pass'
        if (skipped) {
          status = 'skipped'
        } else if (numFailingTests !== 0) {
          status = 'fail'
        }

        const coverageFiles = getCoveredFilenamesFromCoverage(environment.global.__coverage__)
          .map(filename => getTestSuitePath(filename, environment.rootDir))

        /**
         * Child processes do not each request ITR configuration, so the jest's parent process
         * needs to pass them the configuration. This is done via _ddTestCodeCoverageEnabled, which
         * controls whether coverage is reported.
         */
        if (coverageFiles &&
          environment.testEnvironmentOptions &&
          environment.testEnvironmentOptions._ddTestCodeCoverageEnabled) {
          asyncResource.runInAsyncScope(() => {
            testSuiteCodeCoverageCh.publish([...coverageFiles, environment.testSuite])
          })
        }
        testSuiteFinishCh.publish({ status, errorMessage })
        return suiteResults
      })
    })
  })
  if (jestAdapter.default) {
    jestAdapter.default = newAdapter
  } else {
    jestAdapter = newAdapter
  }

  return jestAdapter
}

addHook({
  name: 'jest-circus',
  file: 'build/legacy-code-todo-rewrite/jestAdapter.js',
  versions: ['>=24.8.0']
}, jestAdapterWrapper)

function configureTestEnvironment (readConfigsResult) {
  const { configs } = readConfigsResult
  sessionAsyncResource.runInAsyncScope(() => {
    testSessionConfigurationCh.publish(configs.map(config => config.testEnvironmentOptions))
  })
  // We can't directly use isCodeCoverageEnabled when reporting coverage in `jestAdapterWrapper`
  // because `jestAdapterWrapper` runs in a different process. We have to go through `testEnvironmentOptions`
  configs.forEach(config => {
    config.testEnvironmentOptions._ddTestCodeCoverageEnabled = isCodeCoverageEnabled
  })

  if (isCodeCoverageEnabled) {
    const globalConfig = {
      ...readConfigsResult.globalConfig,
      collectCoverage: true
    }
    readConfigsResult.globalConfig = globalConfig
  }
  if (isSuitesSkippingEnabled) {
    // If suite skipping is enabled, the code coverage results are not going to be relevant,
    // so we do not show them.
    // Also, we might skip every test, so we need to pass `passWithNoTests`
    const globalConfig = {
      ...readConfigsResult.globalConfig,
      coverageReporters: ['none'],
      passWithNoTests: true
    }
    readConfigsResult.globalConfig = globalConfig
  }

  return readConfigsResult
}

function jestConfigAsyncWrapper (jestConfig) {
  shimmer.wrap(jestConfig, 'readConfigs', readConfigs => async function () {
    const readConfigsResult = await readConfigs.apply(this, arguments)
    configureTestEnvironment(readConfigsResult)
    return readConfigsResult
  })
  return jestConfig
}

function jestConfigSyncWrapper (jestConfig) {
  shimmer.wrap(jestConfig, 'readConfigs', readConfigs => function () {
    const readConfigsResult = readConfigs.apply(this, arguments)
    configureTestEnvironment(readConfigsResult)
    return readConfigsResult
  })
  return jestConfig
}

/**
 * Hook to remove the test paths (test suite) that are part of `skippableSuites`
 */
addHook({
  name: '@jest/core',
  versions: ['>=24.8.0'],
  file: 'build/SearchSource.js'
}, searchSourcePackage => {
  const SearchSource = searchSourcePackage.default ? searchSourcePackage.default : searchSourcePackage

  shimmer.wrap(SearchSource.prototype, 'getTestPaths', getTestPaths => async function () {
    if (!skippableSuites.length) {
      return getTestPaths.apply(this, arguments)
    }

    const [{ rootDir }] = arguments

    const testPaths = await getTestPaths.apply(this, arguments)
    const { tests } = testPaths

    const filteredTests = getJestSuitesToRun(skippableSuites, tests, rootDir)

    skippableSuites = []

    return { ...testPaths, tests: filteredTests }
  })

  return searchSourcePackage
})

// from 25.1.0 on, readConfigs becomes async
addHook({
  name: 'jest-config',
  versions: ['>=25.1.0']
}, jestConfigAsyncWrapper)

addHook({
  name: 'jest-config',
  versions: ['24.8.0 - 24.9.0']
}, jestConfigSyncWrapper)

function jasmineAsyncInstallWraper (jasmineAsyncInstallExport, jestVersion) {
  log.warn('jest-jasmine2 support is removed from dd-trace@v4. Consider changing to jest-circus as `testRunner`.')
  return function (globalConfig, globalInput) {
    globalInput._ddtrace = global._ddtrace
    shimmer.wrap(globalInput.jasmine.Spec.prototype, 'execute', execute => function (onComplete) {
      const asyncResource = new AsyncResource('bound-anonymous-fn')
      asyncResource.runInAsyncScope(() => {
        const testSuite = getTestSuitePath(this.result.testPath, globalConfig.rootDir)
        testStartCh.publish({
          name: this.getFullName(),
          suite: testSuite,
          runner: 'jest-jasmine2',
          frameworkVersion: jestVersion
        })
        const spec = this
        const callback = asyncResource.bind(function () {
          if (spec.result.failedExpectations && spec.result.failedExpectations.length) {
            const formattedError = formatJestError(spec.result.failedExpectations[0].error)
            testErrCh.publish(formattedError)
          }
          testRunFinishCh.publish(specStatusToTestStatus[spec.result.status])
          onComplete.apply(this, arguments)
        })
        arguments[0] = callback
        execute.apply(this, arguments)
      })
    })
    return jasmineAsyncInstallExport.default(globalConfig, globalInput)
  }
}

if (semver.lt(ddTraceVersion, '4.0.0')) {
  addHook({
    name: 'jest-jasmine2',
    versions: ['>=24.8.0'],
    file: 'build/jasmineAsyncInstall.js'
  }, jasmineAsyncInstallWraper)
}

addHook({
  name: 'jest-worker',
  versions: ['>=24.9.0'],
  file: 'build/workers/ChildProcessWorker.js'
}, (childProcessWorker) => {
  const ChildProcessWorker = childProcessWorker.default
  shimmer.wrap(ChildProcessWorker.prototype, '_onMessage', _onMessage => function () {
    const [code, data] = arguments[0]
    if (code === JEST_WORKER_TRACE_PAYLOAD_CODE) { // datadog trace payload
      sessionAsyncResource.runInAsyncScope(() => {
        workerReportTraceCh.publish(data)
      })
      return
    }
    if (code === JEST_WORKER_COVERAGE_PAYLOAD_CODE) { // datadog coverage payload
      sessionAsyncResource.runInAsyncScope(() => {
        workerReportCoverageCh.publish(data)
      })
      return
    }
    return _onMessage.apply(this, arguments)
  })
  return childProcessWorker
})
