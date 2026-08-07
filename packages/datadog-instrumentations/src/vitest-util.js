'use strict'

const fs = require('node:fs')

const log = require('../../dd-trace/src/log')
const {
  EMPTY_EFD_RETRY_POLICY,
  hasEfdRetries,
} = require('../../dd-trace/src/ci-visibility/efd-retry-policy')
const { channel } = require('./helpers/instrument')

// test hooks
const testStartCh = channel('ci:vitest:test:start')
const testFinishTimeCh = channel('ci:vitest:test:finish-time')
const testPassCh = channel('ci:vitest:test:pass')
const testErrorCh = channel('ci:vitest:test:error')
const testDiWaitCh = channel('ci:vitest:test:di:wait')
const testSkipCh = channel('ci:vitest:test:skip')
const testFnCh = channel('ci:vitest:test:fn')

// test suite hooks
const testSuiteStartCh = channel('ci:vitest:test-suite:start')
const testSuiteFinishCh = channel('ci:vitest:test-suite:finish')
const testSuiteErrorCh = channel('ci:vitest:test-suite:error')

// test session hooks
const testSessionStartCh = channel('ci:vitest:session:start')
const testSessionFinishCh = channel('ci:vitest:session:finish')
const testSessionConfigurationCh = channel('ci:vitest:session:configuration')
const libraryConfigurationCh = channel('ci:vitest:library-configuration')
const knownTestsCh = channel('ci:vitest:known-tests')
const testManagementTestsCh = channel('ci:vitest:test-management-tests')
const modifiedFilesCh = channel('ci:vitest:modified-files')

const CLOSING_SCRIPT_TAG_RE = /<\/script/i
const SERIALIZED_CONTEXT_PREFIX = '\u0000dd-vitest-context:'

const workerReportTraceCh = channel('ci:vitest:worker-report:trace')
const workerReportCoverageCh = channel('ci:vitest:worker-report:coverage')
const workerReportLogsCh = channel('ci:vitest:worker-report:logs')
const workerReportTelemetryCh = channel('ci:vitest:worker-report:telemetry')
const codeCoverageReportCh = channel('ci:vitest:coverage-report')

/**
 * Resolves a path without failing Test Optimization when the path is unavailable.
 *
 * @param {string} filepath
 * @returns {string}
 */
function realpath (filepath) {
  try {
    return fs.realpathSync(filepath)
  } catch {
    return filepath
  }
}

function findExportByName (pkg, name) {
  for (const [key, value] of Object.entries(pkg)) {
    if (value?.name === name) {
      return { key, value }
    }
  }
}

function getTestRunnerExport (testPackage) {
  return findExportByName(testPackage, 'VitestTestRunner') || findExportByName(testPackage, 'TestRunner')
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
  let testName = task.name
  let currentTask = task.suite

  while (currentTask) {
    if (currentTask.name) {
      testName = `${currentTask.name} ${testName}`
    }
    currentTask = currentTask.suite
  }

  return testName
}

function getWorkspaceProject (ctx) {
  return ctx.getCoreWorkspaceProject
    ? ctx.getCoreWorkspaceProject()
    : ctx.getRootProject()
}

function setProvidedContext (ctx, values, warningMessage) {
  try {
    const providedContext = getWorkspaceProject(ctx)._provided
    for (const key of Object.keys(values)) {
      providedContext[key] = key.startsWith('_dd')
        ? makeProvidedContextBrowserSafe(values[key])
        : values[key]
    }
  } catch {
    log.warn(warningMessage)
  }
}

/**
 * Prevent Vitest Browser Mode from terminating its inline bootstrap script with Datadog metadata.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function makeProvidedContextBrowserSafe (value) {
  if (typeof value !== 'string' && (typeof value !== 'object' || value === null)) return value
  if (typeof value === 'string' && !CLOSING_SCRIPT_TAG_RE.test(value)) return value

  const serializedValue = JSON.stringify(value)
  return CLOSING_SCRIPT_TAG_RE.test(serializedValue)
    ? SERIALIZED_CONTEXT_PREFIX + serializedValue.replaceAll('<', String.raw`\u003c`)
    : value
}

/**
 * Restore context serialized by makeProvidedContextBrowserSafe.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function parseProvidedContextValue (value) {
  if (typeof value !== 'string' || !value.startsWith(SERIALIZED_CONTEXT_PREFIX)) return value

  let parsedValue
  try {
    parsedValue = JSON.parse(value.slice(SERIALIZED_CONTEXT_PREFIX.length))
  } catch {}
  return parsedValue
}

/**
 * Restores Datadog context values serialized for Vitest Browser Mode.
 *
 * @param {Record<string, unknown>} values
 * @returns {Record<string, unknown>}
 */
function parseProvidedContextValues (values) {
  const parsedValues = {}
  for (const key of Object.keys(values)) {
    if (key.startsWith('_dd')) {
      parsedValues[key] = parseProvidedContextValue(values[key])
    }
  }
  return parsedValues
}

