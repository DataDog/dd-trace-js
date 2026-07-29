'use strict'

const path = require('node:path')

const satisfies = require('../../../vendor/dist/semifies')

const { RUM_TEST_EXECUTION_ID_COOKIE_NAME } = require('../../dd-trace/src/ci-visibility/rum')
const { getValueFromEnvSources } = require('../../dd-trace/src/config/helper')
const log = require('../../dd-trace/src/log')
const {
  DYNAMIC_NAME_RE,
  EARLY_FLAKE_DETECTION_RETRY_THRESHOLDS,
  getTestSuitePath,
  logAttemptToFixTestExecution,
  recordAttemptToFixExecution,
} = require('../../dd-trace/src/plugins/util/test')
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

// Main-process Vitest reporting used by no-worker-init and Browser Mode.
// Execution changes are applied by an instrumentation-less setup file in the test environment,
// while this module creates test spans from Vitest reporter events.
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
const VITEST_DEFAULT_POOL = 'forks'
const VITEST_NO_WORKER_INIT_SETUP_FILE = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'ci',
  'vitest-no-worker-init-setup.mjs'
)
const VITEST_NO_WORKER_INIT_ISOLATE_WARNING =
  `${VITEST_NO_WORKER_INIT_REQUEST_ENV} is ignored because Vitest isolate is disabled. ` +
  'The lighter Vitest worker path only works when each test file runs in an isolated worker.'
