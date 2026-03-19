'use strict'

const shimmer = require('../../../datadog-shimmer')
const log = require('../../../dd-trace/src/log')
const {
  getCoveredFilenamesFromCoverage,
  getTestSuitePath,
} = require('../../../dd-trace/src/plugins/util/test')
const { addHook } = require('../helpers/instrument')
const {
  testSessionConfigurationCh,
  testSuiteStartCh,
  testSuiteFinishCh,
  testSuiteCodeCoverageCh,
} = require('./channels')
const {
  state,
  testSuiteMockedFiles,
  testSuiteJestObjects,
} = require('./state')
const { getCliWrapper, searchSourceWrapper, coverageReporterWrapper } = require('./cli')
const { applySuiteSkipping } = require('./environment')

function getWrappedScheduleTests (scheduleTests, frameworkVersion) {
  // `scheduleTests` is an async function
  return function (tests) {
    if (!state.isSuitesSkippingEnabled || state.hasFilteredSkippableSuites) {
      return scheduleTests.apply(this, arguments)
    }
    const [test] = tests
    const rootDir = test?.context?.config?.rootDir

    arguments[0] = applySuiteSkipping(tests, rootDir, frameworkVersion)

    return scheduleTests.apply(this, arguments)
  }
}

function configureTestEnvironment (readConfigsResult) {
  const { configs } = readConfigsResult
  testSessionConfigurationCh.publish(configs.map(config => config.testEnvironmentOptions))
  // We can't directly use isCodeCoverageEnabled when reporting coverage in `jestAdapterWrapper`
  // because `jestAdapterWrapper` runs in a different process. We have to go through `testEnvironmentOptions`
  for (const config of configs) {
    config.testEnvironmentOptions._ddTestCodeCoverageEnabled = state.isCodeCoverageEnabled
  }

  state.isUserCodeCoverageEnabled = !!readConfigsResult.globalConfig.collectCoverage
  state.isCodeCoverageEnabledBecauseOfUs = state.isCodeCoverageEnabled && !state.isUserCodeCoverageEnabled

  if (readConfigsResult.globalConfig.forceExit) {
    log.warn("Jest's '--forceExit' flag has been passed. This may cause loss of data.")
  }

  if (state.isCodeCoverageEnabledBecauseOfUs || state.isSuitesSkippingEnabled) {
    const globalConfig = { ...readConfigsResult.globalConfig }
    if (state.isCodeCoverageEnabledBecauseOfUs) {
      globalConfig.collectCoverage = true
    }
    if (state.isSuitesSkippingEnabled) {
      // Pass `passWithNoTests` in case every test gets skipped.
      globalConfig.passWithNoTests = true
      if (state.isCodeCoverageEnabledBecauseOfUs && !state.isKeepingCoverageConfiguration) {
        globalConfig.coverageReporters = ['none']
        readConfigsResult.configs = configs.map(config => ({
          ...config,
          coverageReporters: ['none'],
        }))
      }
    }
    readConfigsResult.globalConfig = globalConfig
  }

  return readConfigsResult
}

function jestConfigAsyncWrapper (jestConfig) {
  return shimmer.wrap(jestConfig, 'readConfigs', readConfigs => async function () {
    const readConfigsResult = await readConfigs.apply(this, arguments)
    configureTestEnvironment(readConfigsResult)
    return readConfigsResult
  })
}

function jestConfigSyncWrapper (jestConfig) {
  return shimmer.wrap(jestConfig, 'readConfigs', readConfigs => function () {
    const readConfigsResult = readConfigs.apply(this, arguments)
    configureTestEnvironment(readConfigsResult)
    return readConfigsResult
  })
}

const DD_TEST_ENVIRONMENT_OPTION_KEYS = [
  '_ddTestModuleId',
  '_ddTestSessionId',
  '_ddTestCommand',
  '_ddTestCodeCoverageEnabled',
  '_ddRequestErrorTags',
  '_ddForcedToRun',
  '_ddUnskippable',
  '_ddItrCorrelationId',
  '_ddKnownTests',
  '_ddIsEarlyFlakeDetectionEnabled',
  '_ddEarlyFlakeDetectionSlowTestRetries',
  '_ddRepositoryRoot',
  '_ddIsFlakyTestRetriesEnabled',
  '_ddFlakyTestRetriesCount',
  '_ddIsDiEnabled',
  '_ddIsKnownTestsEnabled',
  '_ddIsTestManagementTestsEnabled',
  '_ddTestManagementTests',
  '_ddTestManagementAttemptToFixRetries',
  '_ddIsImpactedTestsEnabled',
  '_ddModifiedFiles',
]

