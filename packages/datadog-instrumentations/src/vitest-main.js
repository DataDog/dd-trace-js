'use strict'

const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { MessagePort } = require('node:worker_threads')

const satisfies = require('../../../vendor/dist/semifies')

const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')
const { EMPTY_EFD_RETRY_POLICY } = require('../../dd-trace/src/ci-visibility/efd-retry-policy')
const {
  VITEST_WORKER_TRACE_PAYLOAD_CODE,
  VITEST_WORKER_COVERAGE_PAYLOAD_CODE,
  VITEST_WORKER_LOGS_PAYLOAD_CODE,
  VITEST_WORKER_TELEMETRY_PAYLOAD_CODE,
  VITEST_WORKER_EFD_SUITE_ADMISSION_REQUEST_CODE,
  VITEST_WORKER_EFD_SUITE_ADMISSION_RESPONSE_CODE,
  collectTestOptimizationSummariesFromTraces,
  getIsFaultyEarlyFlakeDetection,
  logTestOptimizationSummary,
  TEST_IMPACT_ANALYSIS_ALL_TESTS_SKIPPED_MESSAGE,
  getTestOptimizationRequestResults,
  getTestSuitePath,
  isModifiedTest,
  isMarkedAsUnskippable,
  recordTestManagementExecution,
  recordAttemptToFixExecution,
} = require('../../dd-trace/src/plugins/util/test')
const { getChannelPromise } = require('./helpers/channel')
const { addHook, channel } = require('./helpers/instrument')
const noWorkerInit = require('./vitest-main-no-worker-init')
const {
  testStartCh,
  testPassCh,
  testErrorCh,
  testSkipCh,
  testSuiteStartCh,
  testSuiteFinishCh,
  testSuiteErrorCh,
  testSessionStartCh,
  testSessionFinishCh,
  testSessionConfigurationCh,
  libraryConfigurationCh,
  knownTestsCh,
  testManagementTestsCh,
  modifiedFilesCh,
  workerReportTraceCh,
  workerReportCoverageCh,
  workerReportLogsCh,
  workerReportTelemetryCh,
  codeCoverageReportCh,
  realpath,
  findExportByName,
  getTypeTasks,
  getWorkspaceProject,
  parseProvidedContextValue,
  setProvidedContext,
  getVitestTestProperties,
} = require('./vitest-util')

const newTestsWithDynamicNames = new Set()
const attemptToFixExecutions = new Map()
const workerProcesses = new WeakSet()
const mainProcessSetupStates = new WeakMap()
const coverageWrappedProviders = new WeakSet()
const finishWrappedContexts = new WeakSet()
const runFilesWrappedPrototypes = new WeakSet()
const activeRunFilesContexts = new WeakSet()
const runErrorsByContext = new WeakMap()
const typecheckPoolWorkerRequests = new WeakMap()
let isFlakyTestRetriesEnabled = false
let flakyTestRetriesCount = 0
let isEarlyFlakeDetectionEnabled = false
let earlyFlakeDetectionRetryPolicy = EMPTY_EFD_RETRY_POLICY
let earlyFlakeDetectionFaultyThreshold = 0
let isEarlyFlakeDetectionFaulty = false
let isKnownTestsEnabled = false
let isTestManagementTestsEnabled = false
let isImpactedTestsEnabled = false
let isCodeCoverageEnabled = false
let isSuitesSkippingEnabled = false
let isSessionCodeCoverageEnabled = false
let isSessionSuitesSkippingEnabled = false
let testManagementAttemptToFixRetries = 0
let isDiEnabled = false
let testCodeCoverageLinesTotal
let coverageRootDir
let requestErrorTags = {}
let isSessionStarted = false
let isTestImpactAnalysisDisabled = false
let isVitestNoWorkerInitActive = false
let isVitestBrowserModeActive = false
let vitestPool = null
let isMessagePortWrapped = false
let skippableSuites = []
let skippedSuites = []
let unskippableSuites = {}
let forcedToRunSuites = {}
let hasUnskippableSuites = false
let hasForcedToRunSuites = false
let areAllSuitesSkipped = false
let hasLoggedAllTestsSkippedMessage = false
let hasRunnableSuites = false
let hasSelectedSuites = false
let itrCorrelationId
let tiaRepositoryRoot = process.cwd()
let activeNoWorkerInitState
let isEfdSuiteAdmissionEnabled = false
let maximumSuitesWithNewTests = 0
const suitesWithNewTests = new Set()
const tinyPoolClassWrappers = new WeakMap()
const itrSkippedSuitesCh = channel('ci:vitest:itr:skipped-suites')
const skippableSuitesCh = channel('ci:vitest:test-suite:skippable')

function getTestCommand () {
  return `vitest ${process.argv.slice(2).join(' ')}`
}

function isValidKnownTests (receivedKnownTests) {
  return !!receivedKnownTests.vitest
}

function isReporterPackage (vitestPackage) {
  return vitestPackage.B?.name === 'BaseSequencer'
}

function isReporterPackageNew (vitestPackage) {
  return vitestPackage.e?.name === 'BaseSequencer'
}

function isReporterPackageNewest (vitestPackage) {
  return vitestPackage.h?.name === 'BaseSequencer'
}

function getBaseSequencerExport (vitestPackage) {
  return findExportByName(vitestPackage, 'BaseSequencer')
}

function isCliApiPackage (vitestPackage) {
  return !!findExportByName(vitestPackage, 'startVitest')
}

function getVitestExport (vitestPackage) {
  return findExportByName(vitestPackage, 'Vitest')
}

function getTypecheckerExport (vitestPackage) {
  return findExportByName(vitestPackage, 'Typechecker')
}

function getTypecheckPoolWorkerExport (vitestPackage) {
  return findExportByName(vitestPackage, 'TypecheckPoolWorker')
}

function getForksPoolWorkerExport (vitestPackage) {
  return findExportByName(vitestPackage, 'ForksPoolWorker')
}

