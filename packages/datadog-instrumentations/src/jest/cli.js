'use strict'

const shimmer = require('../../../datadog-shimmer')
const log = require('../../../dd-trace/src/log')
const {
  getTestSuitePath,
  getIsFaultyEarlyFlakeDetection,
} = require('../../../dd-trace/src/plugins/util/test')
const {
  SEED_SUFFIX_RE,
} = require('../../../datadog-plugin-jest/src/util')
const {
  testSessionStartCh,
  testSessionFinishCh,
  codeCoverageReportCh,
  libraryConfigurationCh,
  knownTestsCh,
  skippableSuitesCh,
  testManagementTestsCh,
  modifiedFilesCh,
  FLUSH_TIMEOUT,
} = require('./channels')
const {
  state,
  newTestsTestStatuses,
  testSuiteAbsolutePathsWithFastCheck,
  newTestsWithDynamicNames,
} = require('./state')
const { applySuiteSkipping } = require('./environment')

const MAX_IGNORED_TEST_NAMES = 10

async function fetchKnownTests () {
  if (!state.isKnownTestsEnabled) return
  try {
    const { err, knownTests } = await new Promise((resolve) => {
      knownTestsCh.publish({ onDone: resolve })
    })
    if (err) {
      state.isEarlyFlakeDetectionEnabled = false
      state.isKnownTestsEnabled = false
    } else {
      state.knownTests = knownTests
    }
  } catch (err) {
    log.error('Jest known tests error', err)
  }
}

async function fetchSkippableSuites () {
  if (!state.isSuitesSkippingEnabled) return
  try {
    const { err, skippableSuites } = await new Promise((resolve) => {
      skippableSuitesCh.publish({ onDone: resolve })
    })
    if (!err) {
      state.skippableSuites = skippableSuites
    }
  } catch (err) {
    log.error('Jest test-suite skippable error', err)
  }
}

async function fetchTestManagementTests () {
  if (!state.isTestManagementTestsEnabled) return
  try {
    const { err, testManagementTests } = await new Promise((resolve) => {
      testManagementTestsCh.publish({ onDone: resolve })
    })
    if (err) {
      state.isTestManagementTestsEnabled = false
      state.testManagementTests = {}
    } else {
      state.testManagementTests = testManagementTests || {}
    }
  } catch (err) {
    log.error('Jest test management tests error', err)
    state.isTestManagementTestsEnabled = false
  }
}

async function fetchModifiedFiles () {
  if (!state.isImpactedTestsEnabled) return
  try {
    const { err, modifiedFiles } = await new Promise((resolve) => {
      modifiedFilesCh.publish({ onDone: resolve })
    })
    if (!err) {
      state.modifiedFiles = modifiedFiles
    }
  } catch (err) {
    log.error('Jest impacted tests error', err)
  }
}

function getTestStats (testStatuses) {
  return testStatuses.reduce((acc, testStatus) => {
    acc[testStatus]++
    return acc
  }, { pass: 0, fail: 0 })
}

/**
 * @param {string[]} efdNames
 * @param {string[]} quarantineNames
 * @param {number} totalCount
 */
function logIgnoredFailuresSummary (efdNames, quarantineNames, totalCount) {
  const names = []
  for (const n of efdNames) {
    names.push({ name: n, reason: 'Early Flake Detection' })
  }
  for (const n of quarantineNames) {
    names.push({ name: n, reason: 'Quarantine' })
  }
  const shown = names.slice(0, MAX_IGNORED_TEST_NAMES)
  const more = names.length - shown.length
  const moreSuffix = more > 0 ? `\n  ... and ${more} more` : ''
  const list = shown.map(({ name, reason }) => `  • ${name} (${reason})`).join('\n')
  const line = '-'.repeat(50)
  // eslint-disable-next-line no-console -- Intentional user-facing message when exit code is flipped
  console.warn(
    `\n${line}\nDatadog Test Optimization\n${line}\n` +
    `${totalCount} test failure(s) were ignored. Exit code set to 0.\n\n` +
    `${list}${moreSuffix}\n`
  )
}

