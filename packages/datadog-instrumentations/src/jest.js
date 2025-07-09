'use strict'

const { addHook, channel } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')
const path = require('path')
const {
  getCoveredFilenamesFromCoverage,
  JEST_WORKER_TRACE_PAYLOAD_CODE,
  JEST_WORKER_COVERAGE_PAYLOAD_CODE,
  getTestLineStart,
  getTestSuitePath,
  getTestParametersString,
  addEfdStringToTestName,
  removeEfdStringFromTestName,
  getIsFaultyEarlyFlakeDetection,
  JEST_WORKER_LOGS_PAYLOAD_CODE,
  addAttemptToFixStringToTestName,
  removeAttemptToFixStringFromTestName,
  getTestEndLine,
  isModifiedTest
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
const workerReportLogsCh = channel('ci:jest:worker-report:logs')

const testSuiteCodeCoverageCh = channel('ci:jest:test-suite:code-coverage')

const testStartCh = channel('ci:jest:test:start')
const testSkippedCh = channel('ci:jest:test:skip')
const testFinishCh = channel('ci:jest:test:finish')
const testErrCh = channel('ci:jest:test:err')
const testFnCh = channel('ci:jest:test:fn')

const skippableSuitesCh = channel('ci:jest:test-suite:skippable')
const libraryConfigurationCh = channel('ci:jest:library-configuration')
const knownTestsCh = channel('ci:jest:known-tests')
const testManagementTestsCh = channel('ci:jest:test-management-tests')
const impactedTestsCh = channel('ci:jest:modified-tests')

const itrSkippedSuitesCh = channel('ci:jest:itr:skipped-suites')

// Message sent by jest's main process to workers to run a test suite (=test file)
// https://github.com/jestjs/jest/blob/1d682f21c7a35da4d3ab3a1436a357b980ebd0fa/packages/jest-worker/src/types.ts#L37
const CHILD_MESSAGE_CALL = 1
// Maximum time we'll wait for the tracer to flush
const FLUSH_TIMEOUT = 10_000

// https://github.com/jestjs/jest/blob/41f842a46bb2691f828c3a5f27fc1d6290495b82/packages/jest-circus/src/types.ts#L9C8-L9C54
const RETRY_TIMES = Symbol.for('RETRY_TIMES')

let skippableSuites = []
let knownTests = {}
let isCodeCoverageEnabled = false
let isSuitesSkippingEnabled = false
let isUserCodeCoverageEnabled = false
let isSuitesSkipped = false
let numSkippedSuites = 0
let hasUnskippableSuites = false
let hasForcedToRunSuites = false
let isEarlyFlakeDetectionEnabled = false
let earlyFlakeDetectionNumRetries = 0
let earlyFlakeDetectionFaultyThreshold = 30
let isEarlyFlakeDetectionFaulty = false
let hasFilteredSkippableSuites = false
let isKnownTestsEnabled = false
let isTestManagementTestsEnabled = false
let testManagementTests = {}
let testManagementAttemptToFixRetries = 0
let isImpactedTestsEnabled = false
let modifiedTests = {}

const testContexts = new WeakMap()
const originalTestFns = new WeakMap()
const originalHookFns = new WeakMap()
const retriedTestsToNumAttempts = new Map()
const newTestsTestStatuses = new Map()
const attemptToFixRetriedTestsStatuses = new Map()
const wrappedWorkers = new WeakSet()
const testSuiteMockedFiles = new Map()

const BREAKPOINT_HIT_GRACE_PERIOD_MS = 200

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

function getTestStats (testStatuses) {
  return testStatuses.reduce((acc, testStatus) => {
    acc[testStatus]++
    return acc
  }, { pass: 0, fail: 0 })
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
      this.hasSnapshotTests = undefined
      this.testSuiteAbsolutePath = context.testPath

      this.displayName = config.projectConfig?.displayName?.name
      this.testEnvironmentOptions = getTestEnvironmentOptions(config)

      const repositoryRoot = this.testEnvironmentOptions._ddRepositoryRoot

      if (repositoryRoot) {
        this.testSourceFile = getTestSuitePath(context.testPath, repositoryRoot)
        this.repositoryRoot = repositoryRoot
      }

      this.isEarlyFlakeDetectionEnabled = this.testEnvironmentOptions._ddIsEarlyFlakeDetectionEnabled
      this.isFlakyTestRetriesEnabled = this.testEnvironmentOptions._ddIsFlakyTestRetriesEnabled
      this.flakyTestRetriesCount = this.testEnvironmentOptions._ddFlakyTestRetriesCount
      this.isDiEnabled = this.testEnvironmentOptions._ddIsDiEnabled
      this.isKnownTestsEnabled = this.testEnvironmentOptions._ddIsKnownTestsEnabled
      this.isTestManagementTestsEnabled = this.testEnvironmentOptions._ddIsTestManagementTestsEnabled
      this.isImpactedTestsEnabled = this.testEnvironmentOptions._ddIsImpactedTestsEnabled

      if (this.isKnownTestsEnabled) {
        try {
          const hasKnownTests = !!knownTests?.jest
          earlyFlakeDetectionNumRetries = this.testEnvironmentOptions._ddEarlyFlakeDetectionNumRetries
          this.knownTestsForThisSuite = hasKnownTests
            ? (knownTests?.jest?.[this.testSuite] || [])
            : this.getKnownTestsForSuite(this.testEnvironmentOptions._ddKnownTests)
        } catch {
          // If there has been an error parsing the tests, we'll disable Early Flake Deteciton
          this.isEarlyFlakeDetectionEnabled = false
          this.isKnownTestsEnabled = false
        }
      }

      if (this.isFlakyTestRetriesEnabled) {
        const currentNumRetries = this.global[RETRY_TIMES]
        if (!currentNumRetries) {
          this.global[RETRY_TIMES] = this.flakyTestRetriesCount
        }
      }

      if (this.isTestManagementTestsEnabled) {
        try {
          const hasTestManagementTests = !!testManagementTests?.jest
          testManagementAttemptToFixRetries = this.testEnvironmentOptions._ddTestManagementAttemptToFixRetries
          this.testManagementTestsForThisSuite = hasTestManagementTests
            ? this.getTestManagementTestsForSuite(testManagementTests?.jest?.suites?.[this.testSuite]?.tests)
            : this.getTestManagementTestsForSuite(this.testEnvironmentOptions._ddTestManagementTests)
        } catch (e) {
          log.error('Error parsing test management tests', e)
          this.isTestManagementTestsEnabled = false
        }
      }

      if (this.isImpactedTestsEnabled) {
        try {
          const hasImpactedTests = Object.keys(modifiedTests).length > 0
          this.modifiedTestsForThisSuite = hasImpactedTests
            ? this.getModifiedTestForThisSuite(modifiedTests)
            : this.getModifiedTestForThisSuite(this.testEnvironmentOptions._ddModifiedTests)
        } catch (e) {
          log.error('Error parsing impacted tests', e)
          this.isImpactedTestsEnabled = false
        }
      }
    }

    getHasSnapshotTests () {
      if (this.hasSnapshotTests !== undefined) {
        return this.hasSnapshotTests
      }
      let hasSnapshotTests = true
      try {
        const { _snapshotData } = this.getVmContext().expect.getState().snapshotState
        hasSnapshotTests = Object.keys(_snapshotData).length > 0
      } catch {
        // if we can't be sure, we'll err on the side of caution and assume it has snapshots
      }
      this.hasSnapshotTests = hasSnapshotTests
      return hasSnapshotTests
    }

    // Function that receives a list of known tests for a test service and
    // returns the ones that belong to the current suite
    getKnownTestsForSuite (knownTests) {
      if (this.knownTestsForThisSuite) {
        return this.knownTestsForThisSuite
      }
      let knownTestsForSuite = knownTests
      // If jest is using workers, known tests are serialized to json.
      // If jest runs in band, they are not.
      if (typeof knownTestsForSuite === 'string') {
        knownTestsForSuite = JSON.parse(knownTestsForSuite)
      }
      return knownTestsForSuite
    }

    getTestManagementTestsForSuite (testManagementTests) {
      if (this.testManagementTestsForThisSuite) {
        return this.testManagementTestsForThisSuite
      }
      if (!testManagementTests) {
        return {
          attemptToFix: [],
          disabled: [],
          quarantined: []
        }
      }
      let testManagementTestsForSuite = testManagementTests
      // If jest is using workers, test management tests are serialized to json.
      // If jest runs in band, they are not.
      if (typeof testManagementTestsForSuite === 'string') {
        testManagementTestsForSuite = JSON.parse(testManagementTestsForSuite)
      }

      const result = {
        attemptToFix: [],
        disabled: [],
        quarantined: []
      }

      Object.entries(testManagementTestsForSuite).forEach(([testName, { properties }]) => {
        if (properties?.attempt_to_fix) {
          result.attemptToFix.push(testName)
        }
        if (properties?.disabled) {
          result.disabled.push(testName)
        }
        if (properties?.quarantined) {
          result.quarantined.push(testName)
        }
      })

      return result
    }

    getModifiedTestForThisSuite (modifiedTests) {
      if (this.modifiedTestsForThisSuite) {
        return this.modifiedTestsForThisSuite
      }
      let modifiedTestsForThisSuite = modifiedTests
      // If jest is using workers, modified tests are serialized to json.
      // If jest runs in band, they are not.
      if (typeof modifiedTestsForThisSuite === 'string') {
        modifiedTestsForThisSuite = JSON.parse(modifiedTestsForThisSuite)
      }
      return modifiedTestsForThisSuite
    }

    // Generic function to handle test retries
    retryTest (testName, retryCount, addRetryStringToTestName, retryType, event) {
      // Retrying snapshots has proven to be problematic, so we'll skip them for now
      // We'll still detect new tests, but we won't retry them.
      // TODO: do not bail out of retrying tests for the whole test suite
      if (this.getHasSnapshotTests()) {
        log.warn('%s is disabled for suites with snapshots', retryType)
        return
      }

      for (let retryIndex = 0; retryIndex < retryCount; retryIndex++) {
        if (this.global.test) {
          this.global.test(addRetryStringToTestName(testName, retryIndex), event.fn, event.timeout)
        } else {
          log.error('%s could not retry test because global.test is undefined', retryType)
        }
      }
    }

    // At the `add_test` event we don't have the test object yet, so we can't use it
    getTestNameFromAddTestEvent (event, state) {
      const describeSuffix = getJestTestName(state.currentDescribeBlock)
      const fullTestName = describeSuffix ? `${describeSuffix} ${event.testName}` : event.testName
      return removeAttemptToFixStringFromTestName(removeEfdStringFromTestName(fullTestName))
    }

    async handleTestEvent (event, state) {
      if (super.handleTestEvent) {
        await super.handleTestEvent(event, state)
      }

      const setNameToParams = (name, params) => { this.nameToParams[name] = [...params] }

      if (event.name === 'setup' && this.global.test) {
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
      if (event.name === 'test_start') {
        let isNewTest = false
        let numEfdRetry = null
        let numOfAttemptsToFixRetries = null
        const testParameters = getTestParametersString(this.nameToParams, event.test.name)
        // Async resource for this test is created here
        // It is used later on by the test_done handler
        const testName = getJestTestName(event.test)
        const originalTestName = removeEfdStringFromTestName(removeAttemptToFixStringFromTestName(testName))

        let isAttemptToFix = false
        let isDisabled = false
        let isQuarantined = false
        if (this.isTestManagementTestsEnabled) {
          isAttemptToFix = this.testManagementTestsForThisSuite?.attemptToFix?.includes(originalTestName)
          isDisabled = this.testManagementTestsForThisSuite?.disabled?.includes(originalTestName)
          isQuarantined = this.testManagementTestsForThisSuite?.quarantined?.includes(originalTestName)
          if (isAttemptToFix) {
            numOfAttemptsToFixRetries = retriedTestsToNumAttempts.get(originalTestName)
            retriedTestsToNumAttempts.set(originalTestName, numOfAttemptsToFixRetries + 1)
          } else if (isDisabled) {
            event.test.mode = 'skip'
          }
        }

        let isModified = false
        if (this.isImpactedTestsEnabled) {
          const testStartLine = getTestLineStart(event.test.asyncError, this.testSuite)
          const testEndLine = getTestEndLine(event.test.fn, testStartLine)
          isModified = isModifiedTest(
            this.testSourceFile,
            testStartLine,
            testEndLine,
            this.modifiedTestsForThisSuite,
            'jest'
          )
        }

        if (this.isKnownTestsEnabled) {
          isNewTest = retriedTestsToNumAttempts.has(originalTestName)
        }

        if (this.isEarlyFlakeDetectionEnabled && (isNewTest || isModified)) {
          numEfdRetry = retriedTestsToNumAttempts.get(originalTestName)
          retriedTestsToNumAttempts.set(originalTestName, numEfdRetry + 1)
        }

        const isJestRetry = event.test?.invocations > 1
        const ctx = {
          name: originalTestName,
          suite: this.testSuite,
          testSourceFile: this.testSourceFile,
          displayName: this.displayName,
          testParameters,
          frameworkVersion: jestVersion,
          isNew: isNewTest,
          isEfdRetry: numEfdRetry > 0,
          isAttemptToFix,
          isAttemptToFixRetry: numOfAttemptsToFixRetries > 0,
          isJestRetry,
          isDisabled,
          isQuarantined,
          isModified
        }
        testContexts.set(event.test, ctx)

        testStartCh.runStores(ctx, () => {
          for (const hook of event.test.parent.hooks) {
            let hookFn = hook.fn
            if (originalHookFns.has(hook)) {
              hookFn = originalHookFns.get(hook)
            } else {
              originalHookFns.set(hook, hookFn)
            }
            // The rule has a bug, see https://github.com/sindresorhus/eslint-plugin-unicorn/issues/2164
            // eslint-disable-next-line unicorn/consistent-function-scoping
            const wrapperHook = function () {
              return testFnCh.runStores(ctx, () => hookFn.apply(this, arguments))
            }
            // If we don't do this, the timeout will not be triggered
            Object.defineProperty(wrapperHook, 'length', { value: hookFn.length })
            hook.fn = wrapperHook
          }
          const originalFn = event.test.fn
          originalTestFns.set(event.test, originalFn)
          const wrapper = function () {
            return testFnCh.runStores(ctx, () => originalFn.apply(this, arguments))
          }
          // If we don't do this, the timeout will be not be triggered
          Object.defineProperty(wrapper, 'length', { value: originalFn.length })
          event.test.fn = wrapper
        })
      }

      if (event.name === 'add_test') {
        const originalTestName = this.getTestNameFromAddTestEvent(event, state)

        if (event.failing) {
          return
        }

        const isSkipped = event.mode === 'todo' || event.mode === 'skip'
        if (this.isTestManagementTestsEnabled) {
          const isAttemptToFix = this.testManagementTestsForThisSuite?.attemptToFix?.includes(originalTestName)
          if (isAttemptToFix && !isSkipped && !retriedTestsToNumAttempts.has(originalTestName)) {
            retriedTestsToNumAttempts.set(originalTestName, 0)
            this.retryTest(
              event.testName,
              testManagementAttemptToFixRetries,
              addAttemptToFixStringToTestName,
              'Test Management (Attempt to Fix)',
              event
            )
          }
        }
        if (this.isImpactedTestsEnabled) {
          const testStartLine = getTestLineStart(event.asyncError, this.testSuite)
          const testEndLine = getTestEndLine(event.fn, testStartLine)
          const isModified = isModifiedTest(
            this.testSourceFile,
            testStartLine,
            testEndLine,
            this.modifiedTestsForThisSuite,
            'jest'
          )
          if (isModified && !retriedTestsToNumAttempts.has(originalTestName) && this.isEarlyFlakeDetectionEnabled) {
            retriedTestsToNumAttempts.set(originalTestName, 0)
            this.retryTest(
              event.testName,
              earlyFlakeDetectionNumRetries,
              addEfdStringToTestName,
              'Early flake detection',
              event
            )
          }
        }
        if (this.isKnownTestsEnabled) {
          const isNew = !this.knownTestsForThisSuite?.includes(originalTestName)
          if (isNew && !isSkipped && !retriedTestsToNumAttempts.has(originalTestName)) {
            retriedTestsToNumAttempts.set(originalTestName, 0)
            if (this.isEarlyFlakeDetectionEnabled) {
              this.retryTest(
                event.testName,
                earlyFlakeDetectionNumRetries,
                addEfdStringToTestName,
                'Early flake detection',
                event
              )
            }
          }
        }
      }
      if (event.name === 'test_done') {
        let status = 'pass'
        if (event.test.errors && event.test.errors.length) {
          status = 'fail'
        }
        // restore in case it is retried
        event.test.fn = originalTestFns.get(event.test)

        let attemptToFixPassed = false
        let attemptToFixFailed = false
        let failedAllTests = false
        let isAttemptToFix = false
        if (this.isTestManagementTestsEnabled) {
          const testName = getJestTestName(event.test)
          const originalTestName = removeAttemptToFixStringFromTestName(testName)
          isAttemptToFix = this.testManagementTestsForThisSuite?.attemptToFix?.includes(originalTestName)
          if (isAttemptToFix) {
            if (attemptToFixRetriedTestsStatuses.has(originalTestName)) {
              attemptToFixRetriedTestsStatuses.get(originalTestName).push(status)
            } else {
              attemptToFixRetriedTestsStatuses.set(originalTestName, [status])
            }
            const testStatuses = attemptToFixRetriedTestsStatuses.get(originalTestName)
            // Check if this is the last attempt to fix.
            // If it is, we'll set the failedAllTests flag to true if all the tests failed
            // If all tests passed, we'll set the attemptToFixPassed flag to true
            if (testStatuses.length === testManagementAttemptToFixRetries + 1) {
              if (testStatuses.includes('fail')) {
                attemptToFixFailed = true
              }
              if (testStatuses.every(status => status === 'fail')) {
                failedAllTests = true
              } else if (testStatuses.every(status => status === 'pass')) {
                attemptToFixPassed = true
              }
            }
          }
        }

        let isEfdRetry = false
        // We'll store the test statuses of the retries
        if (this.isKnownTestsEnabled) {
          const testName = getJestTestName(event.test)
          const originalTestName = removeEfdStringFromTestName(testName)
          const isNewTest = retriedTestsToNumAttempts.has(originalTestName)
          if (isNewTest) {
            if (newTestsTestStatuses.has(originalTestName)) {
              newTestsTestStatuses.get(originalTestName).push(status)
              isEfdRetry = true
            } else {
              newTestsTestStatuses.set(originalTestName, [status])
            }
          }
        }

        const promises = {}
        const numRetries = this.global[RETRY_TIMES]
        const numTestExecutions = event.test?.invocations
        const willBeRetried = numRetries > 0 && numTestExecutions - 1 < numRetries
        const mightHitBreakpoint = this.isDiEnabled && numTestExecutions >= 2

        const ctx = testContexts.get(event.test)

        if (status === 'fail') {
          const shouldSetProbe = this.isDiEnabled && willBeRetried && numTestExecutions === 1
          testErrCh.publish({
            ...ctx.currentStore,
            error: formatJestError(event.test.errors[0]),
            shouldSetProbe,
            promises
          })
        }

        // After finishing it might take a bit for the snapshot to be handled.
        // This means that tests retried with DI are BREAKPOINT_HIT_GRACE_PERIOD_MS slower at least.
        if (status === 'fail' && mightHitBreakpoint) {
          await new Promise(resolve => {
            setTimeout(() => {
              resolve()
            }, BREAKPOINT_HIT_GRACE_PERIOD_MS)
          })
        }

        let isAtrRetry = false
        if (this.isFlakyTestRetriesEnabled && event.test?.invocations > 1 && !isAttemptToFix && !isEfdRetry) {
          isAtrRetry = true
        }

        testFinishCh.publish({
          ...ctx.currentStore,
          status,
          testStartLine: getTestLineStart(event.test.asyncError, this.testSuite),
          attemptToFixPassed,
          failedAllTests,
          attemptToFixFailed,
          isAtrRetry
        })

        if (promises.isProbeReady) {
          await promises.isProbeReady
        }
      }
      if (event.name === 'test_skip' || event.name === 'test_todo') {
        testSkippedCh.publish({
          test: {
            name: getJestTestName(event.test),
            suite: this.testSuite,
            testSourceFile: this.testSourceFile,
            displayName: this.displayName,
            frameworkVersion: jestVersion,
            testStartLine: getTestLineStart(event.test.asyncError, this.testSuite)
          },
          isDisabled: this.testManagementTestsForThisSuite?.disabled?.includes(getJestTestName(event.test))
        })
      }
    }

    teardown () {
      if (this._globalProxy?.propertyToValue) {
        for (const [key] of this._globalProxy.propertyToValue) {
          if (typeof key === 'string' && key.startsWith('_dd')) {
            this._globalProxy.propertyToValue.delete(key)
          }
        }
      }
      return super.teardown()
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

function applySuiteSkipping (originalTests, rootDir, frameworkVersion) {
  const jestSuitesToRun = getJestSuitesToRun(skippableSuites, originalTests, rootDir || process.cwd())
  hasFilteredSkippableSuites = true
  log.debug(
    () => `${jestSuitesToRun.suitesToRun.length} out of ${originalTests.length} suites are going to run.`
  )
  hasUnskippableSuites = jestSuitesToRun.hasUnskippableSuites
  hasForcedToRunSuites = jestSuitesToRun.hasForcedToRunSuites

  isSuitesSkipped = jestSuitesToRun.suitesToRun.length !== originalTests.length
  numSkippedSuites = jestSuitesToRun.skippedSuites.length

  itrSkippedSuitesCh.publish({ skippedSuites: jestSuitesToRun.skippedSuites, frameworkVersion })

  return jestSuitesToRun.suitesToRun
}

addHook({
  name: 'jest-environment-node',
  versions: ['>=24.8.0']
}, getTestEnvironment)

addHook({
  name: 'jest-environment-jsdom',
  versions: ['>=24.8.0']
}, getTestEnvironment)

function getWrappedScheduleTests (scheduleTests, frameworkVersion) {
  // `scheduleTests` is an async function
  return function (tests) {
    if (!isSuitesSkippingEnabled || hasFilteredSkippableSuites) {
      return scheduleTests.apply(this, arguments)
    }
    const [test] = tests
    const rootDir = test?.context?.config?.rootDir

    arguments[0] = applySuiteSkipping(tests, rootDir, frameworkVersion)

    return scheduleTests.apply(this, arguments)
  }
}

function searchSourceWrapper (searchSourcePackage, frameworkVersion) {
  const SearchSource = searchSourcePackage.default ?? searchSourcePackage

  shimmer.wrap(SearchSource.prototype, 'getTestPaths', getTestPaths => async function () {
    const testPaths = await getTestPaths.apply(this, arguments)
    const [{ rootDir, shard }] = arguments

    if (isKnownTestsEnabled) {
      const projectSuites = testPaths.tests.map(test => getTestSuitePath(test.path, test.context.config.rootDir))
      const isFaulty =
        getIsFaultyEarlyFlakeDetection(projectSuites, knownTests?.jest || {}, earlyFlakeDetectionFaultyThreshold)
      if (isFaulty) {
        log.error('Early flake detection is disabled because the number of new suites is too high.')
        isEarlyFlakeDetectionEnabled = false
        isKnownTestsEnabled = false
        const testEnvironmentOptions = testPaths.tests[0]?.context?.config?.testEnvironmentOptions
        // Project config is shared among all tests, so we can modify it here
        if (testEnvironmentOptions) {
          testEnvironmentOptions._ddIsEarlyFlakeDetectionEnabled = false
          testEnvironmentOptions._ddIsKnownTestsEnabled = false
        }
        isEarlyFlakeDetectionFaulty = true
      }
    }

    if (shard?.shardCount > 1 || !isSuitesSkippingEnabled || !skippableSuites.length) {
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
          isCodeCoverageEnabled = libraryConfig.isCodeCoverageEnabled
          isSuitesSkippingEnabled = libraryConfig.isSuitesSkippingEnabled
          isEarlyFlakeDetectionEnabled = libraryConfig.isEarlyFlakeDetectionEnabled
          earlyFlakeDetectionNumRetries = libraryConfig.earlyFlakeDetectionNumRetries
          earlyFlakeDetectionFaultyThreshold = libraryConfig.earlyFlakeDetectionFaultyThreshold
          isKnownTestsEnabled = libraryConfig.isKnownTestsEnabled
          isTestManagementTestsEnabled = libraryConfig.isTestManagementEnabled
          testManagementAttemptToFixRetries = libraryConfig.testManagementAttemptToFixRetries
          isImpactedTestsEnabled = libraryConfig.isImpactedTestsEnabled
        }
      } catch (err) {
        log.error('Jest library configuration error', err)
      }

      if (isKnownTestsEnabled) {
        const knownTestsPromise = new Promise((resolve) => {
          onDone = resolve
        })

        knownTestsCh.publish({ onDone })

        try {
          const { err, knownTests: receivedKnownTests } = await knownTestsPromise
          if (err) {
            // We disable EFD if there has been an error in the known tests request
            isEarlyFlakeDetectionEnabled = false
            isKnownTestsEnabled = false
          } else {
            knownTests = receivedKnownTests
          }
        } catch (err) {
          log.error('Jest known tests error', err)
        }
      }

      if (isSuitesSkippingEnabled) {
        const skippableSuitesPromise = new Promise((resolve) => {
          onDone = resolve
        })

        skippableSuitesCh.publish({ onDone })

        try {
          const { err, skippableSuites: receivedSkippableSuites } = await skippableSuitesPromise
          if (!err) {
            skippableSuites = receivedSkippableSuites
          }
        } catch (err) {
          log.error('Jest test-suite skippable error', err)
        }
      }

      if (isTestManagementTestsEnabled) {
        const testManagementTestsPromise = new Promise((resolve) => {
          onDone = resolve
        })

        testManagementTestsCh.publish({ onDone })

        try {
          const { err, testManagementTests: receivedTestManagementTests } = await testManagementTestsPromise
          if (!err) {
            testManagementTests = receivedTestManagementTests
          }
        } catch (err) {
          log.error('Jest test management tests error', err)
        }
      }

      if (isImpactedTestsEnabled) {
        const impactedTestsPromise = new Promise((resolve) => {
          onDone = resolve
        })

        impactedTestsCh.publish({ onDone })

        try {
          const { err, modifiedTests: receivedModifiedTests } = await impactedTestsPromise
          if (!err) {
            modifiedTests = receivedModifiedTests
          }
        } catch (err) {
          log.error('Jest impacted tests error', err)
        }
      }

      const processArgv = process.argv.slice(2).join(' ')
      testSessionStartCh.publish({ command: `jest ${processArgv}`, frameworkVersion: jestVersion })

      const result = await runCLI.apply(this, arguments)

      const {
        results: {
          success,
          coverageMap,
          numFailedTestSuites,
          numFailedTests,
          numTotalTests,
          numTotalTestSuites
        }
      } = result

      let testCodeCoverageLinesTotal

      if (isUserCodeCoverageEnabled) {
        try {
          const { pct, total } = coverageMap.getCoverageSummary().lines
          testCodeCoverageLinesTotal = total === 0 ? 0 : pct
        } catch {
          // ignore errors
        }
      }
      let status, error

      if (success) {
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
        isSuitesSkipped,
        isSuitesSkippingEnabled,
        isCodeCoverageEnabled,
        testCodeCoverageLinesTotal,
        numSkippedSuites,
        hasUnskippableSuites,
        hasForcedToRunSuites,
        error,
        isEarlyFlakeDetectionEnabled,
        isEarlyFlakeDetectionFaulty,
        isTestManagementTestsEnabled,
        onDone
      })

      const waitingResult = await Promise.race([flushPromise, timeoutPromise])

      if (waitingResult === 'timeout') {
        log.error('Timeout waiting for the tracer to flush')
      }

      numSkippedSuites = 0

      /**
       * If Early Flake Detection (EFD) is enabled the logic is as follows:
       * - If all attempts for a test are failing, the test has failed and we will let the test process fail.
       * - If just a single attempt passes, we will prevent the test process from failing.
       * The rationale behind is the following: you may still be able to block your CI pipeline by gating
       * on flakiness (the test will be considered flaky), but you may choose to unblock the pipeline too.
       */

      if (isEarlyFlakeDetectionEnabled) {
        let numFailedTestsToIgnore = 0
        for (const testStatuses of newTestsTestStatuses.values()) {
          const { pass, fail } = getTestStats(testStatuses)
          if (pass > 0) { // as long as one passes, we'll consider the test passed
            numFailedTestsToIgnore += fail
          }
        }
        // If every test that failed was an EFD retry, we'll consider the suite passed
        if (numFailedTestsToIgnore !== 0 && result.results.numFailedTests === numFailedTestsToIgnore) {
          result.results.success = true
        }
      }

      if (isTestManagementTestsEnabled) {
        const failedTests = result
          .results
          .testResults.flatMap(({ testResults, testFilePath: testSuiteAbsolutePath }) => (
            testResults.map(({ fullName: testName, status }) => (
              { testName, testSuiteAbsolutePath, status }
            ))
          ))
          .filter(({ status }) => status === 'failed')

        let numFailedQuarantinedTests = 0
        let numFailedQuarantinedOrDisabledAttemptedToFixTests = 0

        for (const { testName, testSuiteAbsolutePath } of failedTests) {
          const testSuite = getTestSuitePath(testSuiteAbsolutePath, result.globalConfig.rootDir)
          const originalName = removeAttemptToFixStringFromTestName(testName)
          const testManagementTest = testManagementTests
            ?.jest
            ?.suites
            ?.[testSuite]
            ?.tests
            ?.[originalName]
            ?.properties
          // This uses `attempt_to_fix` because this is always the main process and it's not formatted in camelCase
          if (testManagementTest?.attempt_to_fix && (testManagementTest?.quarantined || testManagementTest?.disabled)) {
            numFailedQuarantinedOrDisabledAttemptedToFixTests++
          } else if (testManagementTest?.quarantined) {
            numFailedQuarantinedTests++
          }
        }

        // If every test that failed was quarantined, we'll consider the suite passed
        // Note that if a test is attempted to fix,
        // it's considered quarantined both if it's disabled and if it's quarantined
        // (it'll run but its status is ignored)
        if (
          (numFailedQuarantinedOrDisabledAttemptedToFixTests !== 0 || numFailedQuarantinedTests !== 0) &&
          result.results.numFailedTests ===
            numFailedQuarantinedTests + numFailedQuarantinedOrDisabledAttemptedToFixTests
        ) {
          result.results.success = true
        }
      }

      return result
    }, {
      replaceGetter: true
    })
  }
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
    // If the user has added coverage manually, they're willing to pay the price of this execution, so
    // we will not skip it.
    if (isSuitesSkippingEnabled && !isUserCodeCoverageEnabled) {
      return Promise.resolve()
    }
    return addUntestedFiles.apply(this, arguments)
  })

  return coverageReporter
}