function getProvidedContext () {
  try {
    const {
      _ddIsEarlyFlakeDetectionEnabled,
      _ddIsEfdSuiteAdmissionEnabled: isEfdSuiteAdmissionEnabled,
      _ddIsDiEnabled,
      _ddTestPropertiesByFilepath,
      _ddEarlyFlakeDetectionRetryPolicy: earlyFlakeDetectionRetryPolicy,
      _ddIsKnownTestsEnabled: isKnownTestsEnabled,
      _ddIsTestManagementTestsEnabled: isTestManagementTestsEnabled,
      _ddTestManagementAttemptToFixRetries: testManagementAttemptToFixRetries,
      _ddIsFlakyTestRetriesEnabled: isFlakyTestRetriesEnabled,
      _ddFlakyTestRetriesCount: flakyTestRetriesCount,
      _ddFlakyTestRetriesIncludesUnnamedProject: flakyTestRetriesIncludesUnnamedProject,
      _ddFlakyTestRetriesProjectNames: flakyTestRetriesProjectNames,
      _ddIsImpactedTestsEnabled: isImpactedTestsEnabled,
      _ddTestSessionId: testSessionId,
      _ddTestModuleId: testModuleId,
      _ddTestCommand: testCommand,
      _ddRepositoryRoot: repositoryRoot,
      _ddCodeOwnersEntries: codeOwnersEntries,
      _ddIsCodeCoverageEnabled: isCodeCoverageEnabled,
      _ddItrCorrelationId: itrCorrelationId,
      _ddUnskippableSuites: unskippableSuites,
      _ddForcedToRunSuites: forcedToRunSuites,
    } = parseProvidedContextValues(globalThis.__vitest_worker__.providedContext)
    const retryPolicy = earlyFlakeDetectionRetryPolicy ?? EMPTY_EFD_RETRY_POLICY
    const testPropertiesByFilepath = _ddTestPropertiesByFilepath || {}

    return {
      isDiEnabled: _ddIsDiEnabled,
      isEfdSuiteAdmissionEnabled,
      isEarlyFlakeDetectionEnabled: _ddIsEarlyFlakeDetectionEnabled && hasEfdRetries(retryPolicy),
      testPropertiesByFilepath,
      earlyFlakeDetectionRetryPolicy: retryPolicy,
      isKnownTestsEnabled,
      isTestManagementTestsEnabled,
      testManagementAttemptToFixRetries,
      isFlakyTestRetriesEnabled,
      flakyTestRetriesCount: flakyTestRetriesCount ?? 0,
      flakyTestRetriesIncludesUnnamedProject,
      flakyTestRetriesProjectNames,
      isImpactedTestsEnabled,
      testSessionId,
      testModuleId,
      testCommand,
      repositoryRoot,
      codeOwnersEntries,
      isCodeCoverageEnabled,
      itrCorrelationId,
      unskippableSuites,
      forcedToRunSuites,
    }
  } catch {
    log.error('Vitest workers could not parse provided context, so some features will not work.')
    return {
      isDiEnabled: false,
      isEfdSuiteAdmissionEnabled: false,
      isEarlyFlakeDetectionEnabled: false,
      testPropertiesByFilepath: {},
      earlyFlakeDetectionRetryPolicy: EMPTY_EFD_RETRY_POLICY,
      isKnownTestsEnabled: false,
      isTestManagementTestsEnabled: false,
      testManagementAttemptToFixRetries: 0,
      isFlakyTestRetriesEnabled: false,
      flakyTestRetriesCount: 0,
      flakyTestRetriesIncludesUnnamedProject: false,
      flakyTestRetriesProjectNames: undefined,
      isImpactedTestsEnabled: false,
      testSessionId: undefined,
      testModuleId: undefined,
      testCommand: undefined,
      repositoryRoot: undefined,
      codeOwnersEntries: undefined,
      isCodeCoverageEnabled: false,
      itrCorrelationId: undefined,
      unskippableSuites: {},
      forcedToRunSuites: {},
    }
  }
}

function isFlakyTestRetriesEnabledForTask (providedContext, task) {
  if (!providedContext.isFlakyTestRetriesEnabled) return false

  const { flakyTestRetriesProjectNames } = providedContext
  if (!Array.isArray(flakyTestRetriesProjectNames)) return true

  const projectName = task.file?.projectName
  if (!projectName) {
    return providedContext.flakyTestRetriesIncludesUnnamedProject === true
  }

  return flakyTestRetriesProjectNames.includes(projectName)
}

/**
 * Return the main-prepared Test Optimization metadata for a Vitest test.
 *
 * @param {{ testPropertiesByFilepath?: Record<string, {
 *   testSuite?: string,
 *   knownTests?: string[],
 *   testManagementTests?: Record<string, {
 *     isAttemptToFix?: boolean,
 *     isDisabled?: boolean,
 *     isQuarantined?: boolean
 *   }>,
 *   isModified?: boolean
 * }> }} providedContext
 * @param {string} testSuiteAbsolutePath
 * @param {string} testName
 * @returns {{
 *   testSuite?: string,
 *   isNew: boolean,
 *   isModified: boolean,
 *   isAttemptToFix?: boolean,
 *   isDisabled?: boolean,
 *   isQuarantined?: boolean
 * }}
 */
function getVitestTestProperties (providedContext, testSuiteAbsolutePath, testName) {
  const testProperties = providedContext.testPropertiesByFilepath?.[testSuiteAbsolutePath]
  const knownTests = testProperties?.knownTests
  const testManagementProperties = testProperties?.testManagementTests?.[testName] || {}

  return {
    testSuite: testProperties?.testSuite,
    isNew: Array.isArray(knownTests) ? !knownTests.includes(testName) : false,
    isModified: testProperties?.isModified === true,
    isAttemptToFix: testManagementProperties.isAttemptToFix,
    isDisabled: testManagementProperties.isDisabled,
    isQuarantined: testManagementProperties.isQuarantined,
  }
}

module.exports = {
  testStartCh,
  testFinishTimeCh,
  testPassCh,
  testErrorCh,
  testDiWaitCh,
  testSkipCh,
  testFnCh,
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
  getTestRunnerExport,
  getTypeTasks,
  getTestName,
  getWorkspaceProject,
  setProvidedContext,
  parseProvidedContextValue,
  getProvidedContext,
  isFlakyTestRetriesEnabledForTask,
  getVitestTestProperties,
}
