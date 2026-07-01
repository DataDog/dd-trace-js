'use strict'

const log = require('../../dd-trace/src/log')
const { channel } = require('./helpers/instrument')

// test hooks
const testStartCh = channel('ci:vitest:test:start')
const testFinishTimeCh = channel('ci:vitest:test:finish-time')
const testPassCh = channel('ci:vitest:test:pass')
const testErrorCh = channel('ci:vitest:test:error')
const testSkipCh = channel('ci:vitest:test:skip')
const isNewTestCh = channel('ci:vitest:test:is-new')
const isAttemptToFixCh = channel('ci:vitest:test:is-attempt-to-fix')
const isDisabledCh = channel('ci:vitest:test:is-disabled')
const isQuarantinedCh = channel('ci:vitest:test:is-quarantined')
const isModifiedCh = channel('ci:vitest:test:is-modified')
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

function getChannelPromise (channelToPublishTo, frameworkVersion) {
  return new Promise(resolve => {
    channelToPublishTo.publish({ onDone: resolve, frameworkVersion })
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
      _ddKnownTests: knownTests,
      _ddEarlyFlakeDetectionNumRetries: numRepeats,
      _ddEarlyFlakeDetectionSlowTestRetries: slowTestRetries,
      _ddIsKnownTestsEnabled: isKnownTestsEnabled,
      _ddIsTestManagementTestsEnabled: isTestManagementTestsEnabled,
      _ddTestManagementAttemptToFixRetries: testManagementAttemptToFixRetries,
      _ddTestManagementTests: testManagementTests,
      _ddIsFlakyTestRetriesEnabled: isFlakyTestRetriesEnabled,
      _ddFlakyTestRetriesCount: flakyTestRetriesCount,
      _ddFlakyTestRetriesIncludesUnnamedProject: flakyTestRetriesIncludesUnnamedProject,
      _ddFlakyTestRetriesProjectNames: flakyTestRetriesProjectNames,
      _ddIsImpactedTestsEnabled: isImpactedTestsEnabled,
      _ddModifiedFiles: modifiedFiles,
      _ddTestSessionId: testSessionId,
      _ddTestModuleId: testModuleId,
      _ddTestCommand: testCommand,
      _ddRepositoryRoot: repositoryRoot,
      _ddCodeOwnersEntries: codeOwnersEntries,
    } = globalThis.__vitest_worker__.providedContext

    return {
      isDiEnabled: _ddIsDiEnabled,
      isEarlyFlakeDetectionEnabled: _ddIsEarlyFlakeDetectionEnabled,
      knownTests,
      numRepeats,
      slowTestRetries: slowTestRetries ?? {},
      isKnownTestsEnabled,
      isTestManagementTestsEnabled,
      testManagementAttemptToFixRetries,
      testManagementTests,
      isFlakyTestRetriesEnabled,
      flakyTestRetriesCount: flakyTestRetriesCount ?? 0,
      flakyTestRetriesIncludesUnnamedProject,
      flakyTestRetriesProjectNames,
      isImpactedTestsEnabled,
      modifiedFiles,
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
      knownTests: {},
      numRepeats: 0,
      slowTestRetries: {},
      isKnownTestsEnabled: false,
      isTestManagementTestsEnabled: false,
      testManagementAttemptToFixRetries: 0,
      testManagementTests: {},
      isFlakyTestRetriesEnabled: false,
      flakyTestRetriesCount: 0,
      flakyTestRetriesIncludesUnnamedProject: false,
      flakyTestRetriesProjectNames: undefined,
      isImpactedTestsEnabled: false,
      modifiedFiles: {},
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

module.exports = {
  testStartCh,
  testFinishTimeCh,
  testPassCh,
  testErrorCh,
  testSkipCh,
  isNewTestCh,
  isAttemptToFixCh,
  isDisabledCh,
  isQuarantinedCh,
  isModifiedCh,
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
}