addHook({
  name: '@jest/core',
  file: 'build/TestScheduler.js',
  versions: ['>=27.0.0']
}, (testSchedulerPackage, frameworkVersion) => {
  const oldCreateTestScheduler = testSchedulerPackage.createTestScheduler
  const newCreateTestScheduler = async function () {
    if (!isSuitesSkippingEnabled || hasFilteredSkippableSuites) {
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
  versions: ['>=24.8.0 <27.0.0']
}, (testSchedulerPackage, frameworkVersion) => {
  shimmer.wrap(
    testSchedulerPackage.default.prototype,
    'scheduleTests', scheduleTests => getWrappedScheduleTests(scheduleTests, frameworkVersion)
  )
  return testSchedulerPackage
})

addHook({
  name: '@jest/test-sequencer',
  versions: ['>=28']
}, (sequencerPackage, frameworkVersion) => {
  shimmer.wrap(sequencerPackage.default.prototype, 'shard', shard => function () {
    const shardedTests = shard.apply(this, arguments)

    if (!shardedTests.length || !isSuitesSkippingEnabled || !skippableSuites.length) {
      return shardedTests
    }
    const [test] = shardedTests
    const rootDir = test?.context?.config?.rootDir

    return applySuiteSkipping(shardedTests, rootDir, frameworkVersion)
  })
  return sequencerPackage
})

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
  name: '@jest/reporters',
  versions: ['>=30.0.0']
}, (reporters) => {
  return shimmer.wrap(reporters, 'CoverageReporter', coverageReporterWrapper, { replaceGetter: true })
})

