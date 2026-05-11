'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { fileURLToPath } = require('node:url')

const shimmer = require('../../datadog-shimmer')
const {
  TEST_RETRY_REASON_TYPES,
  getEfdRetryCount,
  getTestSuitePath,
  isModifiedTest,
} = require('../../dd-trace/src/plugins/util/test')
const { getEnvironmentVariable } = require('../../dd-trace/src/config/helper')

const { addHook, channel } = require('./helpers/instrument')

const testSessionStartCh = channel('ci:node-test:session:start')
const testSessionFinishCh = channel('ci:node-test:session:finish')
const testSuiteStartCh = channel('ci:node-test:test-suite:start')
const testSuiteFinishCh = channel('ci:node-test:test-suite:finish')
const libraryConfigurationCh = channel('ci:node-test:library-configuration')
const knownTestsCh = channel('ci:node-test:known-tests')
const testManagementTestsCh = channel('ci:node-test:test-management-tests')
const modifiedFilesCh = channel('ci:node-test:modified-files')
const testStartCh = channel('ci:node-test:test:start')
const testFnCh = channel('ci:node-test:test:fn')
const testFinishCh = channel('ci:node-test:test:finish')
const workerReportFlushCh = channel('ci:node-test:worker-report:flush')
const workerReportTraceCh = channel('ci:node-test:worker-report:trace')
const loadChannel = channel('dd-trace:instrumentation:load')

const CONFIG_POLL_INTERVAL_MS = 25
const CONFIG_POLL_TIMEOUT_MS = 10_000
const WORKER_REPORT_FLUSH_INTERVAL_MS = 1000
const NODE_TEST_CONFIG_FILE_ENV = 'DD_CIVISIBILITY_NODE_TEST_CONFIG_FILE'
const NODE_TEST_WORKER_REPORTS_DIR_ENV = 'DD_CIVISIBILITY_NODE_TEST_WORKER_REPORTS_DIR'

const NODE_TEST_FUNCTIONS = ['test', 'it']
const NODE_SUITE_FUNCTIONS = ['describe', 'suite']
const NODE_HOOK_FUNCTIONS = ['before', 'beforeEach', 'after', 'afterEach']
const patchedFunctionExports = new WeakMap()
const nodeTestState = {
  command: undefined,
  frameworkVersion: undefined,
  hasRegisteredBeforeEach: false,
  hasRegisteredAfterEach: false,
  hasRegisteredAfter: false,
  hasRegisteredFinishHandler: false,
  hasStartedSession: false,
  hasStartedSuite: false,
  hasFinished: false,
  workerReportFlushInterval: undefined,
  testSuiteAbsolutePath: undefined,
  status: 'pass',
  configPromise: undefined,
  config: {
    isFlakyTestRetriesEnabled: false,
    flakyTestRetriesCount: 0,
    isEarlyFlakeDetectionEnabled: false,
    earlyFlakeDetectionNumRetries: 0,
    earlyFlakeDetectionSlowTestRetries: undefined,
    isKnownTestsEnabled: false,
    knownTests: undefined,
    isTestManagementEnabled: false,
    testManagementAttemptToFixRetries: 0,
    testManagementTests: undefined,
    requestErrorTags: undefined,
    isImpactedTestsEnabled: false,
    modifiedFiles: undefined,
  },
  tests: new WeakMap(),
  metadataByFullName: new Map(),
  suiteStack: [],
  userBeforeEachHooks: [],
  userAfterEachHooks: [],
}

function getChannelPromise (ch, ctx) {
  return new Promise(resolve => {
    ch.runStores({
      ...ctx,
      onDone: resolve,
    }, () => {})
  })
}

function getCommand () {
  if (getEnvironmentVariable('NODE_TEST_CONTEXT')) {
    return 'node --test'
  }
  return ['node', ...process.execArgv, ...process.argv.slice(1)].filter(Boolean).join(' ')
}

function isNodeTestCli () {
  return process.execArgv.some(arg => arg === '--test' || arg.startsWith('--test='))
}

function isNodeTestWorker () {
  return !!getEnvironmentVariable('NODE_TEST_CONTEXT')
}

function startWorkerReportFlushInterval () {
  // eslint-disable-next-line eslint-rules/eslint-process-env
  if (isNodeTestWorker() || nodeTestState.workerReportFlushInterval || !process.env[NODE_TEST_WORKER_REPORTS_DIR_ENV]) {
    return
  }

  nodeTestState.workerReportFlushInterval = setInterval(flushWorkerReports, WORKER_REPORT_FLUSH_INTERVAL_MS)
  nodeTestState.workerReportFlushInterval.unref?.()
}

function stopWorkerReportFlushInterval () {
  if (!nodeTestState.workerReportFlushInterval) {
    return
  }

  clearInterval(nodeTestState.workerReportFlushInterval)
  nodeTestState.workerReportFlushInterval = undefined
}

function setupNodeTestWorkerIpc () {
  if (!isNodeTestCli() || isNodeTestWorker()) {
    return
  }

  // eslint-disable-next-line eslint-rules/eslint-process-env
  if (!process.env[NODE_TEST_WORKER_REPORTS_DIR_ENV]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-node-test-'))
    // eslint-disable-next-line eslint-rules/eslint-process-env
    process.env[NODE_TEST_WORKER_REPORTS_DIR_ENV] = dir
    // eslint-disable-next-line eslint-rules/eslint-process-env
    process.env[NODE_TEST_CONFIG_FILE_ENV] = path.join(dir, 'config.json')
  }

  startWorkerReportFlushInterval()
}