const NODE_OPTIONS_QUOTE_RE = /[\s"\\]/
let hasWarnedDisabledIsolate = false
let hasWarnedUnsupportedVersion = false
let nodeOptionsBeforeNoWorkerInit

function noop () {}

function isRequested () {
  return getValueFromEnvSources(VITEST_NO_WORKER_INIT_REQUEST_ENV) === true
}

function shouldUse (ctx, frameworkVersion, testSpecifications, options) {
  if (!isRequested()) return false
  if (!isSupportedVersion(frameworkVersion)) {
    warnUnsupportedVersion(frameworkVersion)
    return false
  }

  const config = ctx?.config
  if (!config) return false

  const { isVitestWorkerPool } = options
  if (Array.isArray(testSpecifications)) {
    return shouldUseForTestSpecifications(config, testSpecifications, isVitestWorkerPool)
  }

  const pool = getEffectiveConfigPool(config)
  if (!isNoWorkerInitPool(pool, isVitestWorkerPool)) return false
  if (getEffectiveConfigIsolate(config, pool) === false) {
    warnDisabledIsolate()
    return false
  }

  return true
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

function warnDisabledIsolate () {
  if (hasWarnedDisabledIsolate) return

  hasWarnedDisabledIsolate = true
  log.warn(VITEST_NO_WORKER_INIT_ISOLATE_WARNING)
}

function shouldUseForTestSpecifications (config, testSpecifications, isVitestWorkerPool) {
  const defaultPool = getEffectiveConfigPool(config)
  let hasNoWorkerInitSpecification = false
  let hasNonWorkerSpecification = false

  for (const testSpecification of testSpecifications) {
    const pool = getEffectiveTestSpecificationPool(testSpecification, defaultPool)
    if (!isNoWorkerInitPool(pool, isVitestWorkerPool)) {
      hasNonWorkerSpecification = true
      continue
    }

    const defaultIsolate = getEffectiveConfigIsolate(config, pool)
    if (getEffectiveTestSpecificationIsolate(testSpecification, pool, defaultIsolate) === false) {
      warnDisabledIsolate()
      return false
    }

    hasNoWorkerInitSpecification = true
  }

  return hasNoWorkerInitSpecification && !hasNonWorkerSpecification
}

function isNoWorkerInitPool (pool, isVitestWorkerPool) {
  return pool === undefined || isVitestWorkerPool(pool)
}

function configure (ctx, frameworkVersion, testSpecifications, setupData, options) {
  const { getConfiguredEfdRetryCount, shouldReportTestModule, state } = options
  addSetupFileToVitestConfigs(ctx, VITEST_NO_WORKER_INIT_SETUP_FILE, testSpecifications)

  const {
    knownTestsBySuite,
    modifiedFiles,
    repositoryRoot,
    testManagementTestsBySuite,
    testPropertiesByFilepath,
    testSessionConfiguration,
  } = setupData

  setProvidedContext(ctx, {
    _ddVitestWorkerSetup: {
      isActive: true,
      attemptToFixRetries: state.testManagementAttemptToFixRetries,
      attemptToFixTests: getSelectedTestManagementTests(testManagementTestsBySuite, 'isAttemptToFix'),
      disabledTests: getSelectedTestManagementTests(testManagementTestsBySuite, 'isDisabled'),
      earlyFlakeDetectionRetries: getConfiguredEfdRetryCount(
        state.earlyFlakeDetectionSlowTestRetries,
        state.earlyFlakeDetectionNumRetries
      ),
      earlyFlakeDetectionRetryThresholds: EARLY_FLAKE_DETECTION_RETRY_THRESHOLDS,
      earlyFlakeDetectionSlowRetries: state.earlyFlakeDetectionSlowTestRetries,
      isEarlyFlakeDetectionEnabled: state.isEarlyFlakeDetectionEnabled && !state.isEarlyFlakeDetectionFaulty,
      isRumCorrelationEnabled: !canRaceRumCorrelation(ctx, testSpecifications),
      knownTests: knownTestsBySuite || {},
      modifiedFiles: modifiedFiles || {},
      quarantinedTests: getSelectedTestManagementTests(testManagementTestsBySuite, 'isQuarantined'),
      repositoryRoot: repositoryRoot || process.cwd(),
      rumTestExecutionIdCookieName: RUM_TEST_EXECUTION_ID_COOKIE_NAME,
      testPropertiesByFilepath: testPropertiesByFilepath || {},
    },
  }, 'Could not send Vitest setup context, so main-process execution changes will not work.')

  installMainProcessReporter(ctx, frameworkVersion, testSessionConfiguration || {}, setupData, state, {
    shouldReportTestModule,
  })
}

function deactivate (ctx) {
  const installedReporterState = mainProcessReporterStates.get(ctx)
  if (installedReporterState) {
    installedReporterState.isActive = false
  }
  setProvidedContext(ctx, {
    _ddVitestWorkerSetup: {
      isActive: false,
    },
  }, 'Could not deactivate Vitest main-process execution changes.')
}

function configureWorkerEnv (workerEnv, shouldSkipWorkerInit = false) {
  if (!shouldSkipWorkerInit) {
    delete workerEnv[VITEST_NO_WORKER_INIT_ACTIVE_ENV]
    restoreDatadogTestOptimizationNodeOptions(workerEnv)
    return workerEnv
  }

  workerEnv[VITEST_NO_WORKER_INIT_ACTIVE_ENV] = '1'
  rememberDatadogTestOptimizationNodeOptions(workerEnv.NODE_OPTIONS)

  const nodeOptions = removeDatadogTestOptimizationNodeOptions(workerEnv.NODE_OPTIONS)
  if (nodeOptions) {
    workerEnv.NODE_OPTIONS = nodeOptions
  } else {
    delete workerEnv.NODE_OPTIONS
  }
  return workerEnv
}

function rememberDatadogTestOptimizationNodeOptions (nodeOptions) {
  if (hasDatadogTestOptimizationNodeOptions(nodeOptions)) {
    nodeOptionsBeforeNoWorkerInit = nodeOptions
  }
}

function restoreDatadogTestOptimizationNodeOptions (workerEnv) {
  if (!nodeOptionsBeforeNoWorkerInit || hasDatadogTestOptimizationNodeOptions(workerEnv.NODE_OPTIONS)) return

  const strippedNodeOptions = removeDatadogTestOptimizationNodeOptions(nodeOptionsBeforeNoWorkerInit)
  if (workerEnv.NODE_OPTIONS === strippedNodeOptions || (!workerEnv.NODE_OPTIONS && !strippedNodeOptions)) {
    workerEnv.NODE_OPTIONS = nodeOptionsBeforeNoWorkerInit
  }
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

    const setupFileIndex = config.setupFiles.indexOf(setupFile)
    if (setupFileIndex !== 0) {
      if (setupFileIndex > 0) {
        config.setupFiles.splice(setupFileIndex, 1)
      }
      config.setupFiles.unshift(setupFile)
    }
  }
}

function getNoWorkerInitVitestConfigs (ctx, testSpecifications) {
  const configs = new Set()
  if (Array.isArray(testSpecifications)) {
    let shouldAddRootConfig = false
    for (const testSpecification of testSpecifications) {
      const project = getTestSpecificationProject(testSpecification)
      const config = safeConfig(project)
      if (config) {
        addNoWorkerInitConfig(configs, config)
      } else {
        shouldAddRootConfig = true
      }
    }

    if (!shouldAddRootConfig && configs.size > 0) {
      return configs
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

function installMainProcessReporter (
  ctx,
  frameworkVersion,
  testSessionConfiguration,
  testOptimizationData,
  state,
  options
) {
  if (!ctx?.reporters) return

  const reporterState = {
    frameworkVersion,
    isActive: true,
    shouldReportTestModule: options.shouldReportTestModule,
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
  const tasksWithRecordedFinalAttempt = new Set()

  return {
    onTestModuleStart (testModule) {
      if (!shouldReport(testModule)) return

      startTestSuite(testModule)
    },

    onTestModuleEnd (testModule) {
      if (!shouldReport(testModule)) return

      return reportTestModule(testModule)
    },

    onTestCaseResult (testCase) {
      if (!shouldReport(testCase.module || testCase.task?.file)) return

      const task = getTestCaseTask(testCase)
      recordFinalTaskAttemptResult(task)
    },

    onTaskUpdate (packs, events) {
      if (!isReporterActive()) return
      if (!events) return

      for (const event of events) {
        if (event[1] === 'test-retried') {
          recordTaskAttemptStatus(event[0], 'fail', getTaskUpdateAttemptCount(event[0], packs))
        }
      }
    },

    onWatcherRerun () {
      for (const testSuiteCtx of testSuiteContexts.values()) {
        testSuiteFinishCh.publish({
          status: 'skip',
          deferFlush: true,
          onDone: noop,
          ...testSuiteCtx.currentStore,
        })
      }
      testSuiteContexts.clear()
      finishedTestModules.clear()
      taskAttemptStatuses.clear()
      tasksWithRecordedFinalAttempt.clear()
    },

    onFinished (files) {
      if (!isReporterActive()) return
      if (!files) return

      for (const file of files) {
        const testModule = createTestModuleFromFile(file)
        if (shouldReport(testModule) && !finishedTestModules.has(file.id)) {
          reportTestModule(testModule)
        }
      }
    },
  }

  function isReporterActive () {
    return reporterState.isActive === true
  }

  function shouldReport (testModule) {
    return isReporterActive() &&
      (!reporterState.shouldReportTestModule || reporterState.shouldReportTestModule(testModule))
  }

  function recordTaskAttemptStatus (taskId, status, attemptCount) {
    let statuses = taskAttemptStatuses.get(taskId)
    if (!statuses) {
      statuses = []
      taskAttemptStatuses.set(taskId, statuses)
    }
    if (attemptCount !== undefined && statuses.length >= attemptCount) return

    if (tasksWithRecordedFinalAttempt.has(taskId)) {
      statuses.splice(-1, 0, status)
      return
    }
    statuses.push(status)
  }

  function recordFinalTaskAttemptResult (task) {
    const statuses = taskAttemptStatuses.get(task.id)
    if (!statuses) return

    const attemptCount = getRepeatedAttemptCount(task, statuses)
    if (statuses.length < attemptCount) {
      statuses.push(getFinalRepeatedTaskStatus(task))
      tasksWithRecordedFinalAttempt.add(task.id)
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
      const testReport = getTestReport(task, testSuiteCtx.currentStore, testSuiteCtx.browserEnvironment)
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
      onDone: noop,
      ...testSuiteCtx.currentStore,
    })
    testSuiteContexts.delete(testModuleId)
  }

  function startTestSuite (testModule) {
    const { frameworkVersion, testSessionConfiguration } = reporterState
    const testModuleId = getTestModuleId(testModule)
    const browserEnvironment = getTestModuleBrowserEnvironment(testModule)
    const testSuiteCtx = {
      browserEnvironment,
      browserDriver: browserEnvironment?.browserDriver,
      browserName: browserEnvironment?.browserName,
      browserProjectName: browserEnvironment?.browserProjectName,
      testSuiteAbsolutePath: getTestModuleFilepath(testModule),
      frameworkVersion,
      testSessionId: testSessionConfiguration.testSessionId,
      testModuleId: testSessionConfiguration.testModuleId,
      testCommand: testSessionConfiguration.testCommand,
      repositoryRoot: testSessionConfiguration.repositoryRoot,
      codeOwnersEntries: testSessionConfiguration.codeOwnersEntries ?? undefined,
      requestErrorTags: reporterState.state.requestErrorTags,
      isTestFrameworkWorker: true,
      isBrowserMode: browserEnvironment !== undefined,
      isVitestNoWorkerInitActive: true,
    }
    testSuiteStartCh.runStores(testSuiteCtx, () => {})
    testSuiteContexts.set(testModuleId, testSuiteCtx)
    return testSuiteCtx
  }

  function getTestReport (task, testSuiteStore, browserEnvironment) {
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
        browserEnvironment,
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
        browserEnvironment,
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
        browserEnvironment,
        errorCounts: task.meta.__ddTestOptRepeatErrorCounts,
        finalStatus: () => getExternalFinalStatus(status, testProperties),
        state,
        statuses: task.meta.__ddTestOptRepeatStatuses,
        testSuiteStore,
        type: 'external',
      })
    }

    const attemptStatuses = taskAttemptStatuses.get(task.id)
    const retryCount = task.result?.retryCount || 0
    if (
      !testProperties.isAttemptToFix &&
      !testProperties.isEarlyFlakeDetection &&
      (attemptStatuses?.length > 1 || retryCount > 0)
    ) {
      return getRepeatedTestReport(task, testName, testSuiteAbsolutePath, testProperties, status, {
        browserEnvironment,
        errorCounts: task.meta?.__ddTestOptRetryErrorCounts,
        finalStatus: () => getExternalFinalStatus(status, testProperties),
        state,
        statuses: getRetriedTaskStatuses(attemptStatuses, retryCount, status),
        testSuiteStore,
        type: 'external',
      })
    }

    if (!testProperties.isAttemptToFix && task.result?.repeatCount > 0) {
      return getRepeatedTestReport(task, testName, testSuiteAbsolutePath, testProperties, status, {
        browserEnvironment,
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

    return {
      browserEnvironment,
      errors,
      nonFinalAttempts: [],
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

function getTaskUpdateAttemptCount (taskId, packs) {
  if (!packs) return

  for (const pack of packs) {
    if (pack[0] === taskId) {
      return getRepeatedAttemptCount({
        id: taskId,
        result: pack[1],
        meta: pack[2],
      }, [])
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
  const { browserEnvironment, errorCounts, finalStatus, state, statuses, testSuiteStore, type } = options
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
      index,
      attemptToFixFailed: type === 'attempt_to_fix' && isFinalAttempt && hasFailure,
      duration: task.meta?.__ddTestOptAttemptDurations?.[index],
      earlyFlakeAbortReason: type === 'early_flake_detection' && isFinalAttempt
        ? task.meta?.__ddTestOptEfdAbortReason
        : undefined,
      error,
      finalStatus: isFinalAttempt ? finalAttemptStatus : undefined,
      hasFailedAllRetries: hasFailedAllManagedRetries(
        task,
        testProperties,
        type,
        statuses,
        isFinalAttempt,
        hasFailure
      ),
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
    browserEnvironment,
    errors,
    finalAttempt: attempts.at(-1),
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

/**
 * Returns whether a final failed attempt exhausted Datadog-managed retries.
 *
 * @param {{
 *   meta?: { __ddTestOptEfdRetries?: number },
 *   repeats?: number,
 *   result?: { retryCount?: number }
 * }} task
 * @param {{ isFlakyTestRetries?: boolean }} testProperties
 * @param {'attempt_to_fix'|'early_flake_detection'|'external'} type
 * @param {string[]} statuses
 * @param {boolean} isFinalAttempt
 * @param {boolean} hasFailure
 * @returns {boolean}
 */
function hasFailedAllManagedRetries (task, testProperties, type, statuses, isFinalAttempt, hasFailure) {
  if (!isFinalAttempt || !hasFailure || statuses.length === 0 || !statuses.every(status => status === 'fail')) {
    return false
  }

  if (type === 'attempt_to_fix') {
    return true
  }

  if (type === 'early_flake_detection') {
    return (task.meta?.__ddTestOptEfdRetries || 0) > 0
  }

  return testProperties.isFlakyTestRetries === true && (task.result?.retryCount || 0) > 0
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

/**
 * Returns the final status for user-configured retries and repeats.
 *
 * @param {string} status
 * @param {{ isDisabled?: boolean, isQuarantined?: boolean }} testProperties
 * @returns {string}
 */
function getExternalFinalStatus (status, testProperties) {
  return testProperties.isDisabled || testProperties.isQuarantined ? 'skip' : status
}

function getRepeatedTaskStatuses (task, status) {
  const repeatedStatuses = []
  const repeatCount = task.result?.repeatCount || 0
  for (let index = 0; index <= repeatCount; index++) {
    repeatedStatuses.push(status)
  }
  return repeatedStatuses
}

/**
 * Completes reporter retry events with Vitest's final retry count and status.
 *
 * @param {string[]} recordedStatuses
 * @param {number} retryCount
 * @param {string} finalStatus
 * @returns {string[]}
 */
function getRetriedTaskStatuses (recordedStatuses = [], retryCount, finalStatus) {
  const statuses = [...recordedStatuses]
  const attemptCount = Math.max(statuses.length, retryCount + 1)
  while (statuses.length < attemptCount - 1) {
    statuses.push('fail')
  }
  statuses[attemptCount - 1] = finalStatus
  return statuses
}

function reportFinalTestAttempt (testReport) {
  const {
    browserEnvironment,
    errors,
    state,
    status,
    task,
    testName,
    testProperties,
    testSuiteAbsolutePath,
    testSuiteStore,
  } = testReport

  if (status === 'skip') {
    const {
      isRumActive,
      testExecutionId,
    } = getRumCorrelation(task)
    testSkipCh.publish({
      ...browserEnvironment,
      testName,
      testSuiteAbsolutePath,
      isNew: testProperties.isNew,
      isDisabled: testProperties.isDisabled,
      isRumActive,
      isTestFrameworkWorker: true,
      requestErrorTags: state.requestErrorTags,
      testExecutionId,
      ...testSuiteStore,
    })
    return
  }

  const result = task.result
  const finalStatus = getFinalTestStatus(testReport)
  const finalAttempt = testReport.finalAttempt

  if (status === 'fail') {
    const error = finalAttempt?.error || errors[0]
    reportTestAttempt(testReport, finalAttempt || {
      error,
      finalStatus,
      hasFailedAllRetries: hasFailedAllManagedRetries(
        task,
        testProperties,
        'external',
        ['fail'],
        true,
        true
      ),
      isRetry: (result?.retryCount || 0) > 0 || (result?.repeatCount || 0) > 0,
      status: 'fail',
    })
    return finalStatus === 'skip' ? undefined : error
  }

  reportTestAttempt(testReport, finalAttempt || {
    finalStatus,
    isRetry: (result?.retryCount || 0) > 0 || (result?.repeatCount || 0) > 0,
    status: 'pass',
  })
}

function reportTestAttempt (testReport, attempt) {
  const {
    browserEnvironment,
    state,
    task,
    testName,
    testProperties,
    testSuiteAbsolutePath,
    testSuiteStore,
  } = testReport
  const result = task.result
  const status = attempt.status
  const {
    isRumActive,
    testExecutionId,
  } = getRumCorrelation(task, attempt.index)
  const attemptStartTimes = task.meta?.__ddTestOptAttemptStartTimes
  const attemptStartIndex = attempt.index ?? (attemptStartTimes?.length || 1) - 1
  const attemptStartTime = attemptStartTimes?.[attemptStartIndex]
  let duration
  if (status === 'pass') {
    if (
      attempt.duration !== undefined ||
      (!attempt.isRetry && isFinalTestAttempt(testReport, attempt) && result?.duration !== undefined)
    ) {
      duration = attempt.duration ?? result.duration
    }
  } else {
    duration = attempt.duration ??
      (shouldUseTaskDurationForFailure(testReport, attempt) ? result?.duration : undefined)
  }
  const testCtx = {
    ...browserEnvironment,
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
    isRumActive,
    isTestFrameworkWorker: true,
    requestErrorTags: state.requestErrorTags,
    startTime: Number.isFinite(attemptStartTime)
      ? attemptStartTime
      : (Number.isFinite(duration) && duration >= 0 ? Date.now() - duration : undefined),
    testExecutionId,
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
  if (status === 'pass' && duration !== undefined) {
    testCtx.duration = duration
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
    duration,
    error: attempt.error,
    earlyFlakeAbortReason: attempt.earlyFlakeAbortReason,
    finalStatus: attempt.finalStatus,
    hasFailedAllRetries: attempt.hasFailedAllRetries,
    attemptToFixFailed: attempt.attemptToFixFailed,
    ...testCtx.currentStore,
  })
}

/**
 * Returns the browser RUM correlation metadata for a test attempt.
 *
 * @param {object} task
 * @param {number|undefined} attemptIndex
 * @returns {{ isRumActive?: boolean, testExecutionId?: string }}
 */
function getRumCorrelation (task, attemptIndex) {
  const testExecutionIds = task.meta?.__ddTestOptRumTestExecutionIds
  if (!Array.isArray(testExecutionIds) || testExecutionIds.length === 0) return {}

  attemptIndex ??= testExecutionIds.length - 1
  return {
    isRumActive: task.meta?.__ddTestOptRumActive?.[attemptIndex] === true,
    testExecutionId: testExecutionIds[attemptIndex],
  }
}

function isFinalTestAttempt (testReport, attempt) {
  return attempt.finalStatus !== undefined || testReport.finalAttempt === undefined
}

function shouldUseTaskDurationForFailure (testReport, attempt) {
  return !attempt.isRetry && attempt.finalStatus !== undefined && testReport.finalAttempt === undefined
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

function hasDatadogTestOptimizationNodeOptions (nodeOptions) {
  if (!nodeOptions) return false

  const tokens = splitNodeOptions(nodeOptions)
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    const valueSeparator = token.indexOf('=')
    if (valueSeparator !== -1) {
      const flag = token.slice(0, valueSeparator)
      const value = token.slice(valueSeparator + 1)
      if (shouldRemoveNodeOption(flag, value)) {
        return true
      }
    }

    if (token.startsWith('-r') && token.length > 2 && isDatadogTestOptimizationBootstrap(token.slice(2))) {
      return true
    }

    if (
      DATADOG_TEST_OPTIMIZATION_NODE_OPTION_FLAGS.has(token) &&
      isDatadogTestOptimizationBootstrap(tokens[index + 1])
    ) {
      return true
    }
  }
  return false
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

function getTestSpecificationFile (testSpecification) {
  if (Array.isArray(testSpecification)) {
    return testSpecification[1]
  }
  return testSpecification
}

function getTestSpecificationOptions (testSpecification) {
  if (Array.isArray(testSpecification)) {
    return testSpecification[2]
  }
  return testSpecification
}

function getTestSpecificationPool (testSpecification) {
  const options = getTestSpecificationOptions(testSpecification)
  const file = getTestSpecificationFile(testSpecification)
  const project = getTestSpecificationProject(testSpecification)
  return options?.pool ||
    file?.pool ||
    testSpecification?.pool ||
    project?.config?.pool ||
    project?.serializedConfig?.pool ||
    project?.pool
}

function getEffectiveTestSpecificationPool (testSpecification, defaultPool) {
  return getTestSpecificationPool(testSpecification) || defaultPool
}

/**
 * Resolves Vitest's default worker pool when the user did not configure one.
 *
 * @param {{ pool?: string }|undefined} config
 * @returns {string}
 */
function getEffectiveConfigPool (config) {
  return config?.pool || VITEST_DEFAULT_POOL
}

function getPoolOptionsIsolate (config, pool) {
  if (!pool) return

  return config?.poolOptions?.[pool]?.isolate
}

function getEffectiveConfigIsolate (config, pool) {
  return getPoolOptionsIsolate(config, pool) ?? config?.isolate
}

function getTestSpecificationIsolate (testSpecification, pool) {
  const options = getTestSpecificationOptions(testSpecification)
  const file = getTestSpecificationFile(testSpecification)
  const project = getTestSpecificationProject(testSpecification)
  return getPoolOptionsIsolate(options, pool) ??
    getPoolOptionsIsolate(file, pool) ??
    getPoolOptionsIsolate(project?.config, pool) ??
    getPoolOptionsIsolate(project?.serializedConfig, pool) ??
    getPoolOptionsIsolate(project, pool) ??
    getPoolOptionsIsolate(testSpecification, pool) ??
    options?.isolate ??
    file?.isolate ??
    project?.config?.isolate ??
    project?.serializedConfig?.isolate ??
    project?.isolate ??
    testSpecification?.isolate
}

function getEffectiveTestSpecificationIsolate (testSpecification, pool, defaultIsolate) {
  const isolate = getTestSpecificationIsolate(testSpecification, pool)
  return isolate === undefined ? defaultIsolate : isolate
}

function getProjectName (project) {
  return normalizeProjectName(project?.name || project?.config?.name || project?.test?.name)
}

function normalizeProjectName (name) {
  if (typeof name === 'string') return name

  const label = name?.label
  return typeof label === 'string' ? label : undefined
}

/**
 * Returns whether Vitest can overlap browser execution that shares the RUM correlation cookie origin.
 *
 * @param {object} ctx
 * @param {object[]|undefined} testSpecifications
 * @returns {boolean}
 */
function canRaceRumCorrelation (ctx, testSpecifications) {
  if (!Array.isArray(testSpecifications)) {
    const sequence = safeConfig(ctx)?.sequence
    return sequence?.hooks === 'parallel' || sequence?.setupFiles === 'parallel'
  }

  let browserFileCount = 0
  let hasBrowserProject = false
  let project
  for (const testSpecification of testSpecifications) {
    const testProject = getTestSpecificationProject(testSpecification)
    if (
      getTestSpecificationPool(testSpecification) !== 'browser' &&
      getProjectReportingConfig(testProject)?.browser?.enabled !== true
    ) {
      continue
    }

    const config = getProjectReportingConfig(testProject) || safeConfig(ctx)
    if (config?.sequence?.hooks === 'parallel' || config?.sequence?.setupFiles === 'parallel') return true

    browserFileCount++
    if (hasBrowserProject && testProject !== project) return true
    project = testProject
    hasBrowserProject = true
  }
  if (browserFileCount < 2) return false

  const config = getProjectReportingConfig(project) || safeConfig(ctx)
  const fileParallelism = config?.browser?.fileParallelism ?? config?.fileParallelism
  return fileParallelism !== false && config?.maxWorkers !== 1
}

function getTestModuleBrowserEnvironment (testModule) {
  const project = testModule?.project
  const config = getProjectReportingConfig(project)
  let isBrowserMode = testModule?.task?.pool === 'browser' || testModule?.pool === 'browser'
  try {
    isBrowserMode ||= project?.isBrowserEnabled?.() === true
  } catch {}
  isBrowserMode ||= config?.browser?.enabled === true
  if (!isBrowserMode) return

  const provider = config?.browser?.provider
  const browserDriver = typeof provider === 'string' ? provider : provider?.name

  return {
    browserDriver,
    browserName: config?.browser?.name,
    browserProjectName: getTestModuleProjectName(testModule),
    isBrowserMode: true,
  }
}

/**
 * Returns the runtime or serialized project configuration used for read-only reporting metadata.
 *
 * @param {object|undefined} project
 * @returns {object|undefined}
 */
function getProjectReportingConfig (project) {
  const config = safeConfig(project)
  if (config) return config

  try {
    return project?.serializedConfig
  } catch {}
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
  deactivate,
  configureWorkerEnv,
  isSupportedVersion,
  shouldUse,
}
