'use strict'

const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { MessagePort } = require('node:worker_threads')

const shimmer = require('../../datadog-shimmer')
const log = require('../../dd-trace/src/log')
const {
  VITEST_WORKER_TRACE_PAYLOAD_CODE,
  VITEST_WORKER_LOGS_PAYLOAD_CODE,
  getMaxEfdRetryCount,
  collectTestOptimizationSummariesFromTraces,
  logTestOptimizationSummary,
  getTestOptimizationRequestResults,
  getTestSuitePath,
  isModifiedTest,
} = require('../../dd-trace/src/plugins/util/test')
const { addHook } = require('./helpers/instrument')
const {
  testStartCh,
  testPassCh,
  testErrorCh,
  testSkipCh,
  testSuiteStartCh,
  testSuiteFinishCh,
  testSessionStartCh,
  testSessionFinishCh,
  testSessionConfigurationCh,
  libraryConfigurationCh,
  knownTestsCh,
  isEarlyFlakeDetectionFaultyCh,
  testManagementTestsCh,
  modifiedFilesCh,
  workerReportTraceCh,
  workerReportLogsCh,
  codeCoverageReportCh,
  findExportByName,
  getChannelPromise,
  getTypeTasks,
  getWorkspaceProject,
  setProvidedContext,
  getVitestTestProperties,
} = require('./vitest-util')

const newTestsWithDynamicNames = new Set()
const attemptToFixExecutions = new Map()
const workerProcesses = new WeakSet()
const mainProcessSetupStates = new WeakMap()
const coverageWrappedProviders = new WeakSet()
const finishWrappedContexts = new WeakSet()
let isFlakyTestRetriesEnabled = false
let flakyTestRetriesCount = 0
let isEarlyFlakeDetectionEnabled = false
let earlyFlakeDetectionNumRetries = 0
let earlyFlakeDetectionSlowTestRetries = {}
let isEarlyFlakeDetectionFaulty = false
let isKnownTestsEnabled = false
let isTestManagementTestsEnabled = false
let isImpactedTestsEnabled = false
let testManagementAttemptToFixRetries = 0
let isDiEnabled = false
let testCodeCoverageLinesTotal
let coverageRootDir
let isSessionStarted = false
let vitestPool = null
let isMessagePortWrapped = false
const tinyPoolClassWrappers = new WeakMap()

function getConfiguredEfdRetryCount (slowTestRetries, fallbackRetryCount) {
  if (!slowTestRetries || !Object.keys(slowTestRetries).length) {
    return fallbackRetryCount
  }
  return getMaxEfdRetryCount(slowTestRetries)
}

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
  return getTestSuitePath(testSuiteAbsolutePath, repositoryRoot)
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
  earlyFlakeDetectionNumRetries = 0
  earlyFlakeDetectionSlowTestRetries = {}
  isEarlyFlakeDetectionFaulty = false
  isDiEnabled = false
  isKnownTestsEnabled = false
  isTestManagementTestsEnabled = false
  isImpactedTestsEnabled = false
  testManagementAttemptToFixRetries = 0
}

function applyLibraryConfig (libraryConfig) {
  isFlakyTestRetriesEnabled = libraryConfig.isFlakyTestRetriesEnabled
  flakyTestRetriesCount = libraryConfig.flakyTestRetriesCount
  isEarlyFlakeDetectionEnabled = libraryConfig.isEarlyFlakeDetectionEnabled
  earlyFlakeDetectionNumRetries = libraryConfig.earlyFlakeDetectionNumRetries
  earlyFlakeDetectionSlowTestRetries = libraryConfig.earlyFlakeDetectionSlowTestRetries ?? {}
  isEarlyFlakeDetectionFaulty = false
  isDiEnabled = libraryConfig.isDiEnabled
  isKnownTestsEnabled = libraryConfig.isKnownTestsEnabled
  isTestManagementTestsEnabled = libraryConfig.isTestManagementEnabled
  testManagementAttemptToFixRetries = libraryConfig.testManagementAttemptToFixRetries
  isImpactedTestsEnabled = libraryConfig.isImpactedTestsEnabled
}