addHook({
  name: '@jest/core',
  file: 'build/cli/index.js',
  versions: ['>=24.8.0 <30.0.0']
}, getCliWrapper(false))

addHook({
  name: '@jest/core',
  versions: ['>=30.0.0']
}, getCliWrapper(true))

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

        testSuiteCodeCoverageCh.publish({ coverageFiles, testSuite: environment.testSourceFile, mockedFiles })
      }
      testSuiteFinishCh.publish({ status, errorMessage })
      return suiteResults
    }).catch(error => {
      testSuiteFinishCh.publish({ status: 'fail', error })
      throw error
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
  file: 'build/runner.js',
  versions: ['>=30.0.0']
}, jestAdapterWrapper)

addHook({
  name: 'jest-circus',
  file: 'build/legacy-code-todo-rewrite/jestAdapter.js',
  versions: ['>=24.8.0']
}, jestAdapterWrapper)

function configureTestEnvironment (readConfigsResult) {
  const { configs } = readConfigsResult
  testSessionConfigurationCh.publish(configs.map(config => config.testEnvironmentOptions))
  // We can't directly use isCodeCoverageEnabled when reporting coverage in `jestAdapterWrapper`
  // because `jestAdapterWrapper` runs in a different process. We have to go through `testEnvironmentOptions`
  configs.forEach(config => {
    config.testEnvironmentOptions._ddTestCodeCoverageEnabled = isCodeCoverageEnabled
  })

  isUserCodeCoverageEnabled = !!readConfigsResult.globalConfig.collectCoverage

  if (readConfigsResult.globalConfig.forceExit) {
    log.warn("Jest's '--forceExit' flag has been passed. This may cause loss of data.")
  }

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

addHook({
  name: '@jest/transform',
  versions: ['>=24.8.0'],
  file: 'build/ScriptTransformer.js'
}, transformPackage => {
  const originalCreateScriptTransformer = transformPackage.createScriptTransformer

  // `createScriptTransformer` is an async function
  transformPackage.createScriptTransformer = function (config) {
    const { testEnvironmentOptions, ...restOfConfig } = config
    const {
      _ddTestModuleId,
      _ddTestSessionId,
      _ddTestCommand,
      _ddTestSessionName,
      _ddForcedToRun,
      _ddUnskippable,
      _ddItrCorrelationId,
      _ddKnownTests,
      _ddIsEarlyFlakeDetectionEnabled,
      _ddEarlyFlakeDetectionNumRetries,
      _ddRepositoryRoot,
      _ddIsFlakyTestRetriesEnabled,
      _ddFlakyTestRetriesCount,
      _ddIsDiEnabled,
      _ddIsKnownTestsEnabled,
      _ddIsTestManagementTestsEnabled,
      _ddTestManagementTests,
      _ddTestManagementAttemptToFixRetries,
      _ddModifiedTests,
      ...restOfTestEnvironmentOptions
    } = testEnvironmentOptions

    restOfConfig.testEnvironmentOptions = restOfTestEnvironmentOptions

    arguments[0] = restOfConfig

    return originalCreateScriptTransformer.apply(this, arguments)
  }

  return transformPackage
})

/**
 * Hook to remove the test paths (test suite) that are part of `skippableSuites`
 */
addHook({
  name: '@jest/core',
  versions: ['>=24.8.0 <30.0.0'],
  file: 'build/SearchSource.js'
}, searchSourceWrapper)

// from 25.1.0 on, readConfigs becomes async
addHook({
  name: 'jest-config',
  versions: ['>=25.1.0']
}, jestConfigAsyncWrapper)

addHook({
  name: 'jest-config',
  versions: ['24.8.0 - 24.9.0']
}, jestConfigSyncWrapper)

const LIBRARIES_BYPASSING_JEST_REQUIRE_ENGINE = new Set([
  'selenium-webdriver',
  'selenium-webdriver/chrome',
  'selenium-webdriver/edge',
  'selenium-webdriver/safari',
  'selenium-webdriver/firefox',
  'selenium-webdriver/ie',
  'selenium-webdriver/chromium',
  'winston'
])

function shouldBypassJestRequireEngine (moduleName) {
  return (
    LIBRARIES_BYPASSING_JEST_REQUIRE_ENGINE.has(moduleName)
  )
}

addHook({
  name: 'jest-runtime',
  versions: ['>=24.8.0']
}, (runtimePackage) => {
  const Runtime = runtimePackage.default ?? runtimePackage

  shimmer.wrap(Runtime.prototype, '_createJestObjectFor', _createJestObjectFor => function (from) {
    const result = _createJestObjectFor.apply(this, arguments)
    const suiteFilePath = this._testPath

    shimmer.wrap(result, 'mock', mock => function (moduleName) {
      if (suiteFilePath) {
        const existingMockedFiles = testSuiteMockedFiles.get(suiteFilePath) || []
        const suiteDir = path.dirname(suiteFilePath)
        const mockPath = path.resolve(suiteDir, moduleName)
        existingMockedFiles.push(mockPath)
        testSuiteMockedFiles.set(suiteFilePath, existingMockedFiles)
      }
      return mock.apply(this, arguments)
    })
    return result
  })

  shimmer.wrap(Runtime.prototype, 'requireModuleOrMock', requireModuleOrMock => function (from, moduleName) {
    // TODO: do this for every library that we instrument
    if (shouldBypassJestRequireEngine(moduleName)) {
      // To bypass jest's own require engine
      return this._requireCoreModule(moduleName)
    }
    return requireModuleOrMock.apply(this, arguments)
  })

  return runtimePackage
})

function onMessageWrapper (onMessage) {
  return function () {
    const [code, data] = arguments[0]
    if (code === JEST_WORKER_TRACE_PAYLOAD_CODE) { // datadog trace payload
      workerReportTraceCh.publish(data)
      return
    }
    if (code === JEST_WORKER_COVERAGE_PAYLOAD_CODE) { // datadog coverage payload
      workerReportCoverageCh.publish(data)
      return
    }
    if (code === JEST_WORKER_LOGS_PAYLOAD_CODE) { // datadog logs payload
      workerReportLogsCh.publish(data)
      return
    }
    return onMessage.apply(this, arguments)
  }
}

function sendWrapper (send) {
  return function (request) {
    if (!isKnownTestsEnabled && !isTestManagementTestsEnabled && !isImpactedTestsEnabled) {
      return send.apply(this, arguments)
    }
    const [type] = request

    // https://github.com/jestjs/jest/blob/1d682f21c7a35da4d3ab3a1436a357b980ebd0fa/packages/jest-worker/src/workers/ChildProcessWorker.ts#L424
    if (type === CHILD_MESSAGE_CALL) {
      // This is the message that the main process sends to the worker to run a test suite (=test file).
      // In here we modify the config.testEnvironmentOptions to include the known tests for the suite.
      // This way the suite only knows about the tests that are part of it.
      const args = request.at(-1)
      if (args.length > 1) {
        return send.apply(this, arguments)
      }
      if (!args[0]?.config) {
        return send.apply(this, arguments)
      }
      const [{ globalConfig, config, path: testSuiteAbsolutePath }] = args
      const testSuite = getTestSuitePath(testSuiteAbsolutePath, globalConfig.rootDir || process.cwd())
      const suiteKnownTests = knownTests?.jest?.[testSuite] || []

      const suiteTestManagementTests = testManagementTests?.jest?.suites?.[testSuite]?.tests || {}

      const suiteModifiedTests = Object.keys(modifiedTests).length > 0
        ? modifiedTests
        : {}

      args[0].config = {
        ...config,
        testEnvironmentOptions: {
          ...config.testEnvironmentOptions,
          _ddKnownTests: suiteKnownTests,
          _ddTestManagementTests: suiteTestManagementTests,
          _ddModifiedTests: suiteModifiedTests
        }
      }
    }
    return send.apply(this, arguments)
  }
}

function enqueueWrapper (enqueue) {
  return function () {
    shimmer.wrap(arguments[0], 'onStart', onStart => function (worker) {
      if (worker && !wrappedWorkers.has(worker)) {
        shimmer.wrap(worker._child, 'send', sendWrapper)
        shimmer.wrap(worker, '_onMessage', onMessageWrapper)
        worker._child.on('message', worker._onMessage.bind(worker))
        wrappedWorkers.add(worker)
      }
      return onStart.apply(this, arguments)
    })
    return enqueue.apply(this, arguments)
  }
}

/*
* This hook does three things:
* - Pass known tests to the workers.
* - Pass test management tests to the workers.
* - Receive trace, coverage and logs payloads from the workers.
*/
addHook({
  name: 'jest-worker',
  versions: ['>=24.9.0 <30.0.0'],
  file: 'build/workers/ChildProcessWorker.js'
}, (childProcessWorker) => {
  const ChildProcessWorker = childProcessWorker.default
  shimmer.wrap(ChildProcessWorker.prototype, 'send', sendWrapper)
  shimmer.wrap(ChildProcessWorker.prototype, '_onMessage', onMessageWrapper)
  return childProcessWorker
})

addHook({
  name: 'jest-worker',
  versions: ['>=30.0.0']
}, (jestWorkerPackage) => {
  shimmer.wrap(jestWorkerPackage.FifoQueue.prototype, 'enqueue', enqueueWrapper)
  shimmer.wrap(jestWorkerPackage.PriorityQueue.prototype, 'enqueue', enqueueWrapper)
  return jestWorkerPackage
})
