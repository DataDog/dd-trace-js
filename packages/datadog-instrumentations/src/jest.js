'use strict'
const { addHook, channel, AsyncResource } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')
const { getCoveredFilenamesFromCoverage } = require('../../dd-trace/src/plugins/util/test')

const testSessionStartCh = channel('ci:jest:session:start')
const testSessionFinishCh = channel('ci:jest:session:finish')

const testSessionConfigurationCh = channel('ci:jest:session:configuration')

const testSuiteStartCh = channel('ci:jest:test-suite:start')
const testSuiteFinishCh = channel('ci:jest:test-suite:finish')
const testSuiteCodeCoverageCh = channel('ci:jest:test-suite:code-coverage')

const testStartCh = channel('ci:jest:test:start')
const testSkippedCh = channel('ci:jest:test:skip')
const testRunFinishCh = channel('ci:jest:test:finish')
const testErrCh = channel('ci:jest:test:err')

const skippableSuitesCh = channel('ci:jest:test-suite:skippable')
const jestConfigurationCh = channel('ci:jest:configuration')

let skippableSuites = []
let isCodeCoverageEnabled = false

const {
  getTestSuitePath,
  getTestParametersString
} = require('../../dd-trace/src/plugins/util/test')

const { getFormattedJestTestParameters, getJestTestName } = require('../../datadog-plugin-jest/src/util')

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

function getWrappedEnvironment (BaseEnvironment) {
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
            testParameters
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

function cliWrapper (cli) {
  const wrapped = shimmer.wrap(cli, 'runCLI', runCLI => async function () {
    let onResponse, onError
    const configurationPromise = new Promise((resolve, reject) => {
      onResponse = resolve
      onError = reject
    })

    sessionAsyncResource.runInAsyncScope(() => {
      jestConfigurationCh.publish({ onResponse, onError })
    })

    let isSuitesSkippingEnabled = false

    try {
      const config = await configurationPromise
      isCodeCoverageEnabled = config.isCodeCoverageEnabled
      isSuitesSkippingEnabled = config.isSuitesSkippingEnabled
    } catch (e) {
      // ignore error
    }

    if (isSuitesSkippingEnabled) {
      const skippableSuitesPromise = new Promise((resolve, reject) => {
        onResponse = resolve
        onError = reject
      })

      sessionAsyncResource.runInAsyncScope(() => {
        skippableSuitesCh.publish({ onResponse, onError })
      })

      try {
        skippableSuites = await skippableSuitesPromise
      } catch (e) {
        log.error(e)
      }
    }

    const isTestsSkipped = !!skippableSuites.length

    const processArgv = process.argv.slice(2).join(' ')
    sessionAsyncResource.runInAsyncScope(() => {
      testSessionStartCh.publish(`jest ${processArgv}`)
    })

    const result = await runCLI.apply(this, arguments)

    const { results: { success, coverageMap } } = result

    let testCodeCoverageLinesTotal
    try {
      testCodeCoverageLinesTotal = coverageMap.getCoverageSummary().lines.pct
    } catch (e) {
      // ignore errors
    }

    sessionAsyncResource.runInAsyncScope(() => {
      testSessionFinishCh.publish({ status: success ? 'pass' : 'fail', isTestsSkipped, testCodeCoverageLinesTotal })
    })

    return result
  })

  cli.runCLI = wrapped.runCLI

  return cli
}

addHook({
  name: '@jest/core',
  file: 'build/cli/index.js',
  versions: ['>=24.8.0']
}, cliWrapper)

function jestAdapterWrapper (jestAdapter) {
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
        testEnvironmentOptions: environment.testEnvironmentOptions
      })
      return adapter.apply(this, arguments).then(suiteResults => {
        const { numFailingTests, skipped, failureMessage: errorMessage } = suiteResults
        let status = 'pass'
        if (skipped) {
          status = 'skipped'
        } else if (numFailingTests !== 0) {
          status = 'fail'
        }
        testSuiteFinishCh.publish({ status, errorMessage })
        if (environment.global.__coverage__) {
          const coverageFiles = getCoveredFilenamesFromCoverage(environment.global.__coverage__)
            .map(filename => getTestSuitePath(filename, environment.rootDir))

          if (coverageFiles && environment.testEnvironmentOptions &&
            environment.testEnvironmentOptions._ddTestCodeCoverageEnabled) {
            testSuiteCodeCoverageCh.publish([...coverageFiles, environment.testSuite])
          }
        }
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
  configs.forEach(config => {
    skippableSuites.forEach((suite) => {
      config.testMatch.push(`!**/${suite}`)
    })
    skippableSuites = []
  })
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

// from 25.1.0 on, readConfigs becomes async
addHook({
  name: 'jest-config',
  versions: ['>=25.1.0']
}, jestConfigAsyncWrapper)

addHook({
  name: 'jest-config',
  versions: ['24.8.0 - 24.9.0']
}, jestConfigSyncWrapper)

function jasmineAsyncInstallWraper (jasmineAsyncInstallExport) {
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
}

addHook({
  name: 'jest-jasmine2',
  versions: ['>=24.8.0'],
  file: 'build/jasmineAsyncInstall.js'
}, jasmineAsyncInstallWraper)