function logDynamicNameWarning () {
  if (newTestsWithDynamicNames.size === 0) return
  const shown = [...newTestsWithDynamicNames].slice(0, MAX_IGNORED_TEST_NAMES)
  const more = newTestsWithDynamicNames.size - shown.length
  const moreSuffix = more > 0 ? `\n  ... and ${more} more` : ''
  const list = shown.map(name => `  • ${name}`).join('\n')
  const line = '-'.repeat(50)
  // eslint-disable-next-line no-console -- Intentional user-facing warning about dynamic test names
  console.warn(
    `\n${line}\nDatadog Test Optimization\n${line}\n` +
    `${newTestsWithDynamicNames.size} test(s) were detected as new but their names contain ` +
    'dynamic data (timestamps, UUIDs, etc.).\n' +
    'These tests might not actually be new. Consider using constant test names.\n\n' +
    `${list}${moreSuffix}\n`
  )
  newTestsWithDynamicNames.clear()
}

/**
 * Builds a map from test fullName to its suite relative path.
 *
 * @param {object} result - The runCLI result object
 * @returns {Map<string, string>}
 */
function buildFullNameToSuiteMap (result) {
  const fullNameToSuite = new Map()
  for (const { testResults, testFilePath } of result.results.testResults) {
    const suite = getTestSuitePath(testFilePath, result.globalConfig.rootDir)
    for (const { fullName } of testResults) {
      const name = testSuiteAbsolutePathsWithFastCheck.has(testFilePath)
        ? fullName.replace(SEED_SUFFIX_RE, '')
        : fullName
      fullNameToSuite.set(name, suite)
    }
  }
  return fullNameToSuite
}

/**
 * Checks EFD retries and quarantined tests to determine if all failures
 * can be ignored. Mutates `result.results.success` when all failures are
 * accounted for.
 *
 * @param {object} result - The runCLI result object
 * @param {Map<string, string>} fullNameToSuite
 * @param {boolean} mustNotFlipSuccess
 * @returns {{ efdNames: string[], quarantineNames: string[],
 *   totalCount: number } | undefined}
 */
