'use strict'

const path = require('node:path')

const satisfies = require('../../../vendor/dist/semifies')

const log = require('../../dd-trace/src/log')
const {
  DYNAMIC_NAME_RE,
  getTestSuitePath,
  logAttemptToFixTestExecution,
  recordAttemptToFixExecution,
} = require('../../dd-trace/src/plugins/util/test')
const { isTrue } = require('../../dd-trace/src/util')
const {
  getTestName,
  getTypeTasks,
  getWorkspaceProject,
  isFlakyTestRetriesEnabledForTask,
  setProvidedContext,
  testErrorCh,
  testFinishTimeCh,
  testPassCh,
  testSkipCh,
  testStartCh,
  testSuiteErrorCh,
  testSuiteFinishCh,
  testSuiteStartCh,
} = require('./vitest-util')

const mainProcessReporterStates = new WeakMap()
const loggedAttemptToFixTests = new Set()

const DATADOG_TEST_OPTIMIZATION_BOOTSTRAPS = new Set([
  'dd-trace/register.js',
  'dd-trace/ci/init',
  'dd-trace/ci/init.js',
])
const DATADOG_TEST_OPTIMIZATION_NODE_OPTION_FLAGS = new Set(['--import', '--require', '-r'])
const VITEST_NO_WORKER_INIT_ACTIVE_ENV = 'DD_TEST_OPT_VITEST_NO_WORKER_INIT_ACTIVE'
const VITEST_NO_WORKER_INIT_REQUEST_ENV = 'DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT'
const VITEST_NO_WORKER_INIT_MINIMUM_VERSION = '3.2.6'
const VITEST_NO_WORKER_INIT_SETUP_FILE = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'ci',
  'vitest-no-worker-init-setup.mjs'
)
const NODE_OPTIONS_QUOTE_RE = /[\s"\\]/
let hasWarnedUnsupportedVersion = false

function noop () {}

function isRequested () {
  // eslint-disable-next-line eslint-rules/eslint-process-env
  return isTrue(process.env[VITEST_NO_WORKER_INIT_REQUEST_ENV])
}

function shouldUse (ctx, frameworkVersion, testSpecifications, options) {
  if (!isRequested()) return false
  if (!isSupportedVersion(frameworkVersion)) {
    warnUnsupportedVersion(frameworkVersion)
    return false
  }

  const config = ctx?.config
  if (!config || config.isolate === false) return false

  const { hasVitestWorkerPoolTestSpecification, isVitestWorkerPool } = options
  return isVitestWorkerPool(config.pool) ||
    config.pool === undefined ||
    hasVitestWorkerPoolTestSpecification(testSpecifications)
}

function isSupportedVersion (frameworkVersion) {
  return !!frameworkVersion && satisfies(frameworkVersion, `>=${VITEST_NO_WORKER_INIT_MINIMUM_VERSION}`)
}

function warnUnsupportedVersion (frameworkVersion) {
  if (hasWarnedUnsupportedVersion) return

  hasWarnedUnsupportedVersion = true
  log.warn(
    '%s is only supported for vitest >=%s. Falling back to normal Vitest worker instrumentation for vitest %s.',
    VITEST_NO_WORKER_INIT_REQUEST_ENV,
    VITEST_NO_WORKER_INIT_MINIMUM_VERSION,
    frameworkVersion || 'unknown'
  )
}

function configure (ctx, frameworkVersion, testSpecifications, setupData, options) {
  const { getConfiguredEfdRetryCount, state } = options
  addSetupFileToVitestConfigs(ctx, VITEST_NO_WORKER_INIT_SETUP_FILE, testSpecifications)

  const {
    knownTestsBySuite,
    modifiedFiles,
    repositoryRoot,
    testManagementTestsBySuite,
    testSessionConfiguration,
  } = setupData

  setProvidedContext(ctx, {
    _ddVitestWorkerSetup: {
      attemptToFixRetries: state.testManagementAttemptToFixRetries,
      attemptToFixTests: getSelectedTestManagementTests(testManagementTestsBySuite, 'isAttemptToFix'),
      disabledTests: getSelectedTestManagementTests(testManagementTestsBySuite, 'isDisabled'),
      earlyFlakeDetectionRetries: getConfiguredEfdRetryCount(
        state.earlyFlakeDetectionSlowTestRetries,
        state.earlyFlakeDetectionNumRetries
      ),
      earlyFlakeDetectionSlowRetries: state.earlyFlakeDetectionSlowTestRetries,
      isEarlyFlakeDetectionEnabled: state.isEarlyFlakeDetectionEnabled && !state.isEarlyFlakeDetectionFaulty,
      knownTests: knownTestsBySuite || {},
      modifiedFiles: modifiedFiles || {},
      quarantinedTests: getSelectedTestManagementTests(testManagementTestsBySuite, 'isQuarantined'),
      repositoryRoot: repositoryRoot || process.cwd(),
    },
  }, 'Could not send Vitest worker setup context, so no-worker execution changes will not work.')

  installMainProcessReporter(ctx, frameworkVersion, testSessionConfiguration || {}, setupData, state)
}

function configureWorkerEnv (workerEnv, shouldSkipWorkerInit = false) {
  if (!shouldSkipWorkerInit) {
    delete workerEnv[VITEST_NO_WORKER_INIT_ACTIVE_ENV]
    return workerEnv
  }

  workerEnv[VITEST_NO_WORKER_INIT_ACTIVE_ENV] = '1'

  const nodeOptions = removeDatadogTestOptimizationNodeOptions(workerEnv.NODE_OPTIONS)
  if (nodeOptions) {
    workerEnv.NODE_OPTIONS = nodeOptions
  } else {
    delete workerEnv.NODE_OPTIONS
  }
  return workerEnv
}

function addSetupFileToVitestConfigs (ctx, setupFile, testSpecifications) {
  const configs = getNoWorkerInitVitestConfigs(ctx, testSpecifications)

  for (const config of configs) {
    if (!config) continue

    if (config.setupFiles === undefined) {
      config.setupFiles = []
    } else if (typeof config.setupFiles === 'string') {
      config.setupFiles = [config.setupFiles]
    }

    if (!config.setupFiles.includes(setupFile)) {
      config.setupFiles.push(setupFile)
    }
  }
}

function getNoWorkerInitVitestConfigs (ctx, testSpecifications) {
  const configs = new Set()
  if (Array.isArray(testSpecifications)) {
    for (const testSpecification of testSpecifications) {
      const project = getTestSpecificationProject(testSpecification)
      addNoWorkerInitConfig(configs, safeConfig(project))
    }
  }

  addNoWorkerInitConfig(configs, safeConfig(ctx))
  addNoWorkerInitConfig(configs, safeConfig(safeWorkspaceProject(ctx)))
  return configs
}

function addNoWorkerInitConfig (configs, config) {
  if (config) configs.add(config)
}

function getSelectedTestManagementTests (testManagementTestsBySuite, propertyName) {
  if (!testManagementTestsBySuite) return {}

  const selectedTests = {}
  for (const [testSuite, tests] of Object.entries(testManagementTestsBySuite)) {
    for (const [testName, properties] of Object.entries(tests)) {
      if (properties?.[propertyName]) {
        selectedTests[testSuite] ||= {}
        selectedTests[testSuite][testName] = true
      }
    }
  }
  return selectedTests
}

function installMainProcessReporter (ctx, frameworkVersion, testSessionConfiguration, testOptimizationData, state) {
  if (!ctx?.reporters) return

  const reporterState = {
    frameworkVersion,
    state,
    testSessionConfiguration,
    testOptimizationData,
  }
  const installedReporterState = mainProcessReporterStates.get(ctx)
  if (installedReporterState) {
    Object.assign(installedReporterState, reporterState)
    return
  }

  mainProcessReporterStates.set(ctx, reporterState)
  ctx.reporters.push(createMainProcessReporter(reporterState))
}

function createMainProcessReporter (reporterState) {
  const testSuiteContexts = new Map()
  const finishedTestModules = new Set()
  const taskAttemptStatuses = new Map()

  return {
    onTestModuleStart (testModule) {
      startTestSuite(testModule)
    },

    onTestModuleEnd (testModule) {
      return reportTestModule(testModule)
    },

    onTestCaseResult (testCase) {
      const task = getTestCaseTask(testCase)
      recordFinalTaskAttemptResult(task)
    },

    onTaskUpdate (packs, events) {
      if (!events) return

      for (const event of events) {
        if (event[1] === 'test-retried') {
          recordTaskAttemptStatus(event[0], 'fail')
        }
      }
    },

    onFinished (files) {
      if (!files) return

      for (const file of files) {
        const testModule = createTestModuleFromFile(file)
        if (!finishedTestModules.has(file.id)) {
          reportTestModule(testModule)
        }
      }
    },
  }

  function recordTaskAttemptStatus (taskId, status) {
    let statuses = taskAttemptStatuses.get(taskId)
    if (!statuses) {
      statuses = []
      taskAttemptStatuses.set(taskId, statuses)
    }
    statuses.push(status)
  }

  function recordFinalTaskAttemptResult (task) {
    const statuses = taskAttemptStatuses.get(task.id)
    if (!statuses) return

    const attemptCount = getRepeatedAttemptCount(task, statuses)
    if (statuses.length < attemptCount) {
      statuses.push(getFinalRepeatedTaskStatus(task))
    }
  }

  function reportTestModule (testModule) {
    const testModuleId = getTestModuleId(testModule)
    const testModuleTask = getTestModuleTask(testModule)
    finishedTestModules.add(testModuleId)
    const testSuiteCtx = testSuiteContexts.get(testModuleId) || startTestSuite(testModule)
    const testTasks = getTypeTasks(testModuleTask.tasks)
    const testReports = []
    let testSuiteError

    for (const task of testTasks) {
      const testReport = getTestReport(task, testSuiteCtx.currentStore)
      testReports.push(testReport)

      for (const attempt of testReport.nonFinalAttempts) {
        reportTestAttempt(testReport, attempt)
      }
    }

    for (const testReport of testReports) {
      const error = reportFinalTestAttempt(testReport)
      testSuiteError ||= error
    }

    const suiteTaskError = getSuiteTaskError(testModuleTask)
    recomputeTaskState(testModuleTask)
    const testSuiteResult = testModuleTask.result
    if (testSuiteResult?.errors?.length) {
      testSuiteError = testSuiteResult.errors[0]
    } else if (suiteTaskError) {
      testSuiteError = suiteTaskError
    }

    if (testSuiteError) {
      testSuiteCtx.error = testSuiteError
      testSuiteErrorCh.runStores(testSuiteCtx, () => {})
    }

    testSuiteFinishCh.publish({
      status: getDatadogStatus(testSuiteResult),
      deferFlush: true,
      onFinish: noop,
      ...testSuiteCtx.currentStore,
    })
    testSuiteContexts.delete(testModuleId)
  }

  function startTestSuite (testModule) {
    const { frameworkVersion, testSessionConfiguration } = reporterState
    const testModuleId = getTestModuleId(testModule)
    const testSuiteCtx = {
      testSuiteAbsolutePath: getTestModuleFilepath(testModule),
      frameworkVersion,
      testSessionId: testSessionConfiguration.testSessionId,
      testModuleId: testSessionConfiguration.testModuleId,
      testCommand: testSessionConfiguration.testCommand,
      repositoryRoot: testSessionConfiguration.repositoryRoot,
      codeOwnersEntries: testSessionConfiguration.codeOwnersEntries,
      isTestFrameworkWorker: true,
    }
    testSuiteStartCh.runStores(testSuiteCtx, () => {})
    testSuiteContexts.set(testModuleId, testSuiteCtx)
    return testSuiteCtx
  }

  function getTestReport (task, testSuiteStore) {
    const result = task.result
    const testSuiteAbsolutePath = task.file?.filepath
    const testName = getTestName(task)
    const testProperties = getMainProcessTestProperties(task, testSuiteAbsolutePath, testName)
    const { state } = reporterState
    let status = getDatadogStatus(result)

    if (task.meta?.__ddTestOptQuarantinedFailed && testProperties.isQuarantined && !testProperties.isAttemptToFix) {
      status = 'fail'
    }

    if (testProperties.isAttemptToFix && task.meta?.__ddTestOptAtfStatuses?.length) {
      return getRepeatedTestReport(task, testName, testSuiteAbsolutePath, testProperties, status, {
        errorCounts: task.meta.__ddTestOptAtfErrorCounts,
        finalStatus: getAttemptToFixFinalStatus,
        state,
        statuses: task.meta.__ddTestOptAtfStatuses,
        testSuiteStore,
        type: 'attempt_to_fix',
      })
    }

    if (testProperties.isEarlyFlakeDetection && task.meta?.__ddTestOptEfdStatuses?.length) {
      return getRepeatedTestReport(task, testName, testSuiteAbsolutePath, testProperties, status, {
        errorCounts: task.meta.__ddTestOptEfdErrorCounts,
        finalStatus: getEarlyFlakeDetectionFinalStatus,
        state,
        statuses: task.meta.__ddTestOptEfdStatuses,
        testSuiteStore,
        type: 'early_flake_detection',
      })
    }

    if (!testProperties.isAttemptToFix && task.meta?.__ddTestOptRepeatStatuses?.length) {
      return getRepeatedTestReport(task, testName, testSuiteAbsolutePath, testProperties, status, {
        errorCounts: task.meta.__ddTestOptRepeatErrorCounts,
        finalStatus: () => status,
        state,
        statuses: task.meta.__ddTestOptRepeatStatuses,
        testSuiteStore,
        type: 'external',
      })
    }

    const attemptStatuses = taskAttemptStatuses.get(task.id)
    if (!testProperties.isAttemptToFix && !testProperties.isEarlyFlakeDetection && attemptStatuses?.length > 1) {
      return getRepeatedTestReport(task, testName, testSuiteAbsolutePath, testProperties, status, {
        finalStatus: () => status,
        state,
        statuses: attemptStatuses,
        testSuiteStore,
        type: 'external',
      })
    }

    if (!testProperties.isAttemptToFix && task.result?.repeatCount > 0) {
      return getRepeatedTestReport(task, testName, testSuiteAbsolutePath, testProperties, status, {
        finalStatus: () => status,
        state,
        statuses: getRepeatedTaskStatuses(task, status),
        testSuiteStore,
        type: 'external',
      })
    }

    if (testProperties.isAttemptToFix) {
      logAttemptToFixTestExecution(testProperties.testSuite, testName, loggedAttemptToFixTests)
    }

    if (testProperties.isDisabled && !testProperties.isAttemptToFix) {
      status = 'skip'
      if (result) result.state = 'skip'
    } else if (testProperties.isQuarantined && status === 'fail' && !testProperties.isAttemptToFix) {
      result.state = 'pass'
    }

    const errors = result?.errors || []
    const finalErrorIndex = status === 'fail' ? errors.length - 1 : -1
    const nonFinalAttempts = []

    if (status !== 'skip') {
      for (let index = 0; index < errors.length; index++) {
        if (index === finalErrorIndex) continue
        nonFinalAttempts.push({
          error: errors[index],
          isRetry: index > 0,
          status: 'fail',
        })
      }
    }

    return {
      errors,
      nonFinalAttempts,
      state,
      status,
      task,
      testName,
      testProperties,
      testSuiteAbsolutePath,
      testSuiteStore,
    }
  }

  function getMainProcessTestProperties (task, testSuiteAbsolutePath, testName) {
    const { state, testOptimizationData, testSessionConfiguration } = reporterState
    const testProperties = testOptimizationData.testPropertiesByFilepath?.[testSuiteAbsolutePath]
    const testSuite = testProperties?.testSuite || getTestSuitePath(
      testSuiteAbsolutePath,
      testSessionConfiguration.repositoryRoot || process.cwd()
    )
    const knownTests = testProperties?.knownTests
    const testManagementProperties = testProperties?.testManagementTests?.[testName] || {}
    const isAttemptToFix = testManagementProperties.isAttemptToFix
    const isNew = !!(
      !isAttemptToFix &&
      state.isKnownTestsEnabled &&
      knownTests &&
      !state.isEarlyFlakeDetectionFaulty &&
      !knownTests.includes(testName)
    )
    const isModified = testProperties?.isModified === true
    const { flakyTestRetriesConfiguration } = testOptimizationData
    const isFlakyTestRetries = !!flakyTestRetriesConfiguration && isFlakyTestRetriesEnabledForTask({
      isFlakyTestRetriesEnabled: state.isFlakyTestRetriesEnabled,
      flakyTestRetriesIncludesUnnamedProject: flakyTestRetriesConfiguration.includesUnnamedProject,
      flakyTestRetriesProjectNames: flakyTestRetriesConfiguration.projectNames,
    }, task)

    return {
      isAttemptToFix,
      isDisabled: testManagementProperties.isDisabled,
      isEarlyFlakeDetection: (isNew || isModified) && state.isEarlyFlakeDetectionEnabled,
      isFlakyTestRetries,
      isQuarantined: testManagementProperties.isQuarantined,
      isModified,
      isNew,
      testSuite,
      hasDynamicName: isNew && DYNAMIC_NAME_RE.test(testName),
    }
  }
}

function createTestModuleFromFile (file) {
  return {
    id: file.id,
    moduleId: file.filepath,
    project: file.project,
    projectName: file.projectName,
    task: file,
  }
}

function getTestModuleId (testModule) {
  return testModule.id || getTestModuleFilepath(testModule)
}

function getTestModuleTask (testModule) {
  if (testModule.task?.tasks) {
    return testModule.task
  }

  const task = createTaskFromReportedTask(testModule)
  task.file = task
  return task
}

function getTestCaseTask (testCase) {
  if (testCase.task) {
    return testCase.task
  }

  return createTaskFromReportedTask(testCase, {
    filepath: getTestModuleFilepath(testCase.module),
    projectName: getTestModuleProjectName(testCase.module),
  })
}

function createTaskFromReportedTask (reportedTask, file, suite) {
  const task = {
    id: reportedTask.id,
    type: reportedTask.type,
    name: reportedTask.name || reportedTask.relativeModuleId || reportedTask.moduleId,
    mode: reportedTask.options?.mode,
    meta: getReportedTaskMeta(reportedTask),
    result: getReportedTaskResult(reportedTask),
    file,
    suite,
  }

  if (reportedTask.type === 'module') {
    task.filepath = reportedTask.moduleId
    task.projectName = getTestModuleProjectName(reportedTask)
  }

  const children = getReportedTaskChildren(reportedTask)
  if (children) {
    task.tasks = []
    const taskFile = file || task
    const childSuite = task.type === 'suite' ? task : undefined
    for (const child of children) {
      task.tasks.push(createTaskFromReportedTask(child, taskFile, childSuite))
    }
  }

  return task
}

function getReportedTaskChildren (reportedTask) {
  const children = reportedTask.children
  if (!children) return

  if (typeof children.array === 'function') {
    return children.array()
  }

  if (Array.isArray(children)) {
    return children
  }

  return [...children]
}

function getReportedTaskMeta (reportedTask) {
  if (typeof reportedTask.meta === 'function') {
    return reportedTask.meta()
  }

  return reportedTask.meta || {}
}

function getReportedTaskResult (reportedTask) {
  let result
  if (typeof reportedTask.result === 'function') {
    result = reportedTask.result()
  } else if (typeof reportedTask.state === 'function') {
    result = {
      errors: typeof reportedTask.errors === 'function' ? reportedTask.errors() : undefined,
      state: reportedTask.state(),
    }
  } else {
    result = reportedTask.result
  }

  const diagnostic = typeof reportedTask.diagnostic === 'function'
    ? reportedTask.diagnostic()
    : undefined

  return {
    duration: diagnostic?.duration,
    errors: result?.errors,
    note: result?.note,
    repeatCount: diagnostic?.repeatCount,
    retryCount: diagnostic?.retryCount,
    state: result?.state,
  }
}

function getTestModuleFilepath (testModule) {
  return testModule.moduleId || testModule.task?.filepath || testModule.filepath
}

function getTestModuleProjectName (testModule) {
  return normalizeProjectName(
    testModule.projectName || getProjectName(testModule.project) || testModule.task?.projectName ||
      testModule.task?.file?.projectName
  )
}

function getRepeatedTestReport (task, testName, testSuiteAbsolutePath, testProperties, status, options) {
  const result = task.result
  const errors = result?.errors || []
  const { errorCounts, finalStatus, state, statuses, testSuiteStore, type } = options
  const finalAttemptStatus = finalStatus(statuses)
  const hasFailure = finalAttemptStatus === 'fail'
  const attempts = []
  const attemptCount = getRepeatedAttemptCount(task, statuses)
  let errorIndex = 0
  let previousErrorCount = 0

  if (type === 'attempt_to_fix') {
    logAttemptToFixTestExecution(testProperties.testSuite, testName, loggedAttemptToFixTests)
  }

  for (let index = 0; index < attemptCount; index++) {
    const isFinalAttempt = index === attemptCount - 1
    const attemptStatus = statuses[index] || 'pass'
    const nextErrorCount = errorCounts?.[index]
    const error = attemptStatus === 'fail'
      ? errors[nextErrorCount === undefined ? errorIndex : previousErrorCount] || errors[errorIndex] || errors[0]
      : undefined
    if (nextErrorCount !== undefined) {
      previousErrorCount = nextErrorCount
    } else if (attemptStatus === 'fail') {
      errorIndex++
    }
    const attempt = {
      attemptToFixFailed: type === 'attempt_to_fix' && isFinalAttempt && hasFailure,
      earlyFlakeAbortReason: type === 'early_flake_detection' && isFinalAttempt
        ? task.meta?.__ddTestOptEfdAbortReason
        : undefined,
      error,
      finalStatus: isFinalAttempt ? finalAttemptStatus : undefined,
      hasFailedAllRetries: isFinalAttempt && hasFailure && statuses.every(status => status === 'fail'),
      isRetry: index > 0,
      status: attemptStatus,
    }
    if (type === 'attempt_to_fix') {
      attempt.attemptToFixPassed = isFinalAttempt && !hasFailure
    } else if (type === 'early_flake_detection') {
      attempt.isRetryReasonEfd = index > 0
    }
    attempts.push(attempt)
  }

  return {
    errors,
    finalAttempt: attempts[attempts.length - 1],
    nonFinalAttempts: attempts.slice(0, -1),
    state,
    status,
    task,
    testName,
    testProperties,
    testSuiteAbsolutePath,
    testSuiteStore,
  }
}

function getRepeatedAttemptCount (task, statuses) {
  const retries = task.meta?.__ddTestOptAtfRetries ?? task.meta?.__ddTestOptEfdRetries ??
    Math.max(task.result?.retryCount || 0, task.repeats || 0)
  return Math.max(statuses.length, retries + 1)
}

function getAttemptToFixFinalStatus (statuses) {
  return statuses.includes('fail') ? 'fail' : 'pass'
}

function getEarlyFlakeDetectionFinalStatus (statuses) {
  return statuses.includes('pass') ? 'pass' : 'fail'
}

function getRepeatedTaskStatuses (task, status) {
  const repeatedStatuses = []
  const repeatCount = task.result?.repeatCount || 0
  for (let index = 0; index <= repeatCount; index++) {
    repeatedStatuses.push(status)
  }
  return repeatedStatuses
}

function reportFinalTestAttempt (testReport) {
  const {
    errors,
    status,
    task,
    testName,
    testProperties,
    testSuiteAbsolutePath,
    testSuiteStore,
  } = testReport

  if (status === 'skip') {
    testSkipCh.publish({
      testName,
      testSuiteAbsolutePath,
      isNew: testProperties.isNew,
      isDisabled: testProperties.isDisabled,
      isTestFrameworkWorker: true,
      ...testSuiteStore,
    })
    return
  }

  const result = task.result
  const finalStatus = getFinalTestStatus(testReport)
  const finalAttempt = testReport.finalAttempt

  if (status === 'fail') {
    const error = errors[errors.length - 1] || errors[0]
    reportTestAttempt(testReport, finalAttempt || {
      error,
      finalStatus,
      hasFailedAllRetries: (result?.retryCount || 0) > 0,
      isRetry: errors.length > 1 || (result?.retryCount || 0) > 0 || (result?.repeatCount || 0) > 0,
      status: 'fail',
    })
    return error
  }

  reportTestAttempt(testReport, finalAttempt || {
    finalStatus,
    isRetry: errors.length > 0 || (result?.retryCount || 0) > 0 || (result?.repeatCount || 0) > 0,
    status: 'pass',
  })
}

function reportTestAttempt (testReport, attempt) {
  const {
    state,
    task,
    testName,
    testProperties,
    testSuiteAbsolutePath,
    testSuiteStore,
  } = testReport
  const result = task.result
  const status = attempt.status
  const testCtx = {
    currentStore: testSuiteStore,
    testName,
    testSuiteAbsolutePath,
    isRetry: attempt.isRetry,
    isNew: testProperties.isNew,
    hasDynamicName: testProperties.hasDynamicName,
    isAttemptToFix: testProperties.isAttemptToFix,
    isDisabled: testProperties.isDisabled,
    isQuarantined: testProperties.isQuarantined,
    isModified: testProperties.isModified,
    isRetryReasonEfd: attempt.isRetryReasonEfd,
    isRetryReasonAttemptToFix: testProperties.isAttemptToFix && attempt.isRetry,
    isRetryReasonAtr: !testProperties.isAttemptToFix && !testProperties.isEarlyFlakeDetection &&
      testProperties.isFlakyTestRetries,
    isTestFrameworkWorker: true,
  }
  if (testProperties.isAttemptToFix) {
    recordAttemptToFixExecution(state.attemptToFixExecutions, {
      testSuite: testProperties.testSuite,
      testName,
      status,
      isDisabled: testProperties.isDisabled,
      isQuarantined: testProperties.isQuarantined,
    })
  }
  if (testProperties.hasDynamicName) {
    state.newTestsWithDynamicNames.add(`${testProperties.testSuite} › ${testName}`)
  }
  if (attempt.attemptToFixPassed) {
    testCtx.attemptToFixPassed = true
  } else if (attempt.attemptToFixFailed) {
    testCtx.attemptToFixFailed = true
  }
  testStartCh.runStores(testCtx, () => {})
  testCtx.status = status
  testCtx.task = task
  if (status === 'pass' && !attempt.isRetry && attempt.finalStatus && result?.duration !== undefined) {
    testCtx.duration = result.duration
  }
  testFinishTimeCh.runStores(testCtx, () => {})

  if (status === 'pass') {
    testPassCh.publish({
      task,
      earlyFlakeAbortReason: attempt.earlyFlakeAbortReason,
      finalStatus: attempt.finalStatus,
      ...testCtx.currentStore,
    })
    return
  }

  testErrorCh.publish({
    duration: attempt.isRetry ? undefined : result?.duration,
    error: attempt.error,
    earlyFlakeAbortReason: attempt.earlyFlakeAbortReason,
    finalStatus: attempt.finalStatus,
    hasFailedAllRetries: attempt.hasFailedAllRetries,
    attemptToFixFailed: attempt.attemptToFixFailed,
    ...testCtx.currentStore,
  })
}

function getFinalTestStatus (testReport) {
  const testProperties = testReport.testProperties
  if (testProperties.isAttemptToFix) {
    return testReport.finalAttempt?.finalStatus
  }
  if (testProperties.isDisabled || testProperties.isQuarantined) {
    return 'skip'
  }
  return testReport.status
}

function getDatadogStatus (result) {
  const state = result?.state
  if (state === 'pass' || state === 'passed') return 'pass'
  if (state === 'fail' || state === 'failed') return 'fail'
  return 'skip'
}

function getFinalRepeatedTaskStatus (task) {
  return task.meta?.__ddTestOptQuarantinedFailed ? 'fail' : getDatadogStatus(task.result)
}

function getSuiteTaskError (task) {
  const suiteTasks = getTypeTasks(task.tasks || [], 'suite')
  for (const suiteTask of suiteTasks) {
    if (suiteTask.result?.state === 'fail' && suiteTask.result?.errors?.length) {
      return suiteTask.result.errors[0]
    }
  }
}

function recomputeTaskState (task) {
  if (!task.tasks) {
    return getDatadogStatus(task.result)
  }

  const hasErrors = task.result?.errors?.length > 0
  let hasFailed = false
  let hasPassed = false

  for (const child of task.tasks) {
    const childStatus = recomputeTaskState(child)
    hasFailed ||= childStatus === 'fail'
    hasPassed ||= childStatus === 'pass'
  }

  const status = hasErrors || hasFailed ? 'fail' : hasPassed ? 'pass' : 'skip'
  task.result ||= {}
  task.result.state = status
  return status
}

function removeDatadogTestOptimizationNodeOptions (nodeOptions) {
  if (!nodeOptions) return nodeOptions

  const tokens = splitNodeOptions(nodeOptions)
  const filteredTokens = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    const valueSeparator = token.indexOf('=')
    if (valueSeparator !== -1) {
      const flag = token.slice(0, valueSeparator)
      const value = token.slice(valueSeparator + 1)
      if (shouldRemoveNodeOption(flag, value)) {
        continue
      }
    }

    if (token.startsWith('-r') && token.length > 2 && isDatadogTestOptimizationBootstrap(token.slice(2))) {
      continue
    }

    if (
      DATADOG_TEST_OPTIMIZATION_NODE_OPTION_FLAGS.has(token) &&
      isDatadogTestOptimizationBootstrap(tokens[index + 1])
    ) {
      index++
      continue
    }

    filteredTokens.push(token)
  }

  return serializeNodeOptions(filteredTokens)
}