function getDefaultTestSuiteAbsolutePath () {
  return process.argv[1] || require.main?.filename || process.cwd()
}

function getUserCallSite () {
  const stack = new Error('Get node:test call site').stack
  if (!stack) {
    return {}
  }

  const lines = stack.split('\n')
  for (const line of lines) {
    if (
      line.includes(`${path.sep}datadog-instrumentations${path.sep}src${path.sep}node-test.js`) ||
      line.includes('node:internal') ||
      line.includes('node:test')
    ) {
      continue
    }

    const match = line.match(/\(([^()]+):(\d+):(\d+)\)$/) || line.match(/at ([^()]+):(\d+):(\d+)$/)
    if (match?.[1]) {
      return {
        file: match[1],
        line: Number(match[2]),
      }
    }
  }
  return {}
}

function normalizeCallSiteFile (file) {
  if (file?.startsWith('file://')) {
    try {
      return fileURLToPath(file)
    } catch {
      return file
    }
  }
  return file
}

function getFullName (name) {
  const names = [...nodeTestState.suiteStack, String(name)]
  return names.filter(Boolean).join(' > ')
}

function getCurrentSuiteFullName () {
  return nodeTestState.suiteStack.join(' > ')
}

function addUserHook (hookName, fn) {
  const hooks = hookName === 'beforeEach'
    ? nodeTestState.userBeforeEachHooks
    : nodeTestState.userAfterEachHooks

  hooks.push({
    fn,
    suiteFullName: getCurrentSuiteFullName(),
  })
}

function getApplicableHooks (hooks, metadata) {
  return hooks.filter(({ suiteFullName }) => {
    return !suiteFullName ||
      metadata.fullName === suiteFullName ||
      metadata.fullName.startsWith(`${suiteFullName} > `)
  })
}

function hasApplicableAfterEachHook (testContext) {
  return getApplicableHooks(nodeTestState.userAfterEachHooks, getMetadata(testContext)).length > 0
}

function parseTestArgs (args) {
  let name
  let options
  let fn
  let fnIndex = -1

  if (typeof args[0] === 'string') {
    name = args[0]
    if (typeof args[1] === 'function') {
      fn = args[1]
      fnIndex = 1
    } else {
      options = args[1]
      if (typeof args[2] === 'function') {
        fn = args[2]
        fnIndex = 2
      }
    }
  } else if (typeof args[0] === 'function') {
    fn = args[0]
    fnIndex = 0
    name = fn.name || '<anonymous>'
  } else {
    options = args[0]
    if (typeof args[1] === 'function') {
      fn = args[1]
      fnIndex = 1
      name = fn.name || '<anonymous>'
    }
  }

  return { name, options, fn, fnIndex }
}

function isSkippedOrTodo (options, forcedMode) {
  return forcedMode === 'skip' ||
    forcedMode === 'todo' ||
    !!options?.skip ||
    !!options?.todo
}

function getStatusFromOptions (options, forcedMode) {
  return isSkippedOrTodo(options, forcedMode) ? 'skip' : undefined
}

function addMetadata (metadata) {
  const existing = nodeTestState.metadataByFullName.get(metadata.fullName)
  if (!existing) {
    nodeTestState.metadataByFullName.set(metadata.fullName, metadata)
  }
}

function getMetadata (testContext) {
  const fullName = testContext.fullName || testContext.name
  return nodeTestState.metadataByFullName.get(fullName) || {
    name: testContext.name,
    fullName,
    testSuiteAbsolutePath: nodeTestState.testSuiteAbsolutePath || getDefaultTestSuiteAbsolutePath(),
  }
}

function isSkippedMetadata (testContext) {
  if (!testContext) {
    return false
  }
  return getMetadata(testContext).status === 'skip'
}

function getRelativeSuitePath (testSuiteAbsolutePath) {
  return getTestSuitePath(testSuiteAbsolutePath, process.cwd())
}

function isKnownTest (metadata) {
  const knownSuites = nodeTestState.config.knownTests?.['node-test']
  if (!knownSuites) {
    return false
  }

  const suite = getRelativeSuitePath(metadata.testSuiteAbsolutePath)
  const knownTestsForSuite = knownSuites[suite]

  return Array.isArray(knownTestsForSuite) && knownTestsForSuite.includes(metadata.fullName)
}

function getTestManagementProperties (metadata) {
  if (!nodeTestState.config.isTestManagementEnabled) {
    return {}
  }

  const suite = getRelativeSuitePath(metadata.testSuiteAbsolutePath)
  const { attempt_to_fix: isAttemptToFix, disabled: isDisabled, quarantined: isQuarantined } =
    nodeTestState.config.testManagementTests?.['node-test']?.suites?.[suite]?.tests?.[metadata.fullName]?.properties ||
    {}

  return { isAttemptToFix, isDisabled, isQuarantined }
}

function isImpactedTest (metadata) {
  if (!nodeTestState.config.isImpactedTestsEnabled) {
    return false
  }

  const suite = getRelativeSuitePath(metadata.testSuiteAbsolutePath)
  return isModifiedTest(suite, 0, 0, nodeTestState.config.modifiedFiles, 'node-test')
}