function resetMainProcessProvidedContext (ctx) {
  setProvidedContext(ctx, {
    _ddIsDiEnabled: false,
    _ddIsEarlyFlakeDetectionEnabled: false,
    _ddEarlyFlakeDetectionNumRetries: 0,
    _ddEarlyFlakeDetectionSlowTestRetries: {},
    _ddIsFlakyTestRetriesEnabled: false,
    _ddFlakyTestRetriesCount: 0,
    _ddFlakyTestRetriesIncludesUnnamedProject: false,
    _ddFlakyTestRetriesProjectNames: undefined,
    _ddIsImpactedTestsEnabled: false,
    _ddIsKnownTestsEnabled: false,
    _ddIsTestManagementTestsEnabled: false,
    _ddTestManagementAttemptToFixRetries: 0,
    _ddTestPropertiesByFilepath: {},
  }, 'Could not reset Test Optimization context for workers.')
}

async function runMainProcessSetup (ctx, frameworkVersion, testSpecifications) {
  if (!testSessionFinishCh.hasSubscribers) {
    return
  }

  let repositoryRoot = process.cwd()
  let testFilepaths
  let shouldSendTestProperties = false
  let knownTestsBySuite
  let testManagementTestsBySuite
  let impactedTestSuites
  const getCurrentTestFilepaths = async () => {
    if (testFilepaths === undefined) {
      testFilepaths = await getTestFilepaths(ctx, testSpecifications)
    }
    return testFilepaths
  }

  try {
    const { err, libraryConfig } = await getChannelPromise(libraryConfigurationCh, frameworkVersion)
    if (err) {
      resetLibraryConfig()
    } else {
      applyLibraryConfig(libraryConfig)
    }
  } catch {
    resetLibraryConfig()
  }

  resetMainProcessProvidedContext(ctx)

  if (testSessionConfigurationCh.hasSubscribers) {
    const {
      testSessionId,
      testModuleId,
      testCommand,
      repositoryRoot: receivedRepositoryRoot,
      codeOwnersEntries,
    } = await getChannelPromise(testSessionConfigurationCh, frameworkVersion)
    repositoryRoot = receivedRepositoryRoot || repositoryRoot
    setProvidedContext(ctx, {
      _ddTestSessionId: testSessionId,
      _ddTestModuleId: testModuleId,
      _ddTestCommand: testCommand,
      _ddRepositoryRoot: repositoryRoot,
      _ddCodeOwnersEntries: codeOwnersEntries,
    }, 'Could not send test session configuration to workers.')
  }

  const {
    knownTestsResponse,
    testManagementTestsResponse,
  } = await getTestOptimizationRequestResults({
    isKnownTestsEnabled,
    isTestManagementTestsEnabled,
    getKnownTests: () => getChannelPromise(knownTestsCh),
    getTestManagementTests: () => getChannelPromise(testManagementTestsCh),
  })

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
    if (currentKnownTestsResponse.err) {
      isEarlyFlakeDetectionEnabled = false
    } else {
      const knownTests = currentKnownTestsResponse.knownTests
      const currentTestFilepaths = await getCurrentTestFilepaths()

      if (isValidKnownTests(knownTests)) {
        isEarlyFlakeDetectionFaultyCh.publish({
          knownTests: knownTests.vitest,
          testFilepaths: currentTestFilepaths,
          onDone: (isFaulty) => {
            isEarlyFlakeDetectionFaulty = isFaulty
          },
        })
        if (isEarlyFlakeDetectionFaulty) {
          isEarlyFlakeDetectionEnabled = false
          log.warn('New test detection is disabled because the number of new tests is too high.')
        } else {
          knownTestsBySuite = knownTests.vitest
          shouldSendTestProperties = true
          setProvidedContext(ctx, {
            _ddIsKnownTestsEnabled: isKnownTestsEnabled,
            _ddIsEarlyFlakeDetectionEnabled: isEarlyFlakeDetectionEnabled,
            _ddEarlyFlakeDetectionNumRetries:
              getConfiguredEfdRetryCount(earlyFlakeDetectionSlowTestRetries, earlyFlakeDetectionNumRetries),
            _ddEarlyFlakeDetectionSlowTestRetries: earlyFlakeDetectionSlowTestRetries,
          }, 'Could not send known tests to workers so Early Flake Detection will not work.')
        }
      } else {
        isEarlyFlakeDetectionFaulty = true
        isEarlyFlakeDetectionEnabled = false
      }
    }
  }

  if (isDiEnabled) {
    setProvidedContext(ctx, {
      _ddIsDiEnabled: isDiEnabled,
    }, 'Could not send Dynamic Instrumentation configuration to workers.')
  }

  if (isTestManagementTestsEnabled) {
    const { err, testManagementTests: receivedTestManagementTests } =
      testManagementTestsResponse || await getChannelPromise(testManagementTestsCh)
    if (err) {
      isTestManagementTestsEnabled = false
      log.error('Could not get test management tests.')
    } else {
      testManagementTestsBySuite = getTestManagementTestsBySuite(receivedTestManagementTests)
      shouldSendTestProperties = true
      setProvidedContext(ctx, {
        _ddIsTestManagementTestsEnabled: isTestManagementTestsEnabled,
        _ddTestManagementAttemptToFixRetries: testManagementAttemptToFixRetries,
      }, 'Could not send test management tests to workers so Test Management will not work.')
    }
  }

  if (isImpactedTestsEnabled) {
    const { err, modifiedFiles } = await getChannelPromise(modifiedFilesCh)
    if (err) {
      log.error('Could not get modified tests.')
    } else {
      impactedTestSuites = getImpactedTestSuites(modifiedFiles)
      shouldSendTestProperties = true
      setProvidedContext(ctx, {
        _ddIsImpactedTestsEnabled: isImpactedTestsEnabled,
      }, 'Could not send modified tests to workers so Impacted Tests will not work.')
    }
  }

  if (shouldSendTestProperties) {
    setProvidedContext(ctx, {
      _ddTestPropertiesByFilepath: getTestPropertiesByFilepath(
        await getCurrentTestFilepaths(),
        repositoryRoot,
        knownTestsBySuite,
        testManagementTestsBySuite,
        impactedTestSuites
      ),
    }, 'Could not send test properties to workers so some Test Optimization features will not work.')
  }

  wrapCoverageProvider(ctx)
  wrapSessionFinish(ctx)
}