function computeIgnoredFailures (result, fullNameToSuite, mustNotFlipSuccess) {
  let numEfdFailedTestsToIgnore = 0
  const efdIgnoredNames = []
  const quarantineIgnoredNames = []

  /** @type {{ efdNames: string[], quarantineNames: string[], totalCount: number } | undefined} */
  let ignoredFailuresSummary

  if (state.isEarlyFlakeDetectionEnabled) {
    for (const [testName, testStatuses] of newTestsTestStatuses) {
      const { pass, fail } = getTestStats(testStatuses)
      if (pass > 0) { // as long as one passes, we'll consider the test passed
        numEfdFailedTestsToIgnore += fail
        const suite = fullNameToSuite.get(testName)
        efdIgnoredNames.push(suite ? `${suite} › ${testName}` : testName)
      }
    }
    // If every test that failed was an EFD retry, we'll consider the suite passed
    if (
      !mustNotFlipSuccess &&
      numEfdFailedTestsToIgnore !== 0 &&
      result.results.numFailedTests === numEfdFailedTestsToIgnore
    ) {
      result.results.success = true
      ignoredFailuresSummary = {
        efdNames: efdIgnoredNames,
        quarantineNames: [],
        totalCount: numEfdFailedTestsToIgnore,
      }
    }
  }

  let numFailedQuarantinedTests = 0
  let numFailedQuarantinedOrDisabledAttemptedToFixTests = 0
  if (state.isTestManagementTestsEnabled) {
    const failedTests = result
      .results
      .testResults.flatMap(({ testResults, testFilePath: testSuiteAbsolutePath }) => (
        testResults.map(({ fullName: testName, status }) => (
          {
            // Strip @fast-check/jest seed suffix so the name matches what was reported via TEST_NAME
            testName: testSuiteAbsolutePathsWithFastCheck.has(testSuiteAbsolutePath)
              ? testName.replace(SEED_SUFFIX_RE, '')
              : testName,
            testSuiteAbsolutePath,
            status,
          }
        ))
      ))
      .filter(({ status }) => status === 'failed')

    for (const { testName, testSuiteAbsolutePath } of failedTests) {
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, result.globalConfig.rootDir)
      const testManagementTest = state.testManagementTests
        ?.jest
        ?.suites
        ?.[testSuite]
        ?.tests
        ?.[testName]
        ?.properties
      // This uses `attempt_to_fix` because this is always the main process and it's not formatted in camelCase
      if (testManagementTest?.attempt_to_fix && (testManagementTest?.quarantined || testManagementTest?.disabled)) {
        numFailedQuarantinedOrDisabledAttemptedToFixTests++
        quarantineIgnoredNames.push(`${testSuite} › ${testName}`)
      } else if (testManagementTest?.quarantined) {
        numFailedQuarantinedTests++
        quarantineIgnoredNames.push(`${testSuite} › ${testName}`)
      }
    }

    // If every test that failed was quarantined, we'll consider the suite passed
    // Note that if a test is attempted to fix,
    // it's considered quarantined both if it's disabled and if it's quarantined
    // (it'll run but its status is ignored)
    // Skip if EFD block already flipped (to avoid logging twice)
    if (
      !result.results.success &&
      !mustNotFlipSuccess &&
      (numFailedQuarantinedOrDisabledAttemptedToFixTests !== 0 || numFailedQuarantinedTests !== 0) &&
      result.results.numFailedTests ===
        numFailedQuarantinedTests + numFailedQuarantinedOrDisabledAttemptedToFixTests
    ) {
      result.results.success = true
      ignoredFailuresSummary = {
        efdNames: [],
        quarantineNames: quarantineIgnoredNames,
        totalCount: numFailedQuarantinedTests + numFailedQuarantinedOrDisabledAttemptedToFixTests,
      }
    }
  }

  // Combined check: if all failed tests are accounted for by EFD (flaky retries) and/or quarantine,
  // we should consider the suite passed even when neither check alone covers all failures.
  if (
    !result.results.success &&
    !mustNotFlipSuccess &&
    (state.isEarlyFlakeDetectionEnabled || state.isTestManagementTestsEnabled)
  ) {
    const totalIgnoredFailures =
      numEfdFailedTestsToIgnore + numFailedQuarantinedTests + numFailedQuarantinedOrDisabledAttemptedToFixTests
    if (
      totalIgnoredFailures !== 0 &&
      result.results.numFailedTests === totalIgnoredFailures
    ) {
      result.results.success = true
      ignoredFailuresSummary = {
        efdNames: efdIgnoredNames,
        quarantineNames: quarantineIgnoredNames,
        totalCount: totalIgnoredFailures,
      }
    }
  }

  return ignoredFailuresSummary
}