function getStartOptions (testContext) {
  const metadata = getMetadata(testContext)
  const isNew = nodeTestState.config.isEarlyFlakeDetectionEnabled &&
    nodeTestState.config.isKnownTestsEnabled &&
    !isKnownTest(metadata)
  const isModified = isImpactedTest(metadata)
  const testManagementProperties = getTestManagementProperties(metadata)

  return {
    isNew,
    isModified,
    ...testManagementProperties,
  }
}

function ensureStarted (nodeTest, frameworkVersion, shouldStartSuite = true) {
  nodeTestState.frameworkVersion = frameworkVersion || process.version
  nodeTestState.command = nodeTestState.command || getCommand()
  nodeTestState.testSuiteAbsolutePath = nodeTestState.testSuiteAbsolutePath || getDefaultTestSuiteAbsolutePath()

  if (!isNodeTestWorker() && !nodeTestState.hasStartedSession) {
    testSessionStartCh.publish({
      command: nodeTestState.command,
      frameworkVersion: nodeTestState.frameworkVersion,
    })
    nodeTestState.hasStartedSession = true
  }

  if (shouldStartSuite && !nodeTestState.hasStartedSuite) {
    testSuiteStartCh.runStores({
      testSuiteAbsolutePath: nodeTestState.testSuiteAbsolutePath,
      frameworkVersion: nodeTestState.frameworkVersion,
    }, () => {})
    nodeTestState.hasStartedSuite = true
  }
}

function readWorkerConfiguration (configFile, startedAt, resolve) {
  fs.readFile(configFile, 'utf8', (error, content) => {
    if (!error) {
      try {
        Object.assign(nodeTestState.config, JSON.parse(content))
      } catch {
        // Ignore invalid configuration files and use the default local config.
      }
      return resolve(nodeTestState.config)
    }

    if (Date.now() - startedAt >= CONFIG_POLL_TIMEOUT_MS) {
      return resolve(nodeTestState.config)
    }

    setTimeout(() => {
      readWorkerConfiguration(configFile, startedAt, resolve)
    }, CONFIG_POLL_INTERVAL_MS)
  })
}

function getWorkerConfiguration () {
  // eslint-disable-next-line eslint-rules/eslint-process-env
  const configFile = process.env[NODE_TEST_CONFIG_FILE_ENV]
  if (!configFile) {
    return Promise.resolve(nodeTestState.config)
  }

  return new Promise(resolve => {
    readWorkerConfiguration(configFile, Date.now(), resolve)
  })
}