function ensureMainProcessSetup (ctx, frameworkVersion, testSpecifications) {
  const specificationsKey = getTestSpecificationsKey(testSpecifications)
  let setupState = mainProcessSetupStates.get(ctx)
  if (!setupState || setupState.specificationsKey !== specificationsKey) {
    setupState = {
      setupPromise: runMainProcessSetup(ctx, frameworkVersion, testSpecifications),
      specificationsKey,
    }
    mainProcessSetupStates.set(ctx, setupState)
  }
  return setupState.setupPromise
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
    await ensureMainProcessSetup(this.ctx, frameworkVersion, arguments[0])
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

    let onFinish

    const flushPromise = new Promise(resolve => {
      onFinish = resolve
    })
    const failedSuites = this.state.getFailedFilepaths()
    let error
    if (failedSuites.length) {
      error = new Error(`Test suites failed: ${failedSuites.length}.`)
    }

    testSessionFinishCh.publish({
      status: getSessionStatus(this.state),
      testCodeCoverageLinesTotal,
      error,
      isEarlyFlakeDetectionEnabled,
      isEarlyFlakeDetectionFaulty,
      isTestManagementTestsEnabled,
      vitestPool,
      onFinish,
    })

    logTestOptimizationSummary({ attemptToFixExecutions, newTestsWithDynamicNames })

    await flushPromise

    // If coverage was generated, publish coverage report channel for upload
    if (coverageRootDir && codeCoverageReportCh.hasSubscribers) {
      await new Promise((resolve) => {
        codeCoverageReportCh.publish({ rootDir: coverageRootDir, onDone: resolve })
      })
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

function getTestSpecificationProject (testSpecification) {
  if (Array.isArray(testSpecification)) {
    return testSpecification[0]
  }
  return testSpecification?.project
}

function getTestSpecificationPool (testSpecification) {
  const project = getTestSpecificationProject(testSpecification)
  return project?.config?.pool || project?.serializedConfig?.pool || project?.pool || testSpecification?.pool
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

function shouldMarkVitestWorkerEnv (pool, testSpecifications) {
  return isVitestWorkerPool(pool) || hasVitestWorkerPoolTestSpecification(testSpecifications) ||
    (!testSpecifications && pool === undefined)
}

function markVitestWorkerEnv (ctx, testSpecifications) {
  const config = ctx?.config
  if (!config || !shouldMarkVitestWorkerEnv(config.pool, testSpecifications)) {
    return
  }
  config.env = getVitestWorkerEnv(config.env)
}

function wrapVitestRunFiles (Vitest, frameworkVersion) {
  if (!Vitest?.prototype?.runFiles) {
    return
  }

  shimmer.wrap(Vitest.prototype, 'runFiles', runFiles => async function (testSpecifications) {
    markVitestWorkerEnv(this, testSpecifications)
    await ensureMainProcessSetup(this, frameworkVersion, testSpecifications)
    return runFiles.apply(this, arguments)
  })

  if (Vitest.prototype.collectTests) {
    shimmer.wrap(Vitest.prototype, 'collectTests', collectTests => function () {
      markVitestWorkerEnv(this)
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
      testPropertiesByFilepath: providedContext._ddTestPropertiesByFilepath || {},
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

function reportTypecheckTest (task, testSuiteAbsolutePath, providedContext) {
  const testName = getTypecheckTestName(task, testSuiteAbsolutePath)
  const testProperties = getVitestTestProperties(providedContext, testSuiteAbsolutePath, testName)
  const isAttemptToFix = testProperties.isAttemptToFix === true
  const isDisabled = testProperties.isDisabled === true
  const isQuarantined = testProperties.isQuarantined === true
  const isModified = testProperties.isModified === true
  const isSkippedByTestManagement = !isAttemptToFix && isDisabled
  const status = getTypecheckTaskStatus(task)

  if (status === 'skip' || isSkippedByTestManagement) {
    testSkipCh.publish({
      testName,
      testSuiteAbsolutePath,
      isNew: testProperties.isNew,
      isDisabled,
    })
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
  }
  testSuiteStartCh.runStores(testSuiteCtx, () => {})

  for (const task of getTypeTasks(file.tasks)) {
    reportTypecheckTest(task, testSuiteAbsolutePath, providedContext)
  }

  let onFinish
  const onFinishPromise = new Promise(resolve => {
    onFinish = resolve
  })
  testSuiteFinishCh.publish({
    status: getTypecheckTaskStatus(file),
    onFinish,
    ...testSuiteCtx.currentStore,
  })
  await onFinishPromise
}

async function reportTypecheckResults (result, frameworkVersion, ctx) {
  if (!testSuiteFinishCh.hasSubscribers) return
  if (!Array.isArray(result?.files)) return

  if (ctx) {
    await ensureMainProcessSetup(ctx, frameworkVersion, result.files)
  }
  const providedContext = getMainProcessProvidedContext(ctx)
  const sessionConfiguration = testSessionConfigurationCh.hasSubscribers
    ? await getChannelPromise(testSessionConfigurationCh, frameworkVersion)
    : {}

  await Promise.all(result.files.map(file => reportTypecheckFile(
    file,
    sessionConfiguration,
    frameworkVersion,
    providedContext
  )))
}

function wrapTypechecker (Typechecker, frameworkVersion) {
  if (!Typechecker?.prototype?.prepareResults) return

  shimmer.wrap(Typechecker.prototype, 'prepareResults', prepareResults => async function () {
    const result = await prepareResults.apply(this, arguments)
    await reportTypecheckResults(result, frameworkVersion, getTypecheckerVitestContext(this))
    return result
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

  options.env = getVitestWorkerEnv(options.env)
}

function getVitestWorkerEnv (env = {}) {
  return {
    ...env,
    DD_VITEST_WORKER: '1',
  }
}

function wrapTinyPoolRun (TinyPool) {
  if (!TinyPool?.prototype?.run) return

  shimmer.wrap(TinyPool.prototype, 'run', run => async function () {
    // We have to do this before and after because the threads list gets recycled, that is, the processes are re-created
    // eslint-disable-next-line unicorn/no-array-for-each
    this.threads.forEach(threadHandler)
    const runResult = await run.apply(this, arguments)
    // eslint-disable-next-line unicorn/no-array-for-each
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
        if (handleWorkerReport(interprocessCode, data)) {
          // If we execute the callback vitest crashes, as the message is not supported
          return
        }
      }
      return callback.apply(this, arguments)
    })
    return on.apply(this, arguments)
  }
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

  if (interprocessCode === VITEST_WORKER_LOGS_PAYLOAD_CODE) {
    workerReportLogsCh.publish(data)
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
  wrapMessagePortOn()

  const vitest = getVitestExport(cliApiPackage)
  if (vitest) {
    wrapVitestRunFiles(vitest.value, frameworkVersion)
  }

  const forksPoolWorker = getForksPoolWorkerExport(cliApiPackage)
  if (forksPoolWorker) {
    // function is async
    shimmer.wrap(forksPoolWorker.value.prototype, 'start', start => function (...args) {
      vitestPool = 'child_process'
      this.env = getVitestWorkerEnv(this.env)

      return start.apply(this, args)
    })
    shimmer.wrap(forksPoolWorker.value.prototype, 'on', getWrappedOn)
  }

  const threadsPoolWorker = getThreadsPoolWorkerExport(cliApiPackage)
  if (threadsPoolWorker) {
    // function is async
    shimmer.wrap(threadsPoolWorker.value.prototype, 'start', start => function (...args) {
      vitestPool = 'worker_threads'
      this.env = getVitestWorkerEnv(this.env)
      return start.apply(this, args)
    })
    shimmer.wrap(threadsPoolWorker.value.prototype, 'on', getWrappedOn)
  }
  return cliApiPackage
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
}, (vitestPackage) => {
  if (isReporterPackage(vitestPackage)) {
    shimmer.wrap(vitestPackage.B.prototype, 'sort', getSortWrapper)
  }

  return vitestPackage
})

addHook({
  name: 'vitest',
  versions: ['>=2.0.0 <2.0.5'],
  filePattern: 'dist/vendor/index.*',
}, (vitestPackage) => {
  if (isReporterPackageNew(vitestPackage)) {
    shimmer.wrap(vitestPackage.e.prototype, 'sort', getSortWrapper)
  }

  return vitestPackage
})

addHook({
  name: 'vitest',
  versions: ['>=2.0.5 <2.1.0'],
  filePattern: 'dist/chunks/index.*',
}, (vitestPackage) => {
  if (isReporterPackageNewest(vitestPackage)) {
    shimmer.wrap(vitestPackage.h.prototype, 'sort', getSortWrapper)
  }

  return vitestPackage
})

addHook({
  name: 'vitest',
  versions: ['>=4.0.0'],
  filePattern: 'dist/chunks/index.*',
}, (vitestPackage, frameworkVersion) => {
  const typechecker = getTypecheckerExport(vitestPackage)
  if (typechecker) {
    wrapTypechecker(typechecker.value, frameworkVersion)
  }
  return vitestPackage
})

addHook({
  name: 'vitest',
  versions: ['>=2.1.0 <3.0.0'],
  filePattern: 'dist/chunks/RandomSequencer.*',
}, (randomSequencerPackage) => {
  shimmer.wrap(randomSequencerPackage.B.prototype, 'sort', getSortWrapper)
  return randomSequencerPackage
})

addHook({
  name: 'vitest',
  versions: ['>=3.0.9'],
  filePattern: 'dist/chunks/coverage.*',
}, (coveragePackage) => {
  const baseSequencer = getBaseSequencerExport(coveragePackage)
  if (baseSequencer) {
    shimmer.wrap(baseSequencer.value.prototype, 'sort', getSortWrapper)
  }
  return coveragePackage
})

addHook({
  name: 'vitest',
  versions: ['>=3.0.0 <3.0.9'],
  filePattern: 'dist/chunks/resolveConfig.*',
}, (resolveConfigPackage) => {
  shimmer.wrap(resolveConfigPackage.B.prototype, 'sort', getSortWrapper)
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