function getThreadsPoolWorkerExport (vitestPackage) {
  return findExportByName(vitestPackage, 'ThreadsPoolWorker')
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

function getTestFilepathsFromSpecifications (testSpecifications) {
  if (!Array.isArray(testSpecifications) || !testSpecifications.length) {
    return
  }

  return testSpecifications.map(testSpecification => {
    const testFile = Array.isArray(testSpecification) ? testSpecification[1] : testSpecification
    return testFile?.moduleId || testFile?.filepath || testFile
  })
}

function getTestSpecificationsKey (testSpecifications) {
  if (!Array.isArray(testSpecifications) || !testSpecifications.length) return

  const keyParts = []
  for (const testSpecification of testSpecifications) {
    const testFile = Array.isArray(testSpecification) ? testSpecification[1] : testSpecification
    const testFilepath = testFile?.moduleId || testFile?.filepath || testFile
    if (!testFilepath) continue

    const projectName = getProjectName(getTestSpecificationProject(testSpecification)) || ''
    const pool = getTestSpecificationPool(testSpecification) || ''
    keyParts.push(`${projectName}\0${pool}\0${testFilepath}`)
  }

  if (!keyParts.length) return

  keyParts.sort()
  return keyParts.join('\0')
}

function getTestFilepaths (ctx, testSpecifications) {
  const testFilepaths = getTestFilepathsFromSpecifications(testSpecifications)
  if (testFilepaths) {
    return testFilepaths
  }

  const getFilePaths = ctx.getTestFilepaths || ctx._globTestFilepaths
  return getFilePaths.call(ctx)
}

/**
 * @typedef {{
 *   isAttemptToFix?: boolean,
 *   isDisabled?: boolean,
 *   isQuarantined?: boolean
 * }} VitestTestManagementProperties
 *
 * @typedef {{
 *   testSuite?: string,
 *   knownTests?: string[],
 *   testManagementTests?: Record<string, VitestTestManagementProperties>,
 *   isModified?: boolean
 * }} VitestTestProperties
 */

/**
 * Normalize a Vitest test file path to the test suite path used by Test Optimization APIs.
 *
 * @param {string} testFilepath
 * @param {string} repositoryRoot
 * @returns {string}
 */
function getNormalizedTestSuitePath (testFilepath, repositoryRoot) {
  const testSuiteAbsolutePath = path.isAbsolute(testFilepath) ? testFilepath : path.join(repositoryRoot, testFilepath)
  return getTestSuitePath(realpath(testSuiteAbsolutePath), realpath(repositoryRoot))
}

/**
 * Resets suite-level EFD admission state between Vitest runs.
 *
 * @returns {void}
 */
function resetEfdSuiteTracker () {
  activeNoWorkerInitState = undefined
  isEfdSuiteAdmissionEnabled = false
  maximumSuitesWithNewTests = 0
  suitesWithNewTests.clear()
}

/**
 * Returns whether a Vitest pool has a transport for runtime EFD suite admission.
 *
 * @param {string|undefined} pool
 * @returns {boolean}
 */
function isEfdSuiteAdmissionPool (pool) {
  return pool === undefined || pool === 'forks' || pool === 'threads' || pool === 'browser'
}

/**
 * Returns whether Vitest exposes the worker transports used for runtime EFD suite admission.
 *
 * @param {string} frameworkVersion
 * @param {object[]|undefined} testSpecifications
 * @param {object} ctx
 * @returns {boolean}
 */
function supportsEfdSuiteAdmission (frameworkVersion, testSpecifications, ctx) {
  if (!satisfies(frameworkVersion, '>=4.0.0')) return false
  const defaultPool = ctx?.config?.pool
  if (!Array.isArray(testSpecifications) || testSpecifications.length === 0) {
    return isEfdSuiteAdmissionPool(defaultPool)
  }

  for (const testSpecification of testSpecifications) {
    const pool = getTestSpecificationPool(testSpecification) || defaultPool
    if (!isEfdSuiteAdmissionPool(pool)) return false
  }
  return true
}

/**
 * Configures the EFD threshold against the unique suites selected by Vitest.
 *
 * @param {string[]} testFilepaths
 * @param {string} repositoryRoot
 * @returns {void}
 */
function configureEfdSuiteTracker (testFilepaths, repositoryRoot) {
  const testSuites = new Set()
  for (const testFilepath of testFilepaths) {
    testSuites.add(getNormalizedTestSuitePath(testFilepath, repositoryRoot))
  }

  maximumSuitesWithNewTests = Math.floor(Math.max(
    earlyFlakeDetectionFaultyThreshold,
    testSuites.size * earlyFlakeDetectionFaultyThreshold / 100
  ))
  isEfdSuiteAdmissionEnabled = true
}

/**
 * Returns whether a suite may schedule EFD retries and records runnable suites with new tests.
 *
 * @param {string} testSuite
 * @param {boolean} hasNewTest
 * @returns {boolean}
 */
function reserveEarlyFlakeDetectionSuite (testSuite, hasNewTest) {
  if (!isEfdSuiteAdmissionEnabled || typeof testSuite !== 'string') return false
  if (isEarlyFlakeDetectionFaulty) return false

  if (hasNewTest) {
    suitesWithNewTests.add(testSuite)
    if (suitesWithNewTests.size > maximumSuitesWithNewTests) {
      isEarlyFlakeDetectionEnabled = false
      isEarlyFlakeDetectionFaulty = true
      if (activeNoWorkerInitState) {
        activeNoWorkerInitState.isEarlyFlakeDetectionEnabled = false
        activeNoWorkerInitState.isEarlyFlakeDetectionFaulty = true
      }
      log.warn(
        'Early Flake Detection retries are disabled because the number of suites with new tests is too high.'
      )
      return false
    }
  }

  return true
}

function resetSuiteSkippingRunState () {
  skippableSuites = []
  resetAppliedSuiteSkippingState()
  itrCorrelationId = undefined
}

function resetAppliedSuiteSkippingState () {
  unskippableSuites = {}
  forcedToRunSuites = {}
}

function resetSessionSuiteSkippingState () {
  skippedSuites = []
  hasUnskippableSuites = false
  hasForcedToRunSuites = false
  areAllSuitesSkipped = false
  hasLoggedAllTestsSkippedMessage = false
  hasRunnableSuites = false
  hasSelectedSuites = false
  isSessionCodeCoverageEnabled = false
  isSessionSuitesSkippingEnabled = false
  isTestImpactAnalysisDisabled = false
}

/**
 * Returns the file path from Vitest's version-dependent test specification shape.
 *
 * @param {unknown} testSpecification
 * @returns {string|undefined}
 */
function getTestSpecificationFilepath (testSpecification) {
  const testFile = Array.isArray(testSpecification) ? testSpecification[1] : testSpecification
  return testFile?.moduleId || testFile?.filepath || (typeof testFile === 'string' ? testFile : undefined)
}

/**
 * Returns the normalized suite path and absolute path for a Vitest test specification.
 *
 * @param {unknown} testSpecification
 * @returns {{ testSuite: string, testSuiteAbsolutePath: string }|undefined}
 */
function getTestSpecificationSuite (testSpecification) {
  const testFilepath = getTestSpecificationFilepath(testSpecification)
  if (!testFilepath) return

  const testSuiteAbsolutePath = path.isAbsolute(testFilepath)
    ? realpath(testFilepath)
    : realpath(path.join(tiaRepositoryRoot, testFilepath))

  return {
    testSuite: getTestSuitePath(testSuiteAbsolutePath, tiaRepositoryRoot),
    testSuiteAbsolutePath,
  }
}

/**
 * Returns suites that Vitest selected for typechecking.
 *
 * @param {unknown[]} testSpecifications
 * @returns {Set<string>}
 */
function getTypecheckTestSuites (testSpecifications) {
  const typecheckTestSuites = new Set()

  for (const testSpecification of testSpecifications) {
    if (getTestSpecificationPool(testSpecification) !== 'typescript') continue

    const testSuite = getTestSpecificationSuite(testSpecification)?.testSuite
    if (testSuite) {
      typecheckTestSuites.add(testSuite)
    }
  }

  return typecheckTestSuites
}

/**
 * Removes suites selected by TIA and propagates suite metadata to Vitest workers.
 *
 * @param {object} ctx
 * @param {unknown[]} testSpecifications
 * @param {string} frameworkVersion
 * @returns {unknown[]}
 */
function applySuiteSkipping (ctx, testSpecifications, frameworkVersion) {
  if (!Array.isArray(testSpecifications)) {
    setProvidedContext(ctx, {
      _ddIsCodeCoverageEnabled: isCodeCoverageEnabled,
    }, 'Could not send TIA configuration to workers.')
    return testSpecifications
  }

  if (testSpecifications.length > 0) {
    hasSelectedSuites = true
  }
  if (!isSuitesSkippingEnabled) {
    if (testSpecifications.length > 0) {
      hasRunnableSuites = true
    }
    areAllSuitesSkipped = hasSelectedSuites && !hasRunnableSuites
    setProvidedContext(ctx, {
      _ddIsCodeCoverageEnabled: isCodeCoverageEnabled,
    }, 'Could not send TIA configuration to workers.')
    return testSpecifications
  }

  resetAppliedSuiteSkippingState()
  const skippableSuiteSet = new Set(skippableSuites.map(testSuite => testSuite.replaceAll('\\', '/')))
  const typecheckTestSuites = getTypecheckTestSuites(testSpecifications)
  const currentSkippedSuites = []
  const testSpecificationsToRun = []

  for (const testSpecification of testSpecifications) {
    const testSpecificationSuite = getTestSpecificationSuite(testSpecification)
    if (!testSpecificationSuite) {
      testSpecificationsToRun.push(testSpecification)
      continue
    }

    const { testSuite, testSuiteAbsolutePath } = testSpecificationSuite
    const shouldSkip = !typecheckTestSuites.has(testSuite) && skippableSuiteSet.has(testSuite)
    const isUnskippable = isMarkedAsUnskippable({ path: testSuiteAbsolutePath })

    if (isUnskippable) {
      unskippableSuites[testSuite] = true
      hasUnskippableSuites = true
      if (shouldSkip) {
        forcedToRunSuites[testSuite] = true
        hasForcedToRunSuites = true
      }
    }

    if (shouldSkip && !isUnskippable) {
      skippedSuites.push(testSuite)
      currentSkippedSuites.push(testSuite)
    } else {
      testSpecificationsToRun.push(testSpecification)
    }
  }

  setProvidedContext(ctx, {
    _ddIsCodeCoverageEnabled: isCodeCoverageEnabled,
    _ddItrCorrelationId: itrCorrelationId,
    _ddUnskippableSuites: unskippableSuites,
    _ddForcedToRunSuites: forcedToRunSuites,
  }, 'Could not send TIA configuration to workers.')

  if (currentSkippedSuites.length) {
    itrSkippedSuitesCh.publish({ skippedSuites: currentSkippedSuites, frameworkVersion })
  }
  if (testSpecificationsToRun.length > 0) {
    hasRunnableSuites = true
  }
  areAllSuitesSkipped = hasSelectedSuites && !hasRunnableSuites
  if (testSpecifications.length > 0 && testSpecificationsToRun.length === 0) {
    const config = safeConfig(ctx)
    if (config) {
      config.passWithNoTests = true
    }
  }

  return testSpecificationsToRun
}

/**
 * Build simplified Test Management metadata grouped by normalized test suite path.
 *
 * @param {{ vitest?: { suites?: Record<string, { tests?: Record<string, { properties?: {
 *   attempt_to_fix?: boolean,
 *   disabled?: boolean,
 *   quarantined?: boolean
 * } }> }> } }} testManagementTests
 * @returns {Record<string, Record<string, VitestTestManagementProperties>>}
 */
function getTestManagementTestsBySuite (testManagementTests) {
  const testManagementTestsBySuite = {}
  const suites = testManagementTests?.vitest?.suites
  if (!suites) return testManagementTestsBySuite

  for (const [testSuite, suite] of Object.entries(suites)) {
    const tests = suite?.tests
    if (!tests) continue

    const testsByName = {}
    let hasTests = false
    for (const [testName, test] of Object.entries(tests)) {
      const properties = test?.properties
      const testProperties = {
        isAttemptToFix: properties?.attempt_to_fix,
        isDisabled: properties?.disabled,
        isQuarantined: properties?.quarantined,
      }
      testsByName[testName] = testProperties
      hasTests = true
    }
    if (hasTests) {
      testManagementTestsBySuite[testSuite] = testsByName
    }
  }

  return testManagementTestsBySuite
}

/**
 * Build a set-like object for test suites modified in the current pull request diff.
 *
 * @param {Record<string, number[]>|undefined} modifiedFiles
 * @returns {Record<string, boolean>}
 */
function getImpactedTestSuites (modifiedFiles) {
  const impactedTestSuites = {}
  if (!modifiedFiles) return impactedTestSuites

  for (const testSuite of Object.keys(modifiedFiles)) {
    if (isModifiedTest(testSuite, 0, 0, modifiedFiles, 'vitest')) {
      impactedTestSuites[testSuite] = true
    }
  }

  return impactedTestSuites
}

/**
 * Build the worker-ready test metadata map keyed by Vitest's absolute filepath.
 *
 * @param {string[]} testFilepaths
 * @param {string} repositoryRoot
 * @param {Record<string, string[]>|undefined} knownTestsBySuite
 * @param {Record<string, Record<string, VitestTestManagementProperties>>|undefined} testManagementTestsBySuite
 * @param {Record<string, boolean>|undefined} impactedTestSuites
 * @returns {Record<string, VitestTestProperties>}
 */
function getTestPropertiesByFilepath (
  testFilepaths,
  repositoryRoot,
  knownTestsBySuite,
  testManagementTestsBySuite,
  impactedTestSuites
) {
  const testPropertiesByFilepath = {}
  if (!Array.isArray(testFilepaths)) return testPropertiesByFilepath

  for (const testFilepath of testFilepaths) {
    if (typeof testFilepath !== 'string') continue

    const testSuiteAbsolutePath = path.isAbsolute(testFilepath)
      ? testFilepath
      : path.join(repositoryRoot, testFilepath)
    const realTestFilepath = realpath(testSuiteAbsolutePath)
    const testSuite = getNormalizedTestSuitePath(testFilepath, repositoryRoot)
    const testProperties = { testSuite }
    const hasProperties = knownTestsBySuite !== undefined ||
      testManagementTestsBySuite !== undefined ||
      impactedTestSuites !== undefined

    if (knownTestsBySuite) {
      testProperties.knownTests = knownTestsBySuite[testSuite] || []
    }
    if (testManagementTestsBySuite) {
      testProperties.testManagementTests = testManagementTestsBySuite[testSuite] || {}
    }
    if (impactedTestSuites?.[testSuite]) {
      testProperties.isModified = true
    }

    if (hasProperties) {
      testPropertiesByFilepath[testFilepath] = testProperties
      testPropertiesByFilepath[testSuiteAbsolutePath] = testProperties
      testPropertiesByFilepath[realTestFilepath] = testProperties
    }
  }

  return testPropertiesByFilepath
}

function wrapCoverageProvider (ctx) {
  const { coverageProvider } = ctx
  if (!coverageProvider?.generateCoverage || coverageWrappedProviders.has(coverageProvider)) {
    return
  }
  coverageWrappedProviders.add(coverageProvider)

  // Capture coverage root directory from config (default is 'coverage' in cwd)
  try {
    const coverageConfig = ctx.config?.coverage
    const reportsDirectory = coverageConfig?.reportsDirectory || 'coverage'
    const rootDir = ctx.config?.root || process.cwd()
    coverageRootDir = path.isAbsolute(reportsDirectory) ? reportsDirectory : path.join(rootDir, reportsDirectory)
  } catch {
    // Fallback to cwd if we can't get config
    coverageRootDir = process.cwd()
  }

  shimmer.wrap(coverageProvider, 'generateCoverage', generateCoverage => async function () {
    const totalCodeCoverage = await generateCoverage.apply(this, arguments)

    try {
      testCodeCoverageLinesTotal = totalCodeCoverage.getCoverageSummary().lines.pct
    } catch {
      // ignore errors
    }
    return totalCodeCoverage
  })
}

function wrapSessionFinish (ctx) {
  if (finishWrappedContexts.has(ctx)) {
    return
  }
  finishWrappedContexts.add(ctx)

  shimmer.wrap(ctx, 'exit', getFinishWrapper)
  shimmer.wrap(ctx, 'close', getFinishWrapper)
}

function resetLibraryConfig () {
  isFlakyTestRetriesEnabled = false
  flakyTestRetriesCount = 0
  isEarlyFlakeDetectionEnabled = false
  earlyFlakeDetectionRetryPolicy = EMPTY_EFD_RETRY_POLICY
  earlyFlakeDetectionFaultyThreshold = 0
  isEarlyFlakeDetectionFaulty = false
  isDiEnabled = false
  isKnownTestsEnabled = false
  isTestManagementTestsEnabled = false
  isImpactedTestsEnabled = false
  isCodeCoverageEnabled = false
  isSuitesSkippingEnabled = false
  testManagementAttemptToFixRetries = 0
}

function applyLibraryConfig (libraryConfig) {
  isFlakyTestRetriesEnabled = libraryConfig.isFlakyTestRetriesEnabled
  flakyTestRetriesCount = libraryConfig.flakyTestRetriesCount
  isEarlyFlakeDetectionEnabled = libraryConfig.isEarlyFlakeDetectionEnabled
  earlyFlakeDetectionRetryPolicy = libraryConfig.earlyFlakeDetectionRetryPolicy ?? EMPTY_EFD_RETRY_POLICY
  earlyFlakeDetectionFaultyThreshold = libraryConfig.earlyFlakeDetectionFaultyThreshold ?? 0
  isEarlyFlakeDetectionFaulty = false
  isDiEnabled = libraryConfig.isDiEnabled
  isKnownTestsEnabled = libraryConfig.isKnownTestsEnabled
  isTestManagementTestsEnabled = libraryConfig.isTestManagementEnabled
  testManagementAttemptToFixRetries = libraryConfig.testManagementAttemptToFixRetries
  isImpactedTestsEnabled = libraryConfig.isImpactedTestsEnabled
  isCodeCoverageEnabled = libraryConfig.isItrEnabled && libraryConfig.isCodeCoverageEnabled
  isSuitesSkippingEnabled = libraryConfig.isItrEnabled && libraryConfig.isSuitesSkippingEnabled
}

function resetMainProcessProvidedContext (ctx) {
  setProvidedContext(ctx, {
    _ddIsDiEnabled: false,
    _ddIsEarlyFlakeDetectionEnabled: false,
    _ddEarlyFlakeDetectionRetryPolicy: EMPTY_EFD_RETRY_POLICY,
    _ddIsEfdSuiteAdmissionEnabled: false,
    _ddIsFlakyTestRetriesEnabled: false,
    _ddFlakyTestRetriesCount: 0,
    _ddFlakyTestRetriesIncludesUnnamedProject: false,
    _ddFlakyTestRetriesProjectNames: undefined,
    _ddIsImpactedTestsEnabled: false,
    _ddIsKnownTestsEnabled: false,
    _ddIsTestManagementTestsEnabled: false,
    _ddTestManagementAttemptToFixRetries: 0,
    _ddTestPropertiesByFilepath: {},
    _ddIsCodeCoverageEnabled: false,
    _ddItrCorrelationId: undefined,
    _ddUnskippableSuites: {},
    _ddForcedToRunSuites: {},
  }, 'Could not reset Test Optimization context for workers.')
}

/**
 * Merges request error tags from a Test Optimization request response into the tags propagated by no-worker mode.
 *
 * @param {{ requestErrorTags?: Record<string, string> }|undefined} requestResponse - Request response.
 */
function mergeRequestErrorTags (requestResponse) {
  if (requestResponse?.requestErrorTags) {
    requestErrorTags = {
      ...requestErrorTags,
      ...requestResponse.requestErrorTags,
    }
  }
}

async function runMainProcessSetup (
  ctx,
  frameworkVersion,
  testSpecifications,
  shouldInstallNoWorkerInit,
  shouldInstallBrowserReporter,
  disableTestImpactAnalysis
) {
  if (!testSessionFinishCh.hasSubscribers) {
    return
  }

  resetSuiteSkippingRunState()
  resetEfdSuiteTracker()
  isVitestBrowserModeActive ||= shouldInstallBrowserReporter
  isTestImpactAnalysisDisabled =
    disableTestImpactAnalysis || shouldInstallNoWorkerInit || isVitestBrowserModeActive
  let repositoryRoot = process.cwd()
  let testSessionConfiguration
  let testFilepaths
  let shouldSendTestProperties = false
  let testPropertiesByFilepath
  let knownTests
  let knownTestsBySuite
  let testManagementTests
  let testManagementTestsBySuite
  let modifiedFiles
  let impactedTestSuites
  const getCurrentTestFilepaths = async () => {
    if (testFilepaths === undefined) {
      testFilepaths = await getTestFilepaths(ctx, testSpecifications)
    }
    return testFilepaths
  }

  try {
    const {
      err,
      libraryConfig,
      requestErrorTags: receivedRequestErrorTags = {},
    } = await getChannelPromise(libraryConfigurationCh, {
      frameworkVersion,
      disableTestImpactAnalysis: isTestImpactAnalysisDisabled,
      isVitestNoWorkerInitActive: shouldInstallNoWorkerInit || isVitestBrowserModeActive,
    })
    requestErrorTags = receivedRequestErrorTags
    if (err) {
      resetLibraryConfig()
    } else {
      applyLibraryConfig(libraryConfig)
    }
  } catch {
    requestErrorTags = {}
    resetLibraryConfig()
  }
  isSessionCodeCoverageEnabled ||= isCodeCoverageEnabled
  isSessionSuitesSkippingEnabled ||= isSuitesSkippingEnabled

  resetMainProcessProvidedContext(ctx)

  if (testSessionConfigurationCh.hasSubscribers) {
    testSessionConfiguration = await getChannelPromise(testSessionConfigurationCh, { frameworkVersion }) || {}
    const {
      testSessionId,
      testModuleId,
      testCommand,
      repositoryRoot: receivedRepositoryRoot,
      codeOwnersEntries,
    } = testSessionConfiguration
    repositoryRoot = realpath(receivedRepositoryRoot || repositoryRoot)
    testSessionConfiguration = {
      ...testSessionConfiguration,
      repositoryRoot,
    }
    if (!shouldInstallNoWorkerInit) {
      setProvidedContext(ctx, {
        _ddTestSessionId: testSessionId,
        _ddTestModuleId: testModuleId,
        _ddTestCommand: testCommand,
        _ddRepositoryRoot: repositoryRoot,
        _ddCodeOwnersEntries: codeOwnersEntries,
      }, 'Could not send test session configuration to workers.')
    }
  }
  tiaRepositoryRoot = realpath(repositoryRoot)

  const {
    knownTestsResponse,
    skippableSuitesResponse,
    testManagementTestsResponse,
  } = await getTestOptimizationRequestResults({
    isKnownTestsEnabled,
    isSuitesSkippingEnabled,
    isTestManagementTestsEnabled,
    getKnownTests: () => getChannelPromise(knownTestsCh),
    getSkippableSuites: () => getChannelPromise(skippableSuitesCh),
    getTestManagementTests: () => getChannelPromise(testManagementTestsCh),
  })
  mergeRequestErrorTags(knownTestsResponse)
  mergeRequestErrorTags(skippableSuitesResponse)
  mergeRequestErrorTags(testManagementTestsResponse)

  if (isSuitesSkippingEnabled) {
    const currentSkippableSuitesResponse = skippableSuitesResponse ||
      await getChannelPromise(skippableSuitesCh)
    if (!currentSkippableSuitesResponse?.err) {
      skippableSuites = currentSkippableSuitesResponse.skippableSuites || []
      itrCorrelationId = currentSkippableSuitesResponse.itrCorrelationId
    }
  }

  const flakyTestRetriesConfiguration = configureFlakyTestRetries(ctx, testSpecifications)
  if (flakyTestRetriesConfiguration) {
    setProvidedContext(ctx, {
      _ddIsFlakyTestRetriesEnabled: isFlakyTestRetriesEnabled,
      _ddFlakyTestRetriesCount: flakyTestRetriesCount,
      _ddFlakyTestRetriesIncludesUnnamedProject: flakyTestRetriesConfiguration.includesUnnamedProject,
      _ddFlakyTestRetriesProjectNames: flakyTestRetriesConfiguration.projectNames,
    }, 'Could not send library configuration to workers.')
  }

  if (isKnownTestsEnabled) {
    const currentKnownTestsResponse = knownTestsResponse || await getChannelPromise(knownTestsCh)
    if (!currentKnownTestsResponse || currentKnownTestsResponse.err) {
      isEarlyFlakeDetectionEnabled = false
    } else {
      knownTests = currentKnownTestsResponse.knownTests
      const currentTestFilepaths = await getCurrentTestFilepaths()

      if (isValidKnownTests(knownTests)) {
        if (!shouldInstallNoWorkerInit && supportsEfdSuiteAdmission(frameworkVersion, testSpecifications, ctx)) {
          configureEfdSuiteTracker(currentTestFilepaths, repositoryRoot)
        } else {
          const projectSuites = currentTestFilepaths.map(testFilepath => getTestSuitePath(testFilepath, repositoryRoot))
          isEarlyFlakeDetectionFaulty = getIsFaultyEarlyFlakeDetection(
            projectSuites,
            knownTests.vitest,
            earlyFlakeDetectionFaultyThreshold
          )
          if (isEarlyFlakeDetectionFaulty) {
            isEarlyFlakeDetectionEnabled = false
            log.warn('New test detection is disabled because the number of new tests is too high.')
          }
        }

        if (!isEarlyFlakeDetectionFaulty) {
          knownTestsBySuite = knownTests.vitest
          shouldSendTestProperties = true
          if (!shouldInstallNoWorkerInit) {
            setProvidedContext(ctx, {
              _ddIsEfdSuiteAdmissionEnabled: isEfdSuiteAdmissionEnabled,
              _ddIsKnownTestsEnabled: isKnownTestsEnabled,
              _ddIsEarlyFlakeDetectionEnabled: isEarlyFlakeDetectionEnabled,
              _ddEarlyFlakeDetectionRetryPolicy: earlyFlakeDetectionRetryPolicy,
            }, 'Could not send known tests to workers so Early Flake Detection will not work.')
          }
        }
      } else {
        isEarlyFlakeDetectionFaulty = true
        isEarlyFlakeDetectionEnabled = false
      }
    }
  }

  if (!shouldInstallNoWorkerInit && isDiEnabled) {
    setProvidedContext(ctx, {
      _ddIsDiEnabled: isDiEnabled,
    }, 'Could not send Dynamic Instrumentation configuration to workers.')
  }

  if (isTestManagementTestsEnabled) {
    const testManagementResponse =
      testManagementTestsResponse || await getChannelPromise(testManagementTestsCh)
    if (!testManagementResponse || testManagementResponse.err) {
      isTestManagementTestsEnabled = false
      log.error('Could not get test management tests.')
    } else {
      const { testManagementTests: receivedTestManagementTests } = testManagementResponse
      testManagementTests = receivedTestManagementTests
      testManagementTestsBySuite = getTestManagementTestsBySuite(receivedTestManagementTests)
      shouldSendTestProperties = true
      if (!shouldInstallNoWorkerInit) {
        setProvidedContext(ctx, {
          _ddIsTestManagementTestsEnabled: isTestManagementTestsEnabled,
          _ddTestManagementAttemptToFixRetries: testManagementAttemptToFixRetries,
        }, 'Could not send test management tests to workers so Test Management will not work.')
      }
    }
  }

  if (isImpactedTestsEnabled) {
    const modifiedFilesResponse = await getChannelPromise(modifiedFilesCh)
    if (!modifiedFilesResponse || modifiedFilesResponse.err) {
      log.error('Could not get modified tests.')
    } else {
      modifiedFiles = modifiedFilesResponse.modifiedFiles
      impactedTestSuites = getImpactedTestSuites(modifiedFiles)
      shouldSendTestProperties = true
      if (!shouldInstallNoWorkerInit) {
        setProvidedContext(ctx, {
          _ddIsImpactedTestsEnabled: isImpactedTestsEnabled,
        }, 'Could not send modified tests to workers so Impacted Tests will not work.')
      }
    }
  }

  if (shouldSendTestProperties) {
    testPropertiesByFilepath = getTestPropertiesByFilepath(
      await getCurrentTestFilepaths(),
      repositoryRoot,
      knownTestsBySuite,
      testManagementTestsBySuite,
      impactedTestSuites
    )
    if (!shouldInstallNoWorkerInit) {
      setProvidedContext(ctx, {
        _ddTestPropertiesByFilepath: testPropertiesByFilepath,
      }, 'Could not send test properties to workers so some Test Optimization features will not work.')
    }
  }

  if (shouldInstallNoWorkerInit || shouldInstallBrowserReporter) {
    const reporterTestSpecifications = shouldInstallNoWorkerInit
      ? testSpecifications
      : getBrowserTestSpecifications(testSpecifications)
    activeNoWorkerInitState = getNoWorkerInitState()
    noWorkerInit.configure(ctx, frameworkVersion, reporterTestSpecifications, {
      knownTests,
      knownTestsBySuite,
      modifiedFiles,
      repositoryRoot,
      flakyTestRetriesConfiguration,
      testManagementTests,
      testManagementTestsBySuite,
      testPropertiesByFilepath: testPropertiesByFilepath || {},
      testSessionConfiguration,
    }, {
      reserveEarlyFlakeDetectionSuite,
      shouldReportTestModule: shouldInstallBrowserReporter ? isBrowserTestModule : undefined,
      state: activeNoWorkerInitState,
    })
  }

  wrapCoverageProvider(ctx)
  wrapSessionFinish(ctx)
  return shouldInstallNoWorkerInit
}

function getNoWorkerInitState () {
  return {
    attemptToFixExecutions,
    earlyFlakeDetectionRetryPolicy,
    isEfdSuiteAdmissionEnabled,
    isEarlyFlakeDetectionEnabled,
    isEarlyFlakeDetectionFaulty,
    isFlakyTestRetriesEnabled,
    isKnownTestsEnabled,
    newTestsWithDynamicNames,
    requestErrorTags,
    testManagementAttemptToFixRetries,
  }
}

function ensureMainProcessSetup (
  ctx,
  frameworkVersion,
  testSpecifications,
  shouldDeactivateOnFallback = false,
  forceDisableTestImpactAnalysis = false
) {
  const shouldInstallNoWorkerInit = shouldUseNoWorkerInit(ctx, frameworkVersion, testSpecifications)
  const shouldInstallBrowserReporter = shouldUseBrowserReporter(frameworkVersion, testSpecifications)
  const shouldInstallMainReporter = shouldInstallNoWorkerInit || shouldInstallBrowserReporter
  const disableTestImpactAnalysis =
    forceDisableTestImpactAnalysis ||
    safeConfig(ctx)?.watch === true ||
    hasOnlyTypecheckTestSpecifications(testSpecifications)
  const specificationsKey = getTestSpecificationsKey(testSpecifications)
  let setupState = mainProcessSetupStates.get(ctx)
  if (shouldDeactivateOnFallback && setupState?.shouldInstallMainReporter && !shouldInstallMainReporter) {
    noWorkerInit.deactivate(ctx)
  }
  if (
    !setupState ||
    setupState.specificationsKey !== specificationsKey ||
    setupState.shouldInstallNoWorkerInit !== shouldInstallNoWorkerInit ||
    setupState.shouldInstallBrowserReporter !== shouldInstallBrowserReporter ||
    setupState.disableTestImpactAnalysis !== disableTestImpactAnalysis
  ) {
    setupState = {
      setupPromise: runMainProcessSetup(
        ctx,
        frameworkVersion,
        testSpecifications,
        shouldInstallNoWorkerInit,
        shouldInstallBrowserReporter,
        disableTestImpactAnalysis
      ),
      disableTestImpactAnalysis,
      shouldInstallBrowserReporter,
      shouldInstallMainReporter,
      shouldInstallNoWorkerInit,
      specificationsKey,
    }
    mainProcessSetupStates.set(ctx, setupState)
  }
  return setupState.setupPromise
}

function shouldUseNoWorkerInit (ctx, frameworkVersion, testSpecifications) {
  return noWorkerInit.shouldUse(ctx, frameworkVersion, testSpecifications, {
    hasVitestWorkerPoolTestSpecification,
    isVitestWorkerPool,
  })
}

function shouldUseBrowserReporter (frameworkVersion, testSpecifications) {
  return noWorkerInit.isSupportedVersion(frameworkVersion) &&
    Array.isArray(testSpecifications) &&
    testSpecifications.some(isBrowserTestSpecification)
}

function configureFlakyTestRetries (ctx, testSpecifications) {
  if (!isFlakyTestRetriesEnabled || flakyTestRetriesCount <= 0) return

  let configured = false
  let includesUnnamedProject = false
  const projectNames = []
  for (const { config, projectName } of getVitestProjectConfigs(ctx, testSpecifications)) {
    if (!config.retry) {
      config.retry = flakyTestRetriesCount
      configured = true
      if (projectName) {
        projectNames.push(projectName)
      } else {
        includesUnnamedProject = true
      }
    }
  }

  if (!configured) return

  return {
    includesUnnamedProject,
    projectNames,
  }
}

function getVitestProjectConfigs (ctx, testSpecifications) {
  const entries = []

  addTestSpecificationConfigs(entries, testSpecifications)
  if (entries.length > 0) {
    return entries
  }

  const selectedProjectNames = getSelectedProjectNames()
  addSelectedInlineProjectConfigs(entries, safeConfig(ctx), selectedProjectNames)
  addSelectedRuntimeProjectConfigs(entries, ctx?.projects, selectedProjectNames)
  if (entries.length > 0) {
    return entries
  }

  if (Array.isArray(ctx?.projects)) {
    for (const project of ctx.projects) {
      addConfig(entries, safeConfig(project), getProjectName(project))
    }
    if (entries.length > 0) {
      return entries
    }
  }

  addConfig(entries, safeConfig(ctx))
  addConfig(entries, safeConfig(safeWorkspaceProject(ctx)))

  return entries
}

function addTestSpecificationConfigs (entries, testSpecifications) {
  if (!Array.isArray(testSpecifications)) return

  for (const testSpecification of testSpecifications) {
    const project = getTestSpecificationProject(testSpecification)
    addConfig(entries, safeConfig(project), getProjectName(project))
  }
}

function addSelectedInlineProjectConfigs (entries, rootConfig, selectedProjectNames) {
  if (selectedProjectNames.length === 0 || !Array.isArray(rootConfig?.projects)) return

  for (const project of rootConfig.projects) {
    const config = getInlineProjectConfig(project)
    const projectName = getProjectName(project)
    if (selectedProjectNames.includes(projectName)) {
      addConfig(entries, config, projectName)
    }
  }
}

function addSelectedRuntimeProjectConfigs (entries, projects, selectedProjectNames) {
  if (selectedProjectNames.length === 0 || !Array.isArray(projects)) return

  for (const project of projects) {
    const projectName = getProjectName(project)
    if (selectedProjectNames.includes(projectName)) {
      addConfig(entries, safeConfig(project), projectName)
    }
  }
}

function getSelectedProjectNames () {
  const names = []
  for (let index = 0; index < process.argv.length; index++) {
    const argument = process.argv[index]
    if (argument === '--project' && process.argv[index + 1]) {
      names.push(process.argv[index + 1])
      index++
    } else if (argument.startsWith('--project=')) {
      names.push(argument.slice('--project='.length))
    }
  }
  return names
}

function getInlineProjectConfig (project) {
  return project?.test || project
}

function getProjectName (project) {
  return normalizeProjectName(project?.name || project?.config?.name || project?.test?.name)
}

function normalizeProjectName (name) {
  if (typeof name === 'string') return name

  const label = name?.label
  return typeof label === 'string' ? label : undefined
}

function addConfig (entries, config, projectName) {
  if (config && !entries.some(entry => entry.config === config || (projectName && entry.projectName === projectName))) {
    entries.push({ config, projectName })
  }
}

function safeConfig (project) {
  let config
  try {
    config = project?.config
  } catch {}
  return config
}

function safeWorkspaceProject (ctx) {
  let project
  try {
    project = getWorkspaceProject(ctx)
  } catch {}
  return project
}

function getSortWrapper (sort, frameworkVersion) {
  return async function () {
    if (!activeRunFilesContexts.has(this.ctx)) {
      const testSpecifications = arguments[0]
      await ensureMainProcessSetup(this.ctx, frameworkVersion, testSpecifications)
      arguments[0] = applySuiteSkipping(this.ctx, testSpecifications, frameworkVersion)
    }
    return sort.apply(this, arguments)
  }
}

function getFinishWrapper (exitOrClose) {
  let isClosed = false
  return async function () {
    if (isClosed) { // needed because exit calls close
      return exitOrClose.apply(this, arguments)
    }
    isClosed = true

    if (!testSessionFinishCh.hasSubscribers) {
      return exitOrClose.apply(this, arguments)
    }

    const failedSuites = this.state.getFailedFilepaths()
    const runError = runErrorsByContext.get(this)
    runErrorsByContext.delete(this)
    let error = runError
    if (!error && failedSuites.length) {
      error = new Error(`Test suites failed: ${failedSuites.length}.`)
    }

    const flushPromise = getChannelPromise(testSessionFinishCh, {
      status: runError ? 'fail' : (areAllSuitesSkipped ? 'skip' : getSessionStatus(this.state)),
      testCodeCoverageLinesTotal,
      error,
      isEarlyFlakeDetectionEnabled,
      isEarlyFlakeDetectionFaulty,
      isTestManagementTestsEnabled,
      isCodeCoverageEnabled: isSessionCodeCoverageEnabled,
      isSuitesSkippingEnabled: isSessionSuitesSkippingEnabled,
      isSuitesSkipped: skippedSuites.length > 0,
      numSkippedSuites: skippedSuites.length,
      hasUnskippableSuites,
      hasForcedToRunSuites,
      requestErrorTags,
      vitestPool,
      isVitestNoWorkerInitActive: isVitestNoWorkerInitActive || isVitestBrowserModeActive,
    })

    const shouldLogAllTestsSkippedMessage = areAllSuitesSkipped && !hasLoggedAllTestsSkippedMessage
    hasLoggedAllTestsSkippedMessage ||= shouldLogAllTestsSkippedMessage
    logTestOptimizationSummary({
      attemptToFixExecutions,
      newTestsWithDynamicNames,
      extraSections: shouldLogAllTestsSkippedMessage ? [TEST_IMPACT_ANALYSIS_ALL_TESTS_SKIPPED_MESSAGE] : [],
    })

    await flushPromise

    // If coverage was generated, publish coverage report channel for upload
    if (coverageRootDir && codeCoverageReportCh.hasSubscribers) {
      await getChannelPromise(codeCoverageReportCh, { rootDir: coverageRootDir })
    }

    return exitOrClose.apply(this, arguments)
  }
}

function getCliOrStartVitestWrapper (frameworkVersion) {
  return function (oldCliOrStartVitest) {
    return function (...args) {
      if (!testSessionStartCh.hasSubscribers || isSessionStarted) {
        return oldCliOrStartVitest.apply(this, args)
      }
      isSessionStarted = true
      resetSessionSuiteSkippingState()
      testSessionStartCh.publish({ command: getTestCommand(), frameworkVersion })
      return oldCliOrStartVitest.apply(this, args)
    }
  }
}

function isForkPool (pool) {
  return pool === 'forks' || pool === 'vmForks'
}

function isThreadPool (pool) {
  return pool === 'threads' || pool === 'vmThreads'
}

function isVitestWorkerPool (pool) {
  return isForkPool(pool) || isThreadPool(pool)
}

function isBrowserProject (project) {
  try {
    if (project?.isBrowserEnabled?.()) return true
  } catch {}

  return safeConfig(project)?.browser?.enabled === true ||
    project?.serializedConfig?.browser?.enabled === true
}

function getTestSpecificationProject (testSpecification) {
  if (Array.isArray(testSpecification)) {
    return testSpecification[0]
  }
  return testSpecification?.project
}

function getTestSpecificationOptions (testSpecification) {
  if (Array.isArray(testSpecification)) {
    return testSpecification[2]
  }
  return testSpecification
}

function getTestSpecificationPool (testSpecification) {
  const options = getTestSpecificationOptions(testSpecification)
  const project = getTestSpecificationProject(testSpecification)
  const filePool = Array.isArray(testSpecification) ? testSpecification[1]?.pool : undefined
  return options?.pool || filePool || project?.config?.pool || project?.serializedConfig?.pool ||
    project?.pool || testSpecification?.pool
}

/**
 * Detect whether Vitest selected only TypeScript typecheck specifications.
 *
 * @param {unknown} testSpecifications
 * @returns {boolean}
 */
function hasOnlyTypecheckTestSpecifications (testSpecifications) {
  if (!Array.isArray(testSpecifications) || testSpecifications.length === 0) return false

  for (const testSpecification of testSpecifications) {
    if (getTestSpecificationPool(testSpecification) !== 'typescript') return false
  }
  return true
}

function isBrowserTestSpecification (testSpecification) {
  return getTestSpecificationPool(testSpecification) === 'browser' ||
    isBrowserProject(getTestSpecificationProject(testSpecification))
}

function getBrowserTestSpecifications (testSpecifications) {
  if (!Array.isArray(testSpecifications)) return testSpecifications

  return testSpecifications.filter(isBrowserTestSpecification)
}

function isBrowserTestModule (testModule) {
  return testModule?.task?.pool === 'browser' ||
    testModule?.pool === 'browser' ||
    isBrowserProject(testModule?.project)
}

function hasVitestWorkerPoolTestSpecification (testSpecifications) {
  if (!Array.isArray(testSpecifications)) {
    return false
  }

  for (const testSpecification of testSpecifications) {
    if (isVitestWorkerPool(getTestSpecificationPool(testSpecification))) {
      return true
    }
  }

  return false
}

function shouldMarkVitestWorkerEnv (pool, testSpecifications, shouldSkipWorkerInit) {
  if (!shouldSkipWorkerInit) {
    return isVitestWorkerPool(pool) || hasVitestWorkerPoolTestSpecification(testSpecifications) ||
      (!testSpecifications && pool === undefined)
  }

  return isVitestWorkerPool(pool) || pool === undefined || hasVitestWorkerPoolTestSpecification(testSpecifications)
}

function markVitestWorkerEnv (ctx, testSpecifications, shouldSkipWorkerInit = false) {
  const config = ctx?.config
  isVitestNoWorkerInitActive = shouldSkipWorkerInit
  if (!config || !shouldMarkVitestWorkerEnv(config.pool, testSpecifications, shouldSkipWorkerInit)) {
    return
  }
  config.env = getVitestWorkerEnv(config.env, shouldSkipWorkerInit)
}

function wrapVitestRunFiles (Vitest, frameworkVersion) {
  if (!Vitest?.prototype?.runFiles || runFilesWrappedPrototypes.has(Vitest.prototype)) {
    return
  }
  runFilesWrappedPrototypes.add(Vitest.prototype)

  shimmer.wrap(Vitest.prototype, 'runFiles', runFiles => async function (testSpecifications) {
    if (activeRunFilesContexts.has(this)) {
      return runFiles.apply(this, arguments)
    }

    const shouldSkipWorkerInit = await ensureMainProcessSetup(this, frameworkVersion, testSpecifications, true)
    const testSpecificationsToRun = applySuiteSkipping(this, testSpecifications, frameworkVersion)
    arguments[0] = testSpecificationsToRun
    markVitestWorkerEnv(this, testSpecificationsToRun, shouldSkipWorkerInit)
    activeRunFilesContexts.add(this)
    try {
      return await runFiles.apply(this, arguments)
    } catch (error) {
      runErrorsByContext.set(this, error)
      throw error
    } finally {
      activeRunFilesContexts.delete(this)
    }
  })

  if (Vitest.prototype.collectTests) {
    shimmer.wrap(Vitest.prototype, 'collectTests', collectTests => function (testSpecifications) {
      const shouldSkipWorkerInit = shouldUseNoWorkerInit(this, frameworkVersion, testSpecifications)
      markVitestWorkerEnv(this, testSpecifications, shouldSkipWorkerInit)
      return collectTests.apply(this, arguments)
    })
  }
}

function getTypecheckTaskStatus (task) {
  const state = task.result?.state
  if (state === 'fail') return 'fail'
  if (state === 'skip' || task.mode === 'skip' || task.mode === 'todo') return 'skip'
  return 'pass'
}

/**
 * Return whether a typecheck suite name represents the synthetic file-level suite.
 *
 * @param {string|undefined} suiteName
 * @param {string} testSuiteAbsolutePath
 * @returns {boolean}
 */
function isTypecheckFileSuiteName (suiteName, testSuiteAbsolutePath) {
  if (!suiteName || !testSuiteAbsolutePath) return false

  const normalizedSuiteName = path.normalize(suiteName).replaceAll('\\', '/')
  const normalizedSuitePath = path.normalize(testSuiteAbsolutePath).replaceAll('\\', '/')

  return normalizedSuitePath === normalizedSuiteName || normalizedSuitePath.endsWith(`/${normalizedSuiteName}`)
}

/**
 * Return a typecheck test name with describe/suite prefixes and without the file-level suite prefix.
 *
 * @param {object} task
 * @param {string} testSuiteAbsolutePath
 * @returns {string}
 */
function getTypecheckTestName (task, testSuiteAbsolutePath) {
  let testName = task.name || task.fullTestName
  let currentTask = task.suite

  while (currentTask) {
    if (currentTask.name && !isTypecheckFileSuiteName(currentTask.name, testSuiteAbsolutePath)) {
      testName = `${currentTask.name} ${testName}`
    }
    currentTask = currentTask.suite
  }

  return testName
}

/**
 * Return Test Optimization metadata prepared in Vitest's main process setup.
 *
 * @param {object|undefined} ctx
 * @returns {{ testPropertiesByFilepath: object }}
 */
function getMainProcessProvidedContext (ctx) {
  try {
    const workspaceProject = getWorkspaceProject(ctx)
    const providedContext = workspaceProject.getProvidedContext?.() || workspaceProject._provided || {}

    return {
      testPropertiesByFilepath: parseProvidedContextValue(providedContext._ddTestPropertiesByFilepath) || {},
    }
  } catch {
    return {
      testPropertiesByFilepath: {},
    }
  }
}

/**
 * Return the Vitest context that owns a Typechecker instance.
 *
 * @param {object} typechecker
 * @returns {object|undefined}
 */
function getTypecheckerVitestContext (typechecker) {
  return typechecker.ctx || typechecker.project?.vitest
}

/**
 * Apply Test Management result semantics to Vitest's returned typecheck task result.
 *
 * @param {object} task
 * @param {string} status
 * @param {{
 *   isAttemptToFix: boolean,
 *   isDisabled: boolean,
 *   isQuarantined: boolean
 * }} testManagement
 */
function updateTypecheckTaskResultForTestManagement (task, status, testManagement) {
  const { isAttemptToFix, isDisabled, isQuarantined } = testManagement
  if (isAttemptToFix || !task.result) return

  if (isDisabled) {
    task.mode = 'skip'
    task.result.state = 'skip'
    task.result.errors = []
    return
  }

  if (isQuarantined && status === 'fail') {
    task.result.state = 'pass'
    task.result.errors = []
  }
}

/**
 * Recompute suite/file typecheck results after Test Management rewrites child test results.
 *
 * @param {object} task
 * @returns {string}
 */
function updateTypecheckTaskTreeResult (task) {
  if (!Array.isArray(task.tasks)) return getTypecheckTaskStatus(task)

  let hasPassedTest = false
  let hasSkippedTest = false
  for (const childTask of task.tasks) {
    const status = updateTypecheckTaskTreeResult(childTask)
    if (status === 'fail') {
      task.result = {
        ...task.result,
        state: 'fail',
      }
      return 'fail'
    }
    if (status === 'skip') {
      hasSkippedTest = true
    } else {
      hasPassedTest = true
    }
  }

  if (task.result?.errors?.length) return 'fail'
  if (!hasPassedTest && !hasSkippedTest) return getTypecheckTaskStatus(task)

  task.result = {
    ...task.result,
    state: hasPassedTest ? 'pass' : 'skip',
    errors: [],
  }
  return task.result.state
}

/**
 * Recompute the aggregate typecheck result after Test Management rewrites file results.
 *
 * @param {{
 *   files?: object[],
 *   errors?: object[],
 *   diagnostics?: object[],
 *   sourceErrors?: object[],
 *   state?: string
 * }} result
 * @returns {boolean}
 */
function updateTypecheckResult (result) {
  if (result.sourceErrors?.length) return false

  let hasPassedFile = false
  let hasSkippedFile = false
  for (const file of result.files) {
    const status = getTypecheckTaskStatus(file)
    if (status === 'fail') return false
    if (status === 'skip') {
      hasSkippedFile = true
    } else {
      hasPassedFile = true
    }
  }

  if (!hasPassedFile && !hasSkippedFile) return false

  result.state = hasPassedFile ? 'pass' : 'skip'
  result.errors = []
  result.diagnostics = []
  result.sourceErrors = []
  return true
}

/**
 * Clear Vitest's typechecker exit code after all typecheck failures were handled by Test Management.
 *
 * @param {{ process?: { exitCode?: number|null } }} typechecker
 */
function clearTypecheckerExitCode (typechecker) {
  if (typechecker?.process?.exitCode == null) return

  typechecker.process.exitCode = 0
}

function reportTypecheckTest (task, testSuiteAbsolutePath, providedContext) {
  const testName = getTypecheckTestName(task, testSuiteAbsolutePath)
  const testProperties = getVitestTestProperties(providedContext, testSuiteAbsolutePath, testName)
  const isAttemptToFix = testProperties.isAttemptToFix === true
  const isDisabled = testProperties.isDisabled === true
  const isQuarantined = testProperties.isQuarantined === true
  const isModified = testProperties.isModified === true
  const isSkippedByTestManagement = !isAttemptToFix && isDisabled
  const status = getTypecheckTaskStatus(task)
  const summaryStatus = isSkippedByTestManagement ? 'skip' : status

  recordTestManagementExecution({
    testSuite: testProperties.testSuite,
    testName,
    status: summaryStatus,
    isAttemptToFix,
    isDisabled,
    isQuarantined,
  })
  if (isAttemptToFix) {
    recordAttemptToFixExecution(attemptToFixExecutions, {
      testSuite: testProperties.testSuite,
      testName,
      status: summaryStatus,
      isDisabled,
      isQuarantined,
    })
  }

  if (status === 'skip' || isSkippedByTestManagement) {
    testSkipCh.publish({
      testName,
      testSuiteAbsolutePath,
      isNew: testProperties.isNew,
      isAttemptToFix,
      isDisabled,
      isQuarantined,
    })
    updateTypecheckTaskResultForTestManagement(task, status, { isAttemptToFix, isDisabled, isQuarantined })
    return
  }

  const ctx = {
    testName,
    testSuiteAbsolutePath,
    isRetry: false,
    isNew: testProperties.isNew,
    hasDynamicName: false,
    mightHitProbe: false,
    isAttemptToFix,
    isDisabled,
    isQuarantined,
    isModified,
  }
  testStartCh.runStores(ctx, () => {})

  const finalStatus = !isAttemptToFix && isQuarantined ? 'skip' : undefined
  if (status === 'fail') {
    testErrorCh.publish({
      error: task.result?.errors?.[0],
      finalStatus,
      ...ctx.currentStore,
    })
  } else {
    testPassCh.publish({
      task,
      finalStatus,
      ...ctx.currentStore,
    })
  }
  updateTypecheckTaskResultForTestManagement(task, status, { isAttemptToFix, isDisabled, isQuarantined })
}

async function reportTypecheckFile (file, sessionConfiguration, frameworkVersion, providedContext) {
  const testSuiteAbsolutePath = file.filepath
  const testSuiteCtx = {
    testSuiteAbsolutePath,
    frameworkVersion,
    testSessionId: sessionConfiguration.testSessionId,
    testModuleId: sessionConfiguration.testModuleId,
    testCommand: sessionConfiguration.testCommand,
    repositoryRoot: sessionConfiguration.repositoryRoot,
    codeOwnersEntries: sessionConfiguration.codeOwnersEntries,
    disableTestImpactAnalysis: isTestImpactAnalysisDisabled,
  }
  testSuiteStartCh.runStores(testSuiteCtx, () => {})

  for (const task of getTypeTasks(file.tasks)) {
    reportTypecheckTest(task, testSuiteAbsolutePath, providedContext)
  }
  updateTypecheckTaskTreeResult(file)

  const testSuiteError = file.result?.errors?.[0]
  if (testSuiteError) {
    testSuiteCtx.error = testSuiteError
    testSuiteErrorCh.runStores(testSuiteCtx, () => {})
  }

  await getChannelPromise(testSuiteFinishCh, {
    deferFlush: true,
    frameworkVersion,
    status: getTypecheckTaskStatus(file),
    ...testSuiteCtx.currentStore,
  })
}

async function reportTypecheckResults (result, frameworkVersion, ctx, typechecker, files = result?.files) {
  if (!testSuiteFinishCh.hasSubscribers) return
  if (!Array.isArray(result?.files) || !Array.isArray(files)) return

  const setupState = ctx && mainProcessSetupStates.get(ctx)
  if (
    ctx &&
    (!setupState || setupState.shouldInstallMainReporter || setupState.disableTestImpactAnalysis)
  ) {
    await ensureMainProcessSetup(
      ctx,
      frameworkVersion,
      files,
      false,
      !setupState || setupState.disableTestImpactAnalysis
    )
  }
  const providedContext = getMainProcessProvidedContext(ctx)
  const sessionConfiguration = testSessionConfigurationCh.hasSubscribers
    ? await getChannelPromise(testSessionConfigurationCh, { frameworkVersion }) || {}
    : {}

  await Promise.all(files.map(file => reportTypecheckFile(
    file,
    sessionConfiguration,
    frameworkVersion,
    providedContext
  )))
  if (updateTypecheckResult(result)) {
    clearTypecheckerExitCode(typechecker)
  }
}

function wrapTypechecker (Typechecker, frameworkVersion) {
  if (!Typechecker?.prototype?.prepareResults) return

  shimmer.wrap(Typechecker.prototype, 'prepareResults', prepareResults => async function () {
    const result = await prepareResults.apply(this, arguments)
    await reportTypecheckResults(result, frameworkVersion, getTypecheckerVitestContext(this), this)
    return result
  })
}

function getTypecheckerWrapper (vitestPackage, frameworkVersion) {
  const typechecker = getTypecheckerExport(vitestPackage)
  if (typechecker) {
    wrapTypechecker(typechecker.value, frameworkVersion)
  }
  return vitestPackage
}

function wrapTypecheckPoolWorker (TypecheckPoolWorker, frameworkVersion) {
  if (!TypecheckPoolWorker?.prototype?.send || !TypecheckPoolWorker.prototype.on) return

  shimmer.wrap(TypecheckPoolWorker.prototype, 'send', send => function (message) {
    typecheckPoolWorkerRequests.set(this, {
      type: message?.type,
      filepaths: new Set(message?.context?.files?.map(file => file.filepath)),
    })
    return send.apply(this, arguments)
  })
  shimmer.wrap(TypecheckPoolWorker.prototype, 'on', on => function (event, callback) {
    if (event !== 'message') return on.apply(this, arguments)

    const worker = this
    arguments[1] = shimmer.wrapFunction(callback, callback => function (message) {
      const typechecker = worker.project?.typechecker
      const request = typecheckPoolWorkerRequests.get(worker)
      if (
        message?.type !== 'testfileFinished' ||
        request?.type !== 'run' ||
        !typechecker
      ) {
        return callback.apply(this, arguments)
      }

      const result = typechecker.getResult?.()
      const files = result?.files?.filter(file => request.filepaths.has(file.filepath))
      return reportTypecheckResults(
        result,
        frameworkVersion,
        worker.project?.vitest,
        typechecker,
        files
      ).then(
        () => callback.apply(this, arguments),
        (error) => {
          log.error('Could not report Vitest typecheck results: %s', error?.message)
          return callback.apply(this, arguments)
        }
      )
    })
    return on.apply(this, arguments)
  })
}

function getCreateCliWrapper (vitestPackage, frameworkVersion) {
  const createCliExport = findExportByName(vitestPackage, 'createCLI')
  if (!createCliExport) {
    return vitestPackage
  }
  shimmer.wrap(vitestPackage, createCliExport.key, getCliOrStartVitestWrapper(frameworkVersion))

  return vitestPackage
}

function threadHandler (thread) {
  const { runtime } = thread
  let workerProcess
  if (runtime === 'child_process') {
    vitestPool = 'child_process'
    workerProcess = thread.process
  } else if (runtime === 'worker_threads') {
    vitestPool = 'worker_threads'
    workerProcess = thread.thread
  } else {
    vitestPool = 'unknown'
  }
  if (!workerProcess) {
    log.error('Vitest error: could not get process or thread from TinyPool#run')
    return
  }

  if (workerProcesses.has(workerProcess)) {
    return
  }
  workerProcesses.add(workerProcess)
  workerProcess.on('message', (message) => {
    if (message.__tinypool_worker_message__ && message.data) {
      handleWorkerReport(message.interprocessCode, message.data)
    }
  })
}

function isVitestTinypoolOptions (options) {
  if (options?.env?.VITEST !== 'true' || typeof options.filename !== 'string') return false

  let filename = options.filename
  if (filename.startsWith('file:')) {
    try {
      filename = fileURLToPath(filename)
    } catch {
      return false
    }
  }

  const workerPath = path.normalize(filename)
  const workerDir = path.dirname(workerPath)
  const packageDir = path.dirname(workerDir)

  return path.basename(workerPath) === 'worker.js' &&
    path.basename(workerDir) === 'dist' &&
    path.basename(packageDir) === 'vitest'
}

function markVitestTinypoolOptions (options) {
  if (!isVitestTinypoolOptions(options)) return

  options.env = getVitestWorkerEnv(options.env, isVitestNoWorkerInitActive)
}

function getVitestWorkerEnv (env = {}, shouldSkipWorkerInit = false) {
  return noWorkerInit.configureWorkerEnv({
    ...env,
    DD_VITEST_WORKER: '1',
  }, shouldSkipWorkerInit)
}

function wrapTinyPoolRun (TinyPool) {
  if (!TinyPool?.prototype?.run) return

  shimmer.wrap(TinyPool.prototype, 'run', run => async function () {
    // We have to do this before and after because the threads list gets recycled, that is, the processes are re-created
    this.threads.forEach(threadHandler)
    const runResult = await run.apply(this, arguments)
    this.threads.forEach(threadHandler)
    return runResult
  })
}

function wrapTinyPoolClass (TinyPool) {
  if (typeof TinyPool !== 'function') return TinyPool

  const wrappedTinyPool = tinyPoolClassWrappers.get(TinyPool)
  if (wrappedTinyPool) return wrappedTinyPool

  class DatadogTinyPool extends TinyPool {
    constructor (options) {
      markVitestTinypoolOptions(options)
      super(options)
    }
  }

  tinyPoolClassWrappers.set(TinyPool, DatadogTinyPool)
  wrapTinyPoolRun(DatadogTinyPool)

  return DatadogTinyPool
}

function wrapTinyPool (TinyPool) {
  if (typeof TinyPool === 'function') {
    return wrapTinyPoolClass(TinyPool)
  }

  const defaultTinyPool = wrapTinyPoolClass(TinyPool?.default)
  if (defaultTinyPool) {
    TinyPool.default = defaultTinyPool
  }

  const namedTinyPool = TinyPool?.Tinypool === TinyPool?.default
    ? defaultTinyPool
    : wrapTinyPoolClass(TinyPool?.Tinypool)
  if (namedTinyPool) {
    TinyPool.Tinypool = namedTinyPool
  }

  return TinyPool
}

function getWrappedOn (on) {
  return function (event, callback) {
    if (event !== 'message') {
      return on.apply(this, arguments)
    }
    // `arguments[1]` is the callback function, which
    // we modify to intercept our messages to not interfere
    // with vitest's own messages
    arguments[1] = shimmer.wrapFunction(callback, callback => function (message) {
      if (message.type !== 'Buffer' && Array.isArray(message)) {
        const [interprocessCode, data] = message
        if (
          handleEfdAdmissionMessage(this, interprocessCode, data) ||
          handleWorkerReport(interprocessCode, data)
        ) {
          // If we execute the callback vitest crashes, as the message is not supported
          return
        }
      }
      return callback.apply(this, arguments)
    })
    return on.apply(this, arguments)
  }
}

/**
 * Handles an EFD suite admission request sent through a Vitest worker transport.
 *
 * @param {object} workerProcess
 * @param {number} interprocessCode
 * @param {object} data
 * @returns {boolean}
 */
function handleEfdAdmissionMessage (workerProcess, interprocessCode, data) {
  if (interprocessCode !== VITEST_WORKER_EFD_SUITE_ADMISSION_REQUEST_CODE) return false

  const response = [VITEST_WORKER_EFD_SUITE_ADMISSION_RESPONSE_CODE, {
    allowed: reserveEarlyFlakeDetectionSuite(data?.testSuite, data?.hasNewTest === true),
    requestId: data?.requestId,
  }]
  try {
    if (typeof workerProcess.send === 'function') {
      workerProcess.send(response, (error) => {
        if (error) {
          log.error('Could not send Vitest EFD suite admission response: %s', error.message)
        }
      })
    } else {
      workerProcess.postMessage(response)
    }
  } catch (error) {
    log.error('Could not send Vitest EFD suite admission response: %s', error?.message)
  }
  return true
}

function handleWorkerReport (interprocessCode, data) {
  if (interprocessCode === VITEST_WORKER_TRACE_PAYLOAD_CODE) {
    collectTestOptimizationSummariesFromTraces(data, {
      newTestsWithDynamicNames,
      attemptToFixExecutions,
    })
    workerReportTraceCh.publish(data)
    return true
  }

  if (interprocessCode === VITEST_WORKER_COVERAGE_PAYLOAD_CODE) {
    workerReportCoverageCh.publish(data)
    return true
  }

  if (interprocessCode === VITEST_WORKER_LOGS_PAYLOAD_CODE) {
    workerReportLogsCh.publish(data)
    return true
  }

  if (interprocessCode === VITEST_WORKER_TELEMETRY_PAYLOAD_CODE) {
    workerReportTelemetryCh.publish(data)
    return true
  }

  return false
}

function wrapMessagePortOn () {
  if (isMessagePortWrapped) return

  isMessagePortWrapped = true
  shimmer.wrap(MessagePort.prototype, 'on', getWrappedOn)
  shimmer.wrap(MessagePort.prototype, 'addListener', getWrappedOn)
}

function getStartVitestWrapper (cliApiPackage, frameworkVersion) {
  if (!isCliApiPackage(cliApiPackage)) {
    return cliApiPackage
  }
  const startVitestExport = findExportByName(cliApiPackage, 'startVitest')
  shimmer.wrap(cliApiPackage, startVitestExport.key, getCliOrStartVitestWrapper(frameworkVersion))
  const createVitestExport = findExportByName(cliApiPackage, 'createVitest')
  if (createVitestExport) {
    shimmer.wrap(cliApiPackage, createVitestExport.key, getCliOrStartVitestWrapper(frameworkVersion))
  }
  wrapMessagePortOn()

  wrapVitestInternals(cliApiPackage, frameworkVersion)
  return cliApiPackage
}

function wrapVitestInternals (vitestPackage, frameworkVersion) {
  const vitest = getVitestExport(vitestPackage)
  if (vitest) {
    wrapVitestRunFiles(vitest.value, frameworkVersion)
  }

  const forksPoolWorker = getForksPoolWorkerExport(vitestPackage)
  if (forksPoolWorker) {
    // function is async
    shimmer.wrap(forksPoolWorker.value.prototype, 'start', start => function (...args) {
      vitestPool = 'child_process'
      this.env = getVitestWorkerEnv(this.env, isVitestNoWorkerInitActive)

      return start.apply(this, args)
    })
    shimmer.wrap(forksPoolWorker.value.prototype, 'on', getWrappedOn)
  }

  const threadsPoolWorker = getThreadsPoolWorkerExport(vitestPackage)
  if (threadsPoolWorker) {
    // function is async
    shimmer.wrap(threadsPoolWorker.value.prototype, 'start', start => function (...args) {
      vitestPool = 'worker_threads'
      this.env = getVitestWorkerEnv(this.env, isVitestNoWorkerInitActive)
      return start.apply(this, args)
    })
    shimmer.wrap(threadsPoolWorker.value.prototype, 'on', getWrappedOn)
  }
}

addHook({
  name: 'tinypool',
  // version from tinypool@0.8 was used in vitest@1.6.0
  versions: ['>=0.8.0'],
}, (TinyPool) => {
  return wrapTinyPool(TinyPool)
})

// There are multiple index* files across different versions of vitest,
// so we check for the existence of BaseSequencer to determine if we are in the right file
addHook({
  name: 'vitest',
  versions: ['>=1.6.0 <2.0.0'],
  filePattern: 'dist/vendor/index.*',
}, (vitestPackage, frameworkVersion) => {
  if (isReporterPackage(vitestPackage)) {
    shimmer.wrap(vitestPackage.B.prototype, 'sort', sort => getSortWrapper(sort, frameworkVersion))
  }

  return vitestPackage
})

addHook({
  name: 'vitest',
  versions: ['>=2.0.0 <2.0.5'],
  filePattern: 'dist/vendor/index.*',
}, (vitestPackage, frameworkVersion) => {
  if (isReporterPackageNew(vitestPackage)) {
    shimmer.wrap(vitestPackage.e.prototype, 'sort', sort => getSortWrapper(sort, frameworkVersion))
  }

  return vitestPackage
})

addHook({
  name: 'vitest',
  versions: ['>=2.0.5 <2.1.0'],
  filePattern: 'dist/chunks/index.*',
}, (vitestPackage, frameworkVersion) => {
  if (isReporterPackageNewest(vitestPackage)) {
    shimmer.wrap(vitestPackage.h.prototype, 'sort', sort => getSortWrapper(sort, frameworkVersion))
  }

  return vitestPackage
})

addHook({
  name: 'vitest',
  versions: ['>=3.2.0 <4.0.0'],
  filePattern: 'dist/chunks/typechecker.*',
}, getTypecheckerWrapper)

addHook({
  name: 'vitest',
  versions: ['>=4.0.0'],
  filePattern: 'dist/chunks/index.*',
}, getTypecheckerWrapper)

addHook({
  name: 'vitest',
  versions: ['>=2.1.0 <3.0.0'],
  filePattern: 'dist/chunks/RandomSequencer.*',
}, (randomSequencerPackage, frameworkVersion) => {
  shimmer.wrap(
    randomSequencerPackage.B.prototype,
    'sort',
    sort => getSortWrapper(sort, frameworkVersion)
  )
  return randomSequencerPackage
})

addHook({
  name: 'vitest',
  versions: ['>=3.0.9'],
  filePattern: 'dist/chunks/coverage.*',
}, (coveragePackage, frameworkVersion) => {
  const baseSequencer = getBaseSequencerExport(coveragePackage)
  if (baseSequencer) {
    shimmer.wrap(
      baseSequencer.value.prototype,
      'sort',
      sort => getSortWrapper(sort, frameworkVersion)
    )
  }
  return coveragePackage
})

// Vitest 5 moved the core and pool worker exports out of cli-api into an index chunk.
addHook({
  name: 'vitest',
  versions: ['>=5.0.0'],
  filePattern: 'dist/chunks/index.*',
}, (vitestPackage, frameworkVersion) => {
  if (!getVitestExport(vitestPackage)) return vitestPackage

  wrapVitestInternals(vitestPackage, frameworkVersion)

  const typecheckPoolWorker = getTypecheckPoolWorkerExport(vitestPackage)
  if (typecheckPoolWorker) {
    wrapTypecheckPoolWorker(typecheckPoolWorker.value, frameworkVersion)
  }

  const baseSequencer = getBaseSequencerExport(vitestPackage)
  if (baseSequencer) {
    shimmer.wrap(
      baseSequencer.value.prototype,
      'sort',
      sort => getSortWrapper(sort, frameworkVersion)
    )
  }
  return vitestPackage
})

addHook({
  name: 'vitest',
  versions: ['>=3.0.0 <3.0.9'],
  filePattern: 'dist/chunks/resolveConfig.*',
}, (resolveConfigPackage, frameworkVersion) => {
  shimmer.wrap(
    resolveConfigPackage.B.prototype,
    'sort',
    sort => getSortWrapper(sort, frameworkVersion)
  )
  return resolveConfigPackage
})

// Can't specify file because compiled vitest includes hashes in their files
// Following 3 wrappers are for test session start
addHook({
  name: 'vitest',
  versions: ['>=1.6.0 <2.0.5'],
  filePattern: 'dist/vendor/cac.*',
}, getCreateCliWrapper)

addHook({
  name: 'vitest',
  versions: ['>=2.0.5'],
  filePattern: 'dist/chunks/cac.*',
}, getCreateCliWrapper)

addHook({
  name: 'vitest',
  versions: ['>=1.6.0 <2.0.5'],
  filePattern: 'dist/vendor/cli-api.*',
}, getStartVitestWrapper)

addHook({
  name: 'vitest',
  versions: ['>=2.0.5'],
  filePattern: 'dist/chunks/cli-api.*',
}, getStartVitestWrapper)