function removeDatadogTestEnvironmentOptions (testEnvironmentOptions) {
  const removedEntries = []

  for (const key of DD_TEST_ENVIRONMENT_OPTION_KEYS) {
    if (!Object.hasOwn(testEnvironmentOptions, key)) {
      continue
    }

    removedEntries.push([key, testEnvironmentOptions[key]])
    delete testEnvironmentOptions[key]
  }

  return function restoreDatadogTestEnvironmentOptions () {
    for (const [key, value] of removedEntries) {
      testEnvironmentOptions[key] = value
    }
  }
}

/**
 * Wrap `createScriptTransformer` to temporarily hide Datadog-specific
 * `testEnvironmentOptions` keys while Jest builds its transform config.
 *
 * @param {Function} createScriptTransformer
 * @returns {Function}
 */
function wrapCreateScriptTransformer (createScriptTransformer) {
  return function (config) {
    const testEnvironmentOptions = config?.testEnvironmentOptions

    if (!testEnvironmentOptions) {
      return createScriptTransformer.apply(this, arguments)
    }

    const restoreTestEnvironmentOptions = removeDatadogTestEnvironmentOptions(testEnvironmentOptions)

    try {
      const result = createScriptTransformer.apply(this, arguments)

      if (result?.then) {
        return result.finally(restoreTestEnvironmentOptions)
      }

      restoreTestEnvironmentOptions()
      return result
    } catch (e) {
      restoreTestEnvironmentOptions()
      throw e
    }
  }
}

function jestAdapterWrapper (jestAdapter, jestVersion) {
  const adapter = jestAdapter.default ?? jestAdapter
  const newAdapter = shimmer.wrapFunction(adapter, adapter => function () {
    const environment = arguments[2]
    if (!environment || !environment.testEnvironmentOptions) {
      return adapter.apply(this, arguments)
    }
    testSuiteStartCh.publish({
      testSuite: environment.testSuite,
      testEnvironmentOptions: environment.testEnvironmentOptions,
      testSourceFile: environment.testSourceFile,
      displayName: environment.displayName,
      frameworkVersion: jestVersion,
      testSuiteAbsolutePath: environment.testSuiteAbsolutePath,
    })
    return adapter.apply(this, arguments).then(suiteResults => {
      const { numFailingTests, skipped, failureMessage: errorMessage } = suiteResults
      let status = 'pass'
      if (skipped) {
        status = 'skipped'
      } else if (numFailingTests !== 0) {
        status = 'fail'
      }

      /**
       * Child processes do not each request ITR configuration, so the jest's parent process
       * needs to pass them the configuration. This is done via _ddTestCodeCoverageEnabled, which
       * controls whether coverage is reported.
       */
      if (environment.testEnvironmentOptions?._ddTestCodeCoverageEnabled) {
        const root = environment.repositoryRoot || environment.rootDir

        const getFilesWithPath = (files) => files.map(file => getTestSuitePath(file, root))

        const coverageFiles = getFilesWithPath(getCoveredFilenamesFromCoverage(environment.global.__coverage__))
        const mockedFiles = getFilesWithPath(testSuiteMockedFiles.get(environment.testSuiteAbsolutePath) || [])

        testSuiteCodeCoverageCh.publish({
          coverageFiles,
          testSuite: environment.testSourceFile,
          mockedFiles,
          testSuiteAbsolutePath: environment.testSuiteAbsolutePath,
        })
      }
      testSuiteFinishCh.publish({ status, errorMessage, testSuiteAbsolutePath: environment.testSuiteAbsolutePath })

      return suiteResults
    }).catch(error => {
      testSuiteFinishCh.publish({ status: 'fail', error, testSuiteAbsolutePath: environment.testSuiteAbsolutePath })
      throw error
    }).finally(() => {
      testSuiteMockedFiles.delete(environment.testSuiteAbsolutePath)
      testSuiteJestObjects.delete(environment.testSuiteAbsolutePath)
    })
  })
  if (jestAdapter.default) {
    jestAdapter.default = newAdapter
  } else {
    jestAdapter = newAdapter
  }

  return jestAdapter
}