function writeWorkerConfiguration () {
  // eslint-disable-next-line eslint-rules/eslint-process-env
  const configFile = process.env[NODE_TEST_CONFIG_FILE_ENV]
  if (!configFile) {
    return
  }

  const tempFile = `${configFile}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tempFile, JSON.stringify(nodeTestState.config))
    fs.renameSync(tempFile, configFile)
  } catch {
    // If workers cannot read the parent configuration they will use local defaults.
  }
}

function flushWorkerReports () {
  // eslint-disable-next-line eslint-rules/eslint-process-env
  const reportsDir = process.env[NODE_TEST_WORKER_REPORTS_DIR_ENV]
  if (!reportsDir) {
    return
  }

  let filenames
  try {
    filenames = fs.readdirSync(reportsDir)
  } catch {
    return
  }

  let hasReports = false
  for (const filename of filenames) {
    if (!filename.startsWith('trace-') || !filename.endsWith('.json')) {
      continue
    }

    const filepath = path.join(reportsDir, filename)
    try {
      workerReportTraceCh.publish(fs.readFileSync(filepath, 'utf8'))
      hasReports = true
      fs.unlinkSync(filepath)
    } catch {
      // Ignore unreadable worker report files.
    }
  }

  if (hasReports) {
    workerReportFlushCh.publish()
  }
}

function ensureConfiguration () {
  if (nodeTestState.configPromise) {
    return nodeTestState.configPromise
  }

  if (isNodeTestWorker()) {
    nodeTestState.configPromise = getWorkerConfiguration()
    return nodeTestState.configPromise
  }

  nodeTestState.configPromise = getChannelPromise(libraryConfigurationCh, {
    frameworkVersion: nodeTestState.frameworkVersion,
  }).then(({ err, libraryConfig, requestErrorTags }) => {
    nodeTestState.config.requestErrorTags = requestErrorTags

    if (!err && libraryConfig) {
      nodeTestState.config.isFlakyTestRetriesEnabled = libraryConfig.isFlakyTestRetriesEnabled
      nodeTestState.config.flakyTestRetriesCount = libraryConfig.flakyTestRetriesCount || 0
      nodeTestState.config.isEarlyFlakeDetectionEnabled = libraryConfig.isEarlyFlakeDetectionEnabled
      nodeTestState.config.earlyFlakeDetectionNumRetries = libraryConfig.earlyFlakeDetectionNumRetries || 0
      nodeTestState.config.earlyFlakeDetectionSlowTestRetries = libraryConfig.earlyFlakeDetectionSlowTestRetries
      nodeTestState.config.isKnownTestsEnabled = libraryConfig.isKnownTestsEnabled
      nodeTestState.config.isTestManagementEnabled = libraryConfig.isTestManagementEnabled
      nodeTestState.config.testManagementAttemptToFixRetries = libraryConfig.testManagementAttemptToFixRetries || 0
      nodeTestState.config.isImpactedTestsEnabled = libraryConfig.isImpactedTestsEnabled
    }

    let configPromise = Promise.resolve(nodeTestState.config)

    if (nodeTestState.config.isEarlyFlakeDetectionEnabled && nodeTestState.config.isKnownTestsEnabled) {
      configPromise = configPromise.then(() => getChannelPromise(knownTestsCh, {
        frameworkVersion: nodeTestState.frameworkVersion,
      }).then(({ err, knownTests }) => {
        if (!err && knownTests) {
          nodeTestState.config.knownTests = knownTests
        } else {
          nodeTestState.config.isEarlyFlakeDetectionEnabled = false
          nodeTestState.config.isKnownTestsEnabled = false
        }
      }))
    }

    if (nodeTestState.config.isTestManagementEnabled) {
      configPromise = configPromise.then(() => getChannelPromise(testManagementTestsCh, {
        frameworkVersion: nodeTestState.frameworkVersion,
      }).then(({ err, testManagementTests }) => {
        if (!err && testManagementTests) {
          nodeTestState.config.testManagementTests = testManagementTests
        } else {
          nodeTestState.config.isTestManagementEnabled = false
        }
      }))
    }

    if (nodeTestState.config.isImpactedTestsEnabled) {
      configPromise = configPromise.then(() => getChannelPromise(modifiedFilesCh, {
        frameworkVersion: nodeTestState.frameworkVersion,
      }).then(({ err, modifiedFiles }) => {
        if (!err && modifiedFiles) {
          nodeTestState.config.modifiedFiles = modifiedFiles
        } else {
          nodeTestState.config.isImpactedTestsEnabled = false
        }
      }))
    }

    return configPromise.then(() => {
      writeWorkerConfiguration()
      return nodeTestState.config
    })
  })

  return nodeTestState.configPromise
}

function finishSession () {
  if ((!nodeTestState.hasStartedSession && !nodeTestState.hasStartedSuite) || nodeTestState.hasFinished) {
    return
  }
  nodeTestState.hasFinished = true

  const status = nodeTestState.status === 'fail' || process.exitCode ? 'fail' : nodeTestState.status
  const error = status === 'fail' ? new Error('Failed tests.') : undefined

  if (nodeTestState.hasStartedSuite) {
    testSuiteFinishCh.publish({
      status,
      testSuiteAbsolutePath: nodeTestState.testSuiteAbsolutePath,
    })
  }

  if (!nodeTestState.hasStartedSession) {
    return
  }

  stopWorkerReportFlushInterval()
  flushWorkerReports()

  testSessionFinishCh.publish({
    status,
    error,
  })
}

function addBeforeExitHandler () {
  if (nodeTestState.hasRegisteredFinishHandler) {
    return
  }
  nodeTestState.hasRegisteredFinishHandler = true

  const ddTrace = globalThis[Symbol.for('dd-trace')]
  if (ddTrace?.beforeExitHandlers) {
    ddTrace.beforeExitHandlers.add(finishSession)
  } else {
    process.once('beforeExit', finishSession)
  }
}

function normalizeRetryCount (count) {
  const retryCount = Number(count)
  if (!Number.isFinite(retryCount) || retryCount <= 0) {
    return 0
  }
  return Math.floor(retryCount)
}

function getRetryPlan (startOptions = {}) {
  const config = nodeTestState.config

  const attemptToFixRetries = normalizeRetryCount(config.testManagementAttemptToFixRetries)
  if (startOptions.isAttemptToFix) {
    if (attemptToFixRetries <= 0) {
      return
    }
    return {
      count: attemptToFixRetries,
      reason: TEST_RETRY_REASON_TYPES.atf,
      type: 'attempt-to-fix',
    }
  }

  const earlyFlakeDetectionRetries = normalizeRetryCount(config.earlyFlakeDetectionNumRetries)
  if (startOptions.isNew && earlyFlakeDetectionRetries > 0) {
    return {
      count: earlyFlakeDetectionRetries,
      reason: TEST_RETRY_REASON_TYPES.efd,
      type: 'early-flake-detection',
    }
  }

  const flakyTestRetries = normalizeRetryCount(config.flakyTestRetriesCount)
  if (
    config.isFlakyTestRetriesEnabled &&
    flakyTestRetries > 0 &&
    !startOptions.isDisabled &&
    !startOptions.isQuarantined
  ) {
    return {
      count: flakyTestRetries,
      reason: TEST_RETRY_REASON_TYPES.atr,
      type: 'auto-test-retry',
    }
  }
}

function createRetryState (startOptions) {
  return {
    attempt: 0,
    hasFailed: false,
    hasPassed: false,
    lastError: undefined,
    passedResult: undefined,
    plan: getRetryPlan(startOptions),
    hasSetEfdRetryCount: false,
  }
}

function startTest (testContext, startOptions = {}, retryState) {
  const metadata = getMetadata(testContext)
  const ctx = {
    testName: metadata.fullName || metadata.name || testContext.name,
    testSuiteAbsolutePath: metadata.testSuiteAbsolutePath,
    testStartLine: metadata.line,
    testContext,
    parentTestContext: metadata.parentTestContext,
    requestErrorTags: nodeTestState.config.requestErrorTags,
    ...startOptions,
  }

  testStartCh.runStores(ctx, () => {})

  const state = {
    ctx,
    status: 'pass',
    finalStatus: 'pass',
    error: undefined,
    args: [testContext],
    fn: metadata.fn,
    hasFailedAllRetries: false,
    attemptToFixPassed: false,
    attemptToFixFailed: false,
    isQuarantined: !!startOptions.isQuarantined,
    nativeFailureThrown: false,
    retryState: retryState || createRetryState(startOptions),
    hasSubtests: false,
    skipBody: false,
    startedAt: performance.now(),
    startOptions,
    finished: false,
  }
  nodeTestState.tests.set(testContext, state)

  return state
}

function getTestState (testContext) {
  return nodeTestState.tests.get(testContext)
}

function markParentHasSubtests (parentTestContext) {
  if (!parentTestContext || typeof parentTestContext !== 'object') {
    return
  }

  const parentState = getTestState(parentTestContext)
  if (parentState) {
    parentState.hasSubtests = true
  }
}

function finishTest (testContext) {
  const state = getTestState(testContext)
  if (!state || state.finished) {
    return
  }
  state.finished = true

  if (state.finalStatus === 'fail') {
    nodeTestState.status = 'fail'
  }

  testFinishCh.publish({
    status: state.status,
    error: state.error,
    finalStatus: state.finalStatus,
    hasFailedAllRetries: state.hasFailedAllRetries,
    attemptToFixPassed: state.attemptToFixPassed,
    attemptToFixFailed: state.attemptToFixFailed,
    testContext,
  })
}

function startRetry (testContext, retryReason, startOptions = {}, retryState) {
  const metadata = getMetadata(testContext)
  const ctx = {
    testName: metadata.fullName || metadata.name || testContext.name,
    testSuiteAbsolutePath: metadata.testSuiteAbsolutePath,
    testStartLine: metadata.line,
    testContext,
    parentTestContext: metadata.parentTestContext,
    isRetry: true,
    retryReason,
    requestErrorTags: nodeTestState.config.requestErrorTags,
    ...startOptions,
  }

  testStartCh.runStores(ctx, () => {})

  const state = {
    ctx,
    status: 'pass',
    finalStatus: 'pass',
    error: undefined,
    args: [testContext],
    fn: metadata.fn,
    hasFailedAllRetries: false,
    attemptToFixPassed: false,
    attemptToFixFailed: false,
    isQuarantined: !!startOptions.isQuarantined,
    nativeFailureThrown: false,
    retryState: retryState || createRetryState(startOptions),
    hasSubtests: false,
    skipBody: false,
    startedAt: performance.now(),
    startOptions,
    finished: false,
  }
  nodeTestState.tests.set(testContext, state)

  return state
}

function setTestFailure (testContext, error) {
  const state = getTestState(testContext)
  if (!state) {
    return
  }
  state.status = 'fail'
  state.finalStatus = state.isQuarantined && !state.startOptions.isAttemptToFix ? 'skip' : 'fail'
  state.error = error
}

function setTestSkip (testContext) {
  const state = getTestState(testContext)
  if (!state) {
    return
  }
  state.status = 'skip'
  state.finalStatus = 'skip'
  state.error = undefined
}

function setTestPass (state, finalStatus) {
  if (!state || state.status === 'skip') {
    return
  }
  state.status = 'pass'
  state.finalStatus = finalStatus
  state.error = undefined
}

function runInTestScope (testContext, fn) {
  const state = getTestState(testContext)
  if (!state) {
    return fn()
  }
  return testFnCh.runStores(state.ctx, fn)
}

function shouldSuppressFailure (state) {
  if (!state) {
    return false
  }
  if (state.startOptions.isAttemptToFix) {
    return true
  }
  if (state.startOptions.isQuarantined) {
    return true
  }

  const { plan } = state.retryState
  return !!plan && plan.count > 0
}

function recordAttemptResult (state) {
  const retryState = state.retryState
  if (state.status === 'pass') {
    retryState.hasPassed = true
    retryState.passedResult = state.result
  } else if (state.status === 'fail') {
    retryState.hasFailed = true
    retryState.lastError = state.error
  }
}

function setEfdRetryCountFromDuration (state) {
  const retryState = state.retryState
  const { plan } = retryState
  const slowTestRetries = nodeTestState.config.earlyFlakeDetectionSlowTestRetries

  if (plan?.type !== 'early-flake-detection' || retryState.hasSetEfdRetryCount || !slowTestRetries) {
    return
  }

  retryState.hasSetEfdRetryCount = true
  plan.count = normalizeRetryCount(getEfdRetryCount(performance.now() - state.startedAt, slowTestRetries))
}

function shouldRetryAfterAttempt (state) {
  const retryState = state.retryState
  const { plan } = retryState
  if (!plan || retryState.attempt >= plan.count) {
    return false
  }
  if (state.hasSubtests) {
    return false
  }
  if (plan.type === 'auto-test-retry') {
    return state.status === 'fail'
  }
  return true
}

function setFinalAttemptTags (state) {
  const retryState = state.retryState
  const { plan } = retryState

  if (!plan) {
    return
  }

  if (plan.type === 'early-flake-detection') {
    state.finalStatus = retryState.hasPassed ? 'pass' : 'fail'
  } else if (plan.type === 'attempt-to-fix') {
    state.finalStatus = retryState.hasFailed ? 'fail' : 'pass'
    state.attemptToFixPassed = !retryState.hasFailed
    state.attemptToFixFailed = retryState.hasFailed
  } else if (state.status === 'fail') {
    state.hasFailedAllRetries = true
    state.finalStatus = 'fail'
  } else {
    state.finalStatus = 'pass'
  }
}

function runManualHook (hook, testContext) {
  return runInTestScope(testContext, () => callUserFunction(hook.fn, undefined, [testContext]))
}

async function runManualHooks (hooks, testContext) {
  const metadata = getMetadata(testContext)
  const applicableHooks = getApplicableHooks(hooks, metadata)

  for (const hook of applicableHooks) {
    // eslint-disable-next-line no-await-in-loop
    await runManualHook(hook, testContext)
  }
}

async function runManualAttempt (testContext, startOptions) {
  try {
    await runManualHooks(nodeTestState.userBeforeEachHooks, testContext)
  } catch (error) {
    setTestFailure(testContext, error)
  }

  const stateAfterBeforeEach = getTestState(testContext)
  if (stateAfterBeforeEach.status !== 'fail') {
    try {
      const result = await runInTestScope(testContext, () => {
        return callUserFunction(stateAfterBeforeEach.fn, stateAfterBeforeEach.thisArg, stateAfterBeforeEach.args)
      })
      const state = getTestState(testContext)
      state.result = result
      setTestPass(state, 'pass')
    } catch (error) {
      setTestFailure(testContext, error)
    }
  }

  if (!startOptions.isDisabled || startOptions.isAttemptToFix) {
    try {
      await runManualHooks(nodeTestState.userAfterEachHooks, testContext)
    } catch (error) {
      setTestFailure(testContext, error)
    }
  }
}

async function finishAttemptAndRetries (testContext) {
  let state = getTestState(testContext)
  if (!state || state.finished) {
    return
  }

  recordAttemptResult(state)
  setEfdRetryCountFromDuration(state)

  while (shouldRetryAfterAttempt(state)) {
    state.finalStatus = undefined
    finishTest(testContext)

    const { retryState, startOptions } = state
    retryState.attempt++
    startRetry(testContext, retryState.plan.reason, startOptions, retryState)

    // eslint-disable-next-line no-await-in-loop
    await runManualAttempt(testContext, startOptions)
    state = getTestState(testContext)
    recordAttemptResult(state)
  }

  setFinalAttemptTags(state)
  finishTest(testContext)

  const { plan, hasPassed, lastError, passedResult } = state.retryState
  if (plan?.type === 'early-flake-detection' && hasPassed) {
    return passedResult
  }

  if (state.finalStatus === 'fail' && !state.nativeFailureThrown) {
    throw lastError || state.error
  }
}

function skipDisabledTest (testContext) {
  setTestSkip(testContext)
}

async function runTestBody (fn, thisArg, args, testContext) {
  const state = getTestState(testContext)
  if (state?.skipBody) {
    return
  }

  state.fn = fn
  state.thisArg = thisArg
  state.args = args

  try {
    const result = await runInTestScope(testContext, () => callUserFunction(fn, thisArg, args))
    const currentState = getTestState(testContext)
    currentState.result = result
    setTestPass(currentState, 'pass')
    return result
  } catch (error) {
    const currentState = getTestState(testContext)
    setTestFailure(testContext, error)
    if (!shouldSuppressFailure(currentState)) {
      currentState.nativeFailureThrown = true
      throw error
    }
  }
}

function wrapContextControl (testContext, methodName) {
  const method = testContext[methodName]
  if (typeof method !== 'function') {
    return
  }

  testContext[methodName] = function ddNodeTestContextControl (...args) {
    try {
      return method.apply(this, args)
    } finally {
      setTestSkip(testContext)
    }
  }
}

function wrapContext (testContext, nodeTest, frameworkVersion) {
  if (!testContext || testContext._ddNodeTestWrapped) {
    return testContext
  }

  Object.defineProperty(testContext, '_ddNodeTestWrapped', {
    configurable: true,
    value: true,
  })

  if (typeof testContext.test === 'function') {
    testContext.test = wrapTestFunction(
      testContext.test,
      nodeTest,
      frameworkVersion,
      undefined,
      testContext.fullName,
      testContext
    )
  }
  wrapContextControl(testContext, 'skip')
  wrapContextControl(testContext, 'todo')

  return testContext
}

function callUserFunction (fn, thisArg, args) {
  if (fn.length > args.length) {
    return new Promise((resolve, reject) => {
      const callback = (error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
      try {
        fn.apply(thisArg, [...args, callback])
      } catch (error) {
        reject(error)
      }
    })
  }

  try {
    return Promise.resolve(fn.apply(thisArg, args))
  } catch (error) {
    return Promise.reject(error)
  }
}

async function runWrappedTestFunction (fn, thisArg, args, nodeTest, frameworkVersion) {
  const testContext = wrapContext(args[0], nodeTest, frameworkVersion)
  await ensureConfiguration()
  const startOptions = getStartOptions(testContext)
  if (!getTestState(testContext)) {
    startTest(testContext, startOptions)
  }

  if (startOptions.isDisabled && !startOptions.isAttemptToFix) {
    skipDisabledTest(testContext)
    if (!hasApplicableAfterEachHook(testContext)) {
      await finishAttemptAndRetries(testContext)
    }
    return
  }

  try {
    return await runTestBody(fn, thisArg, args, testContext)
  } finally {
    if (!hasApplicableAfterEachHook(testContext)) {
      await finishAttemptAndRetries(testContext)
    }
  }
}

function wrapUserTestFunction (fn, nodeTest, frameworkVersion) {
  if (fn.length > 1) {
    return function ddNodeTestCallbackWrapper (testContext, callback) {
      runWrappedTestFunction(fn, this, [testContext], nodeTest, frameworkVersion)
        .then(() => callback(), callback)
    }
  }

  return function ddNodeTestWrapper (testContext) {
    return runWrappedTestFunction(fn, this, [testContext], nodeTest, frameworkVersion)
  }
}

function wrapTestFunction (test, nodeTest, frameworkVersion, forcedMode, parentFullName, parentTestContext) {
  return shimmer.wrapFunction(test, test => function ddNodeTest (...args) {
    ensureStarted(nodeTest, frameworkVersion)
    markParentHasSubtests(parentTestContext)

    const { name, options, fn, fnIndex } = parseTestArgs(args)
    const callSite = getUserCallSite()
    const fullName = parentFullName
      ? `${parentFullName} > ${String(name || fn?.name || '<anonymous>')}`
      : getFullName(name || fn?.name || '<anonymous>')
    const metadata = {
      name: String(name || fn?.name || '<anonymous>'),
      fullName,
      fn,
      testSuiteAbsolutePath: normalizeCallSiteFile(callSite.file) || nodeTestState.testSuiteAbsolutePath,
      line: callSite.line,
      parentTestContext,
    }

    addMetadata(metadata)

    const status = getStatusFromOptions(options, forcedMode)
    if (status) {
      metadata.status = status
      const skippedCtx = {
        testName: metadata.fullName,
        testSuiteAbsolutePath: metadata.testSuiteAbsolutePath,
        testStartLine: metadata.line,
      }
      testStartCh.runStores(skippedCtx, () => {})
      testFinishCh.publish({
        status,
        finalStatus: status,
      })
    }

    if (fnIndex !== -1 && typeof fn === 'function') {
      args[fnIndex] = wrapUserTestFunction(fn, nodeTest, frameworkVersion)
    }

    return test.apply(this, args)
  })
}

function wrapSuiteFunction (suite, nodeTest, frameworkVersion, forcedMode) {
  return shimmer.wrapFunction(suite, suite => function ddNodeSuite (...args) {
    ensureStarted(nodeTest, frameworkVersion)

    const { name, fn, fnIndex } = parseTestArgs(args)
    if (fnIndex !== -1 && typeof fn === 'function') {
      args[fnIndex] = function ddNodeSuiteWrapper (...suiteArgs) {
        nodeTestState.suiteStack.push(String(name || fn.name || '<anonymous>'))
        try {
          return fn.apply(this, suiteArgs)
        } finally {
          nodeTestState.suiteStack.pop()
        }
      }
    }

    return suite.apply(this, args)
  })
}

async function runUserEachHook (fn, thisArg, testContext, hookName) {
  await ensureConfiguration()
  const startOptions = getStartOptions(testContext)
  if (isSkippedMetadata(testContext)) {
    return
  }
  if (!getTestState(testContext)) {
    startTest(testContext, startOptions)
  }
  if (startOptions.isDisabled && !startOptions.isAttemptToFix) {
    return
  }

  try {
    return await runInTestScope(testContext, () => callUserFunction(fn, thisArg, [testContext]))
  } catch (error) {
    const state = getTestState(testContext)
    setTestFailure(testContext, error)
    if (hookName === 'beforeEach' && state) {
      state.skipBody = true
    }
    if (!shouldSuppressFailure(state)) {
      state.nativeFailureThrown = true
      finishTest(testContext)
      throw error
    }
  }
}

function wrapUserHookFunction (fn, hookName) {
  if (hookName === 'before' || hookName === 'after') {
    if (fn.length > 1) {
      return function ddNodeSuiteHookCallbackWrapper (testContext, callback) {
        callUserFunction(fn, this, [testContext]).then(() => callback(), callback)
      }
    }

    return function ddNodeSuiteHookWrapper (testContext) {
      return callUserFunction(fn, this, [testContext])
    }
  }

  if (fn.length > 1) {
    return function ddNodeHookCallbackWrapper (testContext, callback) {
      runUserEachHook(fn, this, testContext, hookName).then(() => {
        if (hookName === 'afterEach') {
          return finishAttemptAndRetries(testContext)
        }
      }).then(() => callback(), callback)
    }
  }

  return function ddNodeHookWrapper (testContext) {
    const result = runUserEachHook(fn, this, testContext, hookName)
    if (hookName === 'afterEach') {
      return result.then(() => finishAttemptAndRetries(testContext))
    }
    return result
  }
}

function wrapHookFunction (hook, nodeTest, frameworkVersion, hookName) {
  return shimmer.wrapFunction(hook, hook => function ddNodeHook (...args) {
    ensureStarted(nodeTest, frameworkVersion)

    const { fn, fnIndex } = parseTestArgs(args)
    if (fnIndex !== -1 && typeof fn === 'function') {
      if (hookName === 'beforeEach' || hookName === 'afterEach') {
        addUserHook(hookName, fn)
      }
      args[fnIndex] = wrapUserHookFunction(fn, hookName)
    }
    return hook.apply(this, args)
  })
}

function installLifecycleHooks (nodeTest, frameworkVersion, originals) {
  if (!nodeTestState.hasRegisteredBeforeEach) {
    originals.beforeEach(async function ddNodeTestBeforeEach (testContext) {
      ensureStarted(nodeTest, frameworkVersion)
      await ensureConfiguration()
      if (isSkippedMetadata(testContext)) {
        return
      }
      startTest(testContext, getStartOptions(testContext))
    })
    nodeTestState.hasRegisteredBeforeEach = true
  }

  if (!nodeTestState.hasRegisteredAfterEach) {
    process.nextTick(() => {
      originals.afterEach(async function ddNodeTestAfterEach (testContext) {
        await finishAttemptAndRetries(testContext)
      })
    })
    nodeTestState.hasRegisteredAfterEach = true
  }

  if (!nodeTestState.hasRegisteredAfter) {
    process.nextTick(() => {
      originals.after(finishSession)
    })
    nodeTestState.hasRegisteredAfter = true
  }
}

function patchFunctionExport (nodeTest, frameworkVersion) {
  const patched = patchedFunctionExports.get(nodeTest)
  if (patched) {
    return patched
  }

  const originals = {}

  for (const fnName of NODE_HOOK_FUNCTIONS) {
    originals[fnName] = nodeTest[fnName]
  }

  installLifecycleHooks(nodeTest, frameworkVersion, originals)

  const wrapped = wrapTestFunction(nodeTest, nodeTest, frameworkVersion)

  for (const key of Reflect.ownKeys(nodeTest)) {
    const descriptor = Object.getOwnPropertyDescriptor(nodeTest, key)
    if (!descriptor || key === 'length' || key === 'name') {
      continue
    }
    try {
      Object.defineProperty(wrapped, key, descriptor)
    } catch {
      // ignore non-configurable properties
    }
  }

  wrapped.test = wrapped
  for (const fnName of NODE_TEST_FUNCTIONS) {
    if (typeof nodeTest[fnName] === 'function') {
      wrapped[fnName] = fnName === 'test' ? wrapped : wrapTestFunction(nodeTest[fnName], wrapped, frameworkVersion)
    }
  }
  for (const fnName of NODE_SUITE_FUNCTIONS) {
    if (typeof nodeTest[fnName] === 'function') {
      wrapped[fnName] = wrapSuiteFunction(nodeTest[fnName], wrapped, frameworkVersion)
    }
  }
  for (const fnName of NODE_HOOK_FUNCTIONS) {
    if (typeof nodeTest[fnName] === 'function') {
      wrapped[fnName] = wrapHookFunction(nodeTest[fnName], wrapped, frameworkVersion, fnName)
    }
  }

  for (const mode of ['skip', 'todo', 'only']) {
    if (typeof nodeTest[mode] === 'function') {
      wrapped[mode] = wrapTestFunction(nodeTest[mode], wrapped, frameworkVersion, mode)
    }
  }

  addBeforeExitHandler()
  patchedFunctionExports.set(nodeTest, wrapped)

  return wrapped
}

function startParentSession () {
  if (!isNodeTestCli() || isNodeTestWorker()) {
    return
  }

  ensureStarted(undefined, process.version, false)
  ensureConfiguration()
  addBeforeExitHandler()
}

function startCliParentSession () {
  setupNodeTestWorkerIpc()
  loadChannel.publish({ name: 'node:test' })
  startParentSession()
}

function patchNamespaceFunction (namespace, name, fn) {
  if (typeof fn !== 'function') {
    return
  }

  try {
    namespace[name] = fn
  } catch {
    // ignore read-only namespace entries
  }
}

function patchNamespaceExport (namespace, frameworkVersion) {
  const nodeTest = typeof namespace.default === 'function' ? namespace.default : namespace.test
  if (typeof nodeTest !== 'function') {
    return namespace
  }

  const wrapped = patchFunctionExport(nodeTest, frameworkVersion)

  patchNamespaceFunction(namespace, 'default', wrapped)
  patchNamespaceFunction(namespace, 'test', wrapped)
  for (const fnName of NODE_TEST_FUNCTIONS) {
    patchNamespaceFunction(namespace, fnName, wrapped[fnName])
  }
  for (const fnName of NODE_SUITE_FUNCTIONS) {
    patchNamespaceFunction(namespace, fnName, wrapped[fnName])
  }
  for (const fnName of NODE_HOOK_FUNCTIONS) {
    patchNamespaceFunction(namespace, fnName, wrapped[fnName])
  }
  for (const mode of ['skip', 'todo', 'only']) {
    patchNamespaceFunction(namespace, mode, wrapped[mode])
  }

  return namespace
}

addHook({
  name: 'node:test',
}, (nodeTest, frameworkVersion) => {
  if (!testFinishCh.hasSubscribers) {
    return nodeTest
  }

  if (typeof nodeTest === 'function') {
    return patchFunctionExport(nodeTest, frameworkVersion)
  }

  if (nodeTest && typeof nodeTest === 'object') {
    return patchNamespaceExport(nodeTest, frameworkVersion)
  }

  return nodeTest
})

if (isNodeTestCli() || isNodeTestWorker()) {
  setupNodeTestWorkerIpc()
  loadChannel.publish({ name: 'node:test' })
}

module.exports = {
  startCliParentSession,
}
