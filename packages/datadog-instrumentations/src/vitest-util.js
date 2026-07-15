'use strict'

const log = require('../../dd-trace/src/log')
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
const isEarlyFlakeDetectionFaultyCh = channel('ci:vitest:is-early-flake-detection-faulty')
const testManagementTestsCh = channel('ci:vitest:test-management-tests')
const modifiedFilesCh = channel('ci:vitest:modified-files')

const workerReportTraceCh = channel('ci:vitest:worker-report:trace')
const workerReportLogsCh = channel('ci:vitest:worker-report:logs')
const codeCoverageReportCh = channel('ci:vitest:coverage-report')

function findExportByName (pkg, name) {
  for (const [key, value] of Object.entries(pkg)) {
    if (value?.name === name) {
      return { key, value }
    }
  }
}

function getChannelPromise (channelToPublishTo, frameworkVersion, payload) {
  return new Promise(resolve => {
    channelToPublishTo.publish({ ...payload, onDone: resolve, frameworkVersion })
  })
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
    Object.assign(getWorkspaceProject(ctx)._provided, values)
  } catch {
    log.warn(warningMessage)
  }
}

function getProvidedContext () {
  try {
    const {
      _ddIsEarlyFlakeDetectionEnabled,
      _ddIsDiEnabled,
      _ddTestPropertiesByFilepath: testPropertiesByFilepath,
      _ddEarlyFlakeDetectionNumRetries: numRepeats,
      _ddEarlyFlakeDetectionSlowTestRetries: slowTestRetries,
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
    } = globalThis.__vitest_worker__.providedContext

    return {
      isDiEnabled: _ddIsDiEnabled,
      isEarlyFlakeDetectionEnabled: _ddIsEarlyFlakeDetectionEnabled,
      testPropertiesByFilepath,
      numRepeats,
      slowTestRetries: slowTestRetries ?? {},
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
    }
  } catch {
    log.error('Vitest workers could not parse provided context, so some features will not work.')
    return {
      isDiEnabled: false,
      isEarlyFlakeDetectionEnabled: false,
      testPropertiesByFilepath: {},
      numRepeats: 0,
      slowTestRetries: {},
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
  isEarlyFlakeDetectionFaultyCh,
  testManagementTestsCh,
  modifiedFilesCh,
  workerReportTraceCh,
  workerReportLogsCh,
  codeCoverageReportCh,
  findExportByName,
  getChannelPromise,
  getTestRunnerExport,
  getTypeTasks,
  getTestName,
  getWorkspaceProject,
  setProvidedContext,
  getProvidedContext,
  isFlakyTestRetriesEnabledForTask,
  getVitestTestProperties,
}