function shouldRemoveNodeOption (flag, value) {
  return DATADOG_TEST_OPTIMIZATION_NODE_OPTION_FLAGS.has(flag) &&
    isDatadogTestOptimizationBootstrap(value)
}

function isDatadogTestOptimizationBootstrap (value) {
  if (!value) return false

  const normalizedValue = value.replaceAll('\\', '/')
  if (DATADOG_TEST_OPTIMIZATION_BOOTSTRAPS.has(normalizedValue)) return true

  for (const bootstrap of DATADOG_TEST_OPTIMIZATION_BOOTSTRAPS) {
    if (normalizedValue.endsWith(`/node_modules/${bootstrap}`)) return true
  }
  return false
}

function splitNodeOptions (nodeOptions) {
  const tokens = []
  let token = ''
  let quote

  for (let index = 0; index < nodeOptions.length; index++) {
    const char = nodeOptions[index]

    if (quote) {
      if (char === '\\' && nodeOptions[index + 1] === quote) {
        token += quote
        index++
        continue
      }

      if (char === quote) {
        quote = undefined
      } else {
        token += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (char === ' ' || char === '\n' || char === '\t') {
      if (token) {
        tokens.push(token)
        token = ''
      }
      continue
    }

    token += char
  }

  if (token) {
    tokens.push(token)
  }
  return tokens
}

function serializeNodeOptions (tokens) {
  const serializedTokens = []
  for (const token of tokens) {
    if (NODE_OPTIONS_QUOTE_RE.test(token)) {
      serializedTokens.push(JSON.stringify(token))
    } else {
      serializedTokens.push(token)
    }
  }
  return serializedTokens.join(' ')
}

function getTestSpecificationProject (testSpecification) {
  if (Array.isArray(testSpecification)) {
    return testSpecification[0]
  }
  return testSpecification?.project
}

function getProjectName (project) {
  return normalizeProjectName(project?.name || project?.config?.name || project?.test?.name)
}

function normalizeProjectName (name) {
  if (typeof name === 'string') return name

  const label = name?.label
  return typeof label === 'string' ? label : undefined
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

module.exports = {
  configure,
  configureWorkerEnv,
  shouldUse,
}