function searchSourceWrapper (searchSourcePackage, frameworkVersion) {
  const SearchSource = searchSourcePackage.default ?? searchSourcePackage

  shimmer.wrap(SearchSource.prototype, 'getTestPaths', getTestPaths => async function () {
    const testPaths = await getTestPaths.apply(this, arguments)
    const [{ rootDir, shard }] = arguments

    if (state.isKnownTestsEnabled) {
      const projectSuites = testPaths.tests.map(test => getTestSuitePath(test.path, test.context.config.rootDir))

      // If the `jest` key does not exist in the known tests response, we consider the Early Flake detection faulty.
      const isFaulty = !state.knownTests?.jest ||
        getIsFaultyEarlyFlakeDetection(
          projectSuites, state.knownTests.jest, state.earlyFlakeDetectionFaultyThreshold
        )

      if (isFaulty) {
        log.error('Early flake detection is disabled because the number of new suites is too high.')
        state.isEarlyFlakeDetectionEnabled = false
        state.isKnownTestsEnabled = false
        const testEnvironmentOptions = testPaths.tests[0]?.context?.config?.testEnvironmentOptions
        // Project config is shared among all tests, so we can modify it here
        if (testEnvironmentOptions) {
          testEnvironmentOptions._ddIsEarlyFlakeDetectionEnabled = false
          testEnvironmentOptions._ddIsKnownTestsEnabled = false
        }
        state.isEarlyFlakeDetectionFaulty = true
      }
    }

    if (shard?.shardCount > 1 || !state.isSuitesSkippingEnabled || !state.skippableSuites.length) {
      // If the user is using jest sharding, we want to apply the filtering of tests in the shard process.
      // The reason for this is the following:
      // The tests for different shards are likely being run in different CI jobs so
      // the requests to the skippable endpoint might be done at different times and their responses might be different.
      // If the skippable endpoint is returning different suites and we filter the list of tests here,
      // the base list of tests that is used for sharding might be different,
      // causing the shards to potentially run the same suite.
      return testPaths
    }
    const { tests } = testPaths

    const suitesToRun = applySuiteSkipping(tests, rootDir, frameworkVersion)
    return { ...testPaths, tests: suitesToRun }
  })

  return searchSourcePackage
}

function coverageReporterWrapper (coverageReporter) {
  const CoverageReporter = coverageReporter.default ?? coverageReporter

  /**
   * If ITR is active, we're running fewer tests, so of course the total code coverage is reduced.
   * This calculation adds no value, so we'll skip it, as long as the user has not manually opted in to code coverage,
   * in which case we'll leave it.
   */
  // `_addUntestedFiles` is an async function
  shimmer.wrap(CoverageReporter.prototype, '_addUntestedFiles', addUntestedFiles => function () {
    if (state.isCodeCoverageEnabledBecauseOfUs && !state.isKeepingCoverageConfiguration) {
      return Promise.resolve()
    }
    return addUntestedFiles.apply(this, arguments)
  })

  return coverageReporter
}