// TestScheduler hooks
addHook({
  name: '@jest/core',
  file: 'build/TestScheduler.js',
  versions: ['>=27.0.0'],
}, (testSchedulerPackage, frameworkVersion) => {
  const oldCreateTestScheduler = testSchedulerPackage.createTestScheduler
  const newCreateTestScheduler = async function () {
    if (!state.isSuitesSkippingEnabled || state.hasFilteredSkippableSuites) {
      return oldCreateTestScheduler.apply(this, arguments)
    }
    // If suite skipping is enabled and has not filtered skippable suites yet, we'll attempt to do it
    const scheduler = await oldCreateTestScheduler.apply(this, arguments)
    shimmer.wrap(scheduler, 'scheduleTests', scheduleTests => getWrappedScheduleTests(scheduleTests, frameworkVersion))
    return scheduler
  }
  testSchedulerPackage.createTestScheduler = newCreateTestScheduler
  return testSchedulerPackage
})

addHook({
  name: '@jest/core',
  file: 'build/TestScheduler.js',
  versions: ['>=24.8.0 <27.0.0'],
}, (testSchedulerPackage, frameworkVersion) => {
  shimmer.wrap(
    testSchedulerPackage.default.prototype,
    'scheduleTests', scheduleTests => getWrappedScheduleTests(scheduleTests, frameworkVersion)
  )
  return testSchedulerPackage
})

// Test sequencer hook
addHook({
  name: '@jest/test-sequencer',
  versions: ['>=28'],
}, (sequencerPackage, frameworkVersion) => {
  shimmer.wrap(sequencerPackage.default.prototype, 'shard', shard => function () {
    const shardedTests = shard.apply(this, arguments)

    if (!shardedTests.length || !state.isSuitesSkippingEnabled || !state.skippableSuites.length) {
      return shardedTests
    }
    const [test] = shardedTests
    const rootDir = test?.context?.config?.rootDir

    return applySuiteSkipping(shardedTests, rootDir, frameworkVersion)
  })
  return sequencerPackage
})

// Coverage reporter hooks
addHook({
  name: '@jest/reporters',
  file: 'build/coverage_reporter.js',
  versions: ['>=24.8.0 <26.6.2'],
}, coverageReporterWrapper)

addHook({
  name: '@jest/reporters',
  file: 'build/CoverageReporter.js',
  versions: ['>=26.6.2'],
}, coverageReporterWrapper)

addHook({
  name: '@jest/reporters',
  versions: ['>=30.0.0'],
}, (reporters) => {
  return shimmer.wrap(reporters, 'CoverageReporter', coverageReporterWrapper, { replaceGetter: true })
})

// CLI hooks
addHook({
  name: '@jest/core',
  file: 'build/cli/index.js',
  versions: ['>=24.8.0 <30.0.0'],
}, getCliWrapper(false))

addHook({
  name: '@jest/core',
  versions: ['>=30.0.0'],
}, getCliWrapper(true))

// Jest adapter hooks
addHook({
  name: 'jest-circus',
  file: 'build/runner.js',
  versions: ['>=30.0.0'],
}, jestAdapterWrapper)

addHook({
  name: 'jest-circus',
  file: 'build/legacy-code-todo-rewrite/jestAdapter.js',
  versions: ['>=24.8.0'],
}, jestAdapterWrapper)

// Transform hooks
addHook({
  name: '@jest/transform',
  versions: ['>=24.8.0 <30.0.0'],
  file: 'build/ScriptTransformer.js',
}, transformPackage => {
  transformPackage.createScriptTransformer = wrapCreateScriptTransformer(transformPackage.createScriptTransformer)

  return transformPackage
})

addHook({
  name: '@jest/transform',
  versions: ['>=30.0.0'],
}, transformPackage => {
  return shimmer.wrap(transformPackage, 'createScriptTransformer', wrapCreateScriptTransformer, { replaceGetter: true })
})

/**
 * Hook to remove the test paths (test suite) that are part of `skippableSuites`
 */
addHook({
  name: '@jest/core',
  versions: ['>=24.8.0 <30.0.0'],
  file: 'build/SearchSource.js',
}, searchSourceWrapper)

// jest-config hooks
// from 25.1.0 on, readConfigs becomes async
addHook({
  name: 'jest-config',
  versions: ['>=25.1.0'],
}, jestConfigAsyncWrapper)

addHook({
  name: 'jest-config',
  versions: ['24.8.0 - 24.9.0'],
}, jestConfigSyncWrapper)
