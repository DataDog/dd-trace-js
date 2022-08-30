'use strict'
const istanbul = require('istanbul-lib-coverage')
const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const testStartCh = channel('ci:jest:test:start')
const testSkippedCh = channel('ci:jest:test:skip')
const testRunFinishCh = channel('ci:jest:test:finish')
const testErrCh = channel('ci:jest:test:err')

const testCodeCoverageCh = channel('ci:jest:test:code-coverage')

const skippableTestsCh = channel('ci:jest:test:skippable')

const {
  getTestSuitePath,
  getTestParametersString
} = require('../../dd-trace/src/plugins/util/test')

const { getFormattedJestTestParameters, getJestTestName } = require('../../datadog-plugin-jest/src/util')

// This function also resets the coverage counters
function extractCoverageInformation (coverage, rootDir) {
  const coverageMap = istanbul.createCoverageMap(coverage)

  return coverageMap
    .files()
    .filter(filename => {
      const fileCoverage = coverageMap.fileCoverageFor(filename)
      const lineCoverage = fileCoverage.getLineCoverage()
      const isAnyLineExecuted = Object.entries(lineCoverage).some(([, numExecutions]) => !!numExecutions)

      fileCoverage.resetHits()

      return isAnyLineExecuted
    })
    .map(filename => filename.replace(`${rootDir}/`, ''))
}

const specStatusToTestStatus = {
  'pending': 'skip',
  'disabled': 'skip',
  'todo': 'skip',
  'passed': 'pass',
  'failed': 'fail'
}

const asyncResources = new WeakMap()
const originalTestFns = new WeakMap()

let skippableTests = []

function getTestsFromSuite (root) {
  let tests = []

  function getTests (suite) {
    if (suite.tests) {
      tests = tests.concat(suite.tests)
    }
    if (suite.children) {
      suite.children.forEach(child => {
        getTests(child)
      })
    }
  }

  getTests(root)

  return tests
}

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
  // config in newer jest versions has this structure
  if (config.projectConfig && config.projectConfig.testEnvironmentOptions) {
    return config.projectConfig.testEnvironmentOptions
  }
  if (config.testEnvironmentOptions) {
    return config.testEnvironmentOptions
  }
  return {}
}

function getWrappedEnvironment (BaseEnvironment) {
  return class DatadogEnvironment extends BaseEnvironment {
    constructor (config, context) {
      super(config, context)
      const rootDir = config.globalConfig ? config.globalConfig.rootDir : config.rootDir
      this.rootDir = rootDir
      this.testSuite = getTestSuitePath(context.testPath, rootDir)
      this.nameToParams = {}
      this.global._ddtrace = global._ddtrace

      const { _ddTestsToSkip } = getTestEnvironmentOptions(config)

      if (_ddTestsToSkip && _ddTestsToSkip.length) {
        this._ddTestsToSkip = _ddTestsToSkip.filter(({ suite }) => suite === this.testSuite)
      }
    }

    async handleTestEvent (event, state) {
      if (event.name === 'run_start' && this._ddTestsToSkip && this._ddTestsToSkip.length) {
        // In `run_start` every test in the suite is available
        const testsInSuite = getTestsFromSuite(state.currentDescribeBlock)
        testsInSuite.forEach(test => {
          const testFullName = getJestTestName(test)
          const shouldSkipTest = !!this._ddTestsToSkip.find(test => test.name === testFullName)
          if (shouldSkipTest) {
            // We mark them for skipping
            test.mode = 'skip'
          }
        })
      }

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
            testParameters
          })
          originalTestFns.set(event.test, event.test.fn)
          event.test.fn = asyncResource.bind(event.test.fn)
        })
      }
      if (event.name === 'test_done') {
        const asyncResource = asyncResources.get(event.test)
        asyncResource.runInAsyncScope(() => {
          if (this.global.__coverage__) {
            const coverageFiles = extractCoverageInformation(this.global.__coverage__, this.rootDir)
            testCodeCoverageCh.publish(coverageFiles)
          }
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
            runner: 'jest-circus'
          })
        })
      }
    }
  }
}

function getTestEnvironment (pkg) {
  if (pkg.default) {
    const wrappedTestEnvironment = getWrappedEnvironment(pkg.default)
    pkg.default = wrappedTestEnvironment
    pkg.TestEnvironment = wrappedTestEnvironment
    return pkg
  }
  return getWrappedEnvironment(pkg)
}

addHook({
  name: 'jest-environment-node',
  versions: ['>=24.8.0']
}, getTestEnvironment)

addHook({
  name: 'jest-environment-jsdom',
  versions: ['>=24.8.0']
}, getTestEnvironment)

// from 25.1.0 on, readConfigs becomes async
addHook({
  name: 'jest-config',
  versions: ['>=25.1.0']
}, jestConfig => {
  shimmer.wrap(jestConfig, 'readConfigs', readConfigs => async function () {
    const result = await readConfigs.apply(this, arguments)
    const { configs } = result
    configs.forEach(config => {
      config.testEnvironmentOptions._ddTestsToSkip = skippableTests
    })
    skippableTests = []
    return result
  })
  return jestConfig
})

addHook({
  name: 'jest-config',
  versions: ['24.8.0 - 24.9.0']
}, (jestConfig) => {
  shimmer.wrap(jestConfig, 'readConfigs', readConfigs => function () {
    const results = readConfigs.apply(this, arguments)
    const { configs } = results
    configs.forEach(config => {
      config.testEnvironmentOptions._ddTestsToSkip = skippableTests
    })
    skippableTests = []
    return results
  })
  return jestConfig
})

addHook({
  name: '@jest/core',
  file: 'build/cli/index.js',
  versions: ['>=24.8.0']
}, cli => {
  const wrapped = shimmer.wrap(cli, 'runCLI', runCLI => async function () {
    let onResponse, onError
    const skippableTestsRequestPromise = new Promise((resolve, reject) => {
      onResponse = resolve
      onError = reject
    })

    const asyncResource = new AsyncResource('bound-anonymous-fn')
    asyncResource.runInAsyncScope(() => {
      skippableTestsCh.publish({ onResponse, onError })
    })

    try {
      skippableTests = await skippableTestsRequestPromise
    } catch (e) {
      // ignore error
    }

    return runCLI.apply(this, arguments)
  })

  cli.runCLI = wrapped.runCLI

  return cli
})

addHook({
  name: 'jest-jasmine2',
  versions: ['>=24.8.0'],
  file: 'build/jasmineAsyncInstall.js'
}, (jasmineAsyncInstallExport) => {
  return function (globalConfig, globalInput) {
    globalInput._ddtrace = global._ddtrace
    shimmer.wrap(globalInput.jasmine.Spec.prototype, 'execute', execute => function (onComplete) {
      const asyncResource = new AsyncResource('bound-anonymous-fn')
      asyncResource.runInAsyncScope(() => {
        const testSuite = getTestSuitePath(this.result.testPath, globalConfig.rootDir)
        testStartCh.publish({
          name: this.getFullName(),
          suite: testSuite,
          runner: 'jest-jasmine2'
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
})