function getCliWrapper (isNewJestVersion) {
  return function cliWrapper (cli, jestVersion) {
    if (isNewJestVersion) {
      cli = shimmer.wrap(
        cli,
        'SearchSource',
        searchSource => searchSourceWrapper(searchSource, jestVersion),
        { replaceGetter: true }
      )
    }
    return shimmer.wrap(cli, 'runCLI', runCLI => async function () {
      let onDone
      const configurationPromise = new Promise((resolve) => {
        onDone = resolve
      })
      if (!libraryConfigurationCh.hasSubscribers) {
        return runCLI.apply(this, arguments)
      }

      libraryConfigurationCh.publish({ onDone, frameworkVersion: jestVersion })

      try {
        const { err, libraryConfig } = await configurationPromise
        if (!err) {
          state.isCodeCoverageEnabled = libraryConfig.isCodeCoverageEnabled
          state.isSuitesSkippingEnabled = libraryConfig.isSuitesSkippingEnabled
          state.isKeepingCoverageConfiguration =
            libraryConfig.isKeepingCoverageConfiguration ?? state.isKeepingCoverageConfiguration
          state.isEarlyFlakeDetectionEnabled = libraryConfig.isEarlyFlakeDetectionEnabled
          state.earlyFlakeDetectionNumRetries = libraryConfig.earlyFlakeDetectionNumRetries
          state.earlyFlakeDetectionSlowTestRetries = libraryConfig.earlyFlakeDetectionSlowTestRetries ?? {}
          state.earlyFlakeDetectionFaultyThreshold = libraryConfig.earlyFlakeDetectionFaultyThreshold
          state.isKnownTestsEnabled = libraryConfig.isKnownTestsEnabled
          state.isTestManagementTestsEnabled = libraryConfig.isTestManagementEnabled
          state.testManagementAttemptToFixRetries = libraryConfig.testManagementAttemptToFixRetries
          state.isImpactedTestsEnabled = libraryConfig.isImpactedTestsEnabled
        }
      } catch (err) {
        log.error('Jest library configuration error', err)
      }

      await fetchKnownTests()
      await fetchSkippableSuites()
      await fetchTestManagementTests()
      await fetchModifiedFiles()

      const processArgv = process.argv.slice(2).join(' ')
      testSessionStartCh.publish({ command: `jest ${processArgv}`, frameworkVersion: jestVersion })

      const result = await runCLI.apply(this, arguments)

      const {
        results: {
          coverageMap,
          numFailedTestSuites,
          numFailedTests,
          numRuntimeErrorTestSuites = 0,
          numTotalTests,
          numTotalTestSuites,
          runExecError,
          wasInterrupted,
        },
      } = result

      const hasSuiteLevelFailures = numRuntimeErrorTestSuites > 0
      const hasRunLevelFailure = runExecError != null || wasInterrupted === true
      const mustNotFlipSuccess = hasSuiteLevelFailures || hasRunLevelFailure

      let testCodeCoverageLinesTotal

      if (state.isUserCodeCoverageEnabled) {
        try {
          const { pct, total } = coverageMap.getCoverageSummary().lines
          testCodeCoverageLinesTotal = total === 0 ? 0 : pct
        } catch {
          // ignore errors
        }
      }

      const fullNameToSuite = buildFullNameToSuiteMap(result)
      const ignoredFailuresSummary = computeIgnoredFailures(result, fullNameToSuite, mustNotFlipSuccess)

      // Determine session status after EFD and quarantine checks have potentially modified success
      let status, error
      if (result.results.success) {
        status = numTotalTests === 0 && numTotalTestSuites === 0 ? 'skip' : 'pass'
      } else {
        status = 'fail'
        error = new Error(`Failed test suites: ${numFailedTestSuites}. Failed tests: ${numFailedTests}`)
      }

      let timeoutId

      // Pass the resolve callback to defer it to DC listener
      const flushPromise = new Promise((resolve) => {
        onDone = () => {
          clearTimeout(timeoutId)
          resolve()
        }
      })

      const timeoutPromise = new Promise((resolve) => {
        timeoutId = setTimeout(() => {
          resolve('timeout')
        }, FLUSH_TIMEOUT).unref()
      })

      testSessionFinishCh.publish({
        status,
        isSuitesSkipped: state.isSuitesSkipped,
        isSuitesSkippingEnabled: state.isSuitesSkippingEnabled,
        isCodeCoverageEnabled: state.isCodeCoverageEnabled,
        testCodeCoverageLinesTotal,
        numSkippedSuites: state.numSkippedSuites,
        hasUnskippableSuites: state.hasUnskippableSuites,
        hasForcedToRunSuites: state.hasForcedToRunSuites,
        error,
        isEarlyFlakeDetectionEnabled: state.isEarlyFlakeDetectionEnabled,
        isEarlyFlakeDetectionFaulty: state.isEarlyFlakeDetectionFaulty,
        isTestManagementTestsEnabled: state.isTestManagementTestsEnabled,
        onDone,
      })

      const waitingResult = await Promise.race([flushPromise, timeoutPromise])

      if (waitingResult === 'timeout') {
        log.error('Timeout waiting for the tracer to flush')
      }

      if (codeCoverageReportCh.hasSubscribers) {
        const rootDir = result.globalConfig?.rootDir || process.cwd()
        await new Promise((resolve) => {
          codeCoverageReportCh.publish({ rootDir, onDone: resolve })
        })
      }

      if (ignoredFailuresSummary) {
        logIgnoredFailuresSummary(
          ignoredFailuresSummary.efdNames,
          ignoredFailuresSummary.quarantineNames,
          ignoredFailuresSummary.totalCount
        )
      }

      logDynamicNameWarning()

      state.numSkippedSuites = 0

      return result
    }, {
      replaceGetter: true,
    })
  }
}

module.exports = { getCliWrapper, searchSourceWrapper, coverageReporterWrapper }
