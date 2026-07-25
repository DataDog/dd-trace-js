'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')

const { channel, tracingChannel } = require('../src/helpers/instrument')
const rewriter = require('../src/helpers/rewriter')
const {
  MOCHA_WORKER_TRACE_PAYLOAD_CODE,
  TEST_SUITE_EXECUTION_ID,
} = require('../../dd-trace/src/plugins/util/test')
const {
  CONFIGURATION_REQUEST,
  CONFIGURATION_RESPONSE,
  SUITE_FINISH,
  WEBDRIVERIO_WORKER_ENV,
  WORKER_READY,
} = require('../src/mocha/webdriverio-protocol')

const fixturePath = path.join(__dirname, 'fixtures', 'webdriverio-local-runner.mjs')
const fixtureModulePath = path.join(
  __dirname,
  'fixtures',
  'node_modules',
  '@wdio',
  'local-runner',
  'build',
  'index.js'
)

describe('webdriverio instrumentation', () => {
  it('rewrites the ESM local runner and waits for coordinator shutdown', () => {
    const source = fs.readFileSync(fixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, fixtureModulePath, 'module')

    assert.notStrictEqual(rewrittenSource, source)
    assert.match(rewrittenSource, /orchestrion:@wdio\/local-runner:LocalRunner_run/)
    assert.match(rewrittenSource, /orchestrion:@wdio\/local-runner:LocalRunner_shutdown/)
    assert.match(rewrittenSource, /__apm\$ctx\.asyncEndPromise/)
  })

  it('coordinates two Mocha workers under one session', async () => {
    const testFinishCh = channel('ci:mocha:test:finish')
    const knownTestsCh = channel('ci:mocha:known-tests')
    const libraryConfigurationCh = channel('ci:mocha:library-configuration')
    const modifiedFilesCh = channel('ci:mocha:modified-files')
    const skippableSuitesCh = channel('ci:mocha:test-suite:skippable')
    const testSessionStartCh = channel('ci:mocha:session:start')
    const testSessionFinishCh = channel('ci:mocha:session:finish')
    const testSuiteStartCh = channel('ci:mocha:test-suite:start')
    const testSuiteFinishCh = channel('ci:mocha:test-suite:finish')
    const testManagementTestsCh = channel('ci:mocha:test-management-tests')
    const workerReportTraceCh = channel('ci:mocha:worker-report:trace')

    const sessionStarts = []
    const sessionFinishes = []
    const suiteStarts = []
    const suiteFinishes = []
    const workerTracePayloads = []
    let advancedFeatureRequests = 0
    let configurationRequests = 0
    const originalNodeOptions = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = '--require dd-trace/ci/init'

    function onTestFinish () {}
    function onAdvancedFeatureRequest (request) {
      advancedFeatureRequests++
      request.onDone({})
    }
    function onLibraryConfiguration (request) {
      configurationRequests++
      request.onDone({
        isTestDynamicInstrumentationEnabled: true,
        libraryConfig: {
          earlyFlakeDetectionNumRetries: 5,
          earlyFlakeDetectionSlowTestRetries: { '5s': 5 },
          flakyTestRetriesCount: 5,
          isCodeCoverageEnabled: true,
          isCoverageReportUploadEnabled: true,
          isDiEnabled: true,
          isEarlyFlakeDetectionEnabled: true,
          isFlakyTestRetriesEnabled: true,
          isImpactedTestsEnabled: true,
          isItrEnabled: true,
          isKnownTestsEnabled: true,
          isSuitesSkippingEnabled: true,
          isTestManagementEnabled: true,
          testManagementAttemptToFixRetries: 5,
        },
        repositoryRoot: process.cwd(),
      })
    }
    function onSessionStart (event) {
      sessionStarts.push(event)
    }
    function onSessionFinish (event) {
      sessionFinishes.push(event)
      event.onDone()
    }
    function onSuiteStart (event) {
      suiteStarts.push(event)
    }
    function onSuiteFinish (event) {
      suiteFinishes.push(event)
    }
    function onWorkerTrace (event) {
      workerTracePayloads.push(event)
    }

    testFinishCh.subscribe(onTestFinish)
    knownTestsCh.subscribe(onAdvancedFeatureRequest)
    libraryConfigurationCh.subscribe(onLibraryConfiguration)
    modifiedFilesCh.subscribe(onAdvancedFeatureRequest)
    skippableSuitesCh.subscribe(onAdvancedFeatureRequest)
    testSessionStartCh.subscribe(onSessionStart)
    testSessionFinishCh.subscribe(onSessionFinish)
    testSuiteStartCh.subscribe(onSuiteStart)
    testSuiteFinishCh.subscribe(onSuiteFinish)
    testManagementTestsCh.subscribe(onAdvancedFeatureRequest)
    workerReportTraceCh.subscribe(onWorkerTrace)

    try {
      require('../src/webdriverio')

      const localRunner = {
        _config: {
          framework: 'mocha',
          rootDir: process.cwd(),
          runnerEnv: {
            NODE_OPTIONS: '--no-warnings',
            USER_ENV: 'preserved',
          },
        },
      }
      const firstFile = path.join(process.cwd(), 'first.spec.js')
      const secondFile = path.join(process.cwd(), 'second.spec.js')
      const firstWorker = createWorker()
      const secondWorker = createWorker()

      registerWorker(localRunner, firstWorker, firstFile)
      registerWorker(localRunner, secondWorker, secondFile)

      assert.deepStrictEqual(localRunner._config.runnerEnv, {
        USER_ENV: 'preserved',
        NODE_OPTIONS: '--require dd-trace/ci/init --no-warnings',
        MOCHA_WORKER_ID: 'webdriverio',
        [WEBDRIVERIO_WORKER_ENV]: 'true',
      })

      firstWorker.emit('message', {
        name: WORKER_READY,
        content: { frameworkVersion: '10.8.2' },
      })
      secondWorker.emit('message', {
        name: WORKER_READY,
        content: { frameworkVersion: '10.8.2' },
      })
      await new Promise(setImmediate)

      requestConfiguration(firstWorker, firstFile, 'first-request')
      requestConfiguration(secondWorker, secondFile, 'second-request')
      await new Promise(setImmediate)

      firstWorker.emit('message', [MOCHA_WORKER_TRACE_PAYLOAD_CODE, 'first-trace'])
      secondWorker.emit('message', [MOCHA_WORKER_TRACE_PAYLOAD_CODE, 'second-trace'])

      assert.strictEqual(firstWorker.sentMessages[0].name, CONFIGURATION_RESPONSE)
      assert.strictEqual(firstWorker.sentMessages[0].content.requestId, 'first-request')
      assert.strictEqual(secondWorker.sentMessages[0].name, CONFIGURATION_RESPONSE)
      assert.strictEqual(secondWorker.sentMessages[0].content.requestId, 'second-request')
      assert.deepStrictEqual(firstWorker.sentMessages[0].content.configuration, {
        earlyFlakeDetectionNumRetries: 0,
        earlyFlakeDetectionSlowTestRetries: {},
        flakyTestRetriesCount: 0,
        isCodeCoverageEnabled: false,
        isCoverageReportUploadEnabled: false,
        isDiEnabled: false,
        isEarlyFlakeDetectionEnabled: false,
        isFlakyTestRetriesEnabled: false,
        isImpactedTestsEnabled: false,
        isItrEnabled: false,
        isKnownTestsEnabled: false,
        isSuitesSkippingEnabled: false,
        isTestDynamicInstrumentationEnabled: false,
        isTestManagementTestsEnabled: false,
        knownTests: {},
        modifiedFiles: [],
        repositoryRoot: process.cwd(),
        testManagementAttemptToFixRetries: 0,
        testManagementTests: {},
      })

      reportSuiteFinish(firstWorker, firstFile, 'fail')
      reportSuiteFinish(secondWorker, secondFile)
      firstWorker.emit('exit', { exitCode: 1, retries: 1 })
      secondWorker.emit('exit', { exitCode: 0, retries: 0 })

      const shutdownContext = { self: localRunner }
      tracingChannel('orchestrion:@wdio/local-runner:LocalRunner_shutdown').asyncEnd.publish(shutdownContext)
      await shutdownContext.asyncEndPromise

      assert.strictEqual(configurationRequests, 1)
      assert.strictEqual(advancedFeatureRequests, 0)
      assert.strictEqual(sessionStarts.length, 1)
      assert.strictEqual(sessionFinishes.length, 1)
      assert.strictEqual(sessionFinishes[0].status, 'pass')
      assert.strictEqual(sessionFinishes[0].isParallel, true)
      assert.strictEqual('isEarlyFlakeDetectionEnabled' in sessionFinishes[0], false)
      assert.strictEqual('isSuitesSkipped' in sessionFinishes[0], false)
      assert.strictEqual('isTestManagementEnabled' in sessionFinishes[0], false)
      assert.deepStrictEqual(suiteStarts.map(({ testSuiteAbsolutePath }) => testSuiteAbsolutePath), [
        firstFile,
        secondFile,
      ])
      assert.strictEqual(new Set(suiteStarts.map(({ testSuiteExecutionId }) => testSuiteExecutionId)).size, 2)
      assert.deepStrictEqual(workerTracePayloads, [
        {
          traces: 'first-trace',
          [TEST_SUITE_EXECUTION_ID]: suiteStarts[0].testSuiteExecutionId,
        },
        {
          traces: 'second-trace',
          [TEST_SUITE_EXECUTION_ID]: suiteStarts[1].testSuiteExecutionId,
        },
      ])
      assert.deepStrictEqual(suiteFinishes.map(({ status }) => status), ['fail', 'pass'])
    } finally {
      testFinishCh.unsubscribe(onTestFinish)
      knownTestsCh.unsubscribe(onAdvancedFeatureRequest)
      libraryConfigurationCh.unsubscribe(onLibraryConfiguration)
      modifiedFilesCh.unsubscribe(onAdvancedFeatureRequest)
      skippableSuitesCh.unsubscribe(onAdvancedFeatureRequest)
      testSessionStartCh.unsubscribe(onSessionStart)
      testSessionFinishCh.unsubscribe(onSessionFinish)
      testSuiteStartCh.unsubscribe(onSuiteStart)
      testSuiteFinishCh.unsubscribe(onSuiteFinish)
      testManagementTestsCh.unsubscribe(onAdvancedFeatureRequest)
      workerReportTraceCh.unsubscribe(onWorkerTrace)
      if (originalNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS
      } else {
        process.env.NODE_OPTIONS = originalNodeOptions
      }
    }
  })

  it('fails a terminal worker exit without marking sequential workers as parallel', async () => {
    const testFinishCh = channel('ci:mocha:test:finish')
    const testSessionFinishCh = channel('ci:mocha:session:finish')
    const sessionFinishes = []

    function onTestFinish () {}
    function onSessionFinish (event) {
      sessionFinishes.push(event)
      event.onDone()
    }

    testFinishCh.subscribe(onTestFinish)
    testSessionFinishCh.subscribe(onSessionFinish)

    try {
      require('../src/webdriverio')

      const localRunner = {
        config: {
          framework: 'mocha',
          rootDir: process.cwd(),
        },
      }
      const firstFile = path.join(process.cwd(), 'first.spec.js')
      const secondFile = path.join(process.cwd(), 'second.spec.js')
      const firstWorker = createWorker()
      const secondWorker = createWorker()

      registerWorker(localRunner, firstWorker, firstFile)
      requestConfiguration(firstWorker, firstFile, 'first-request')
      reportSuiteFinish(firstWorker, firstFile)
      firstWorker.emit('exit', { exitCode: 0, retries: 0 })

      registerWorker(localRunner, secondWorker, secondFile)
      requestConfiguration(secondWorker, secondFile, 'second-request')
      reportSuiteFinish(secondWorker, secondFile)
      secondWorker.emit('exit', { exitCode: 1, retries: 0 })

      const shutdownContext = { self: localRunner }
      tracingChannel('orchestrion:@wdio/local-runner:LocalRunner_shutdown').asyncEnd.publish(shutdownContext)
      await shutdownContext.asyncEndPromise

      assert.strictEqual(sessionFinishes.length, 1)
      assert.strictEqual(sessionFinishes[0].status, 'fail')
      assert.strictEqual(sessionFinishes[0].isParallel, false)
    } finally {
      testFinishCh.unsubscribe(onTestFinish)
      testSessionFinishCh.unsubscribe(onSessionFinish)
    }
  })

  it('reports a worker failure before Mocha loads', async () => {
    const testFinishCh = channel('ci:mocha:test:finish')
    const libraryConfigurationCh = channel('ci:mocha:library-configuration')
    const testSessionStartCh = channel('ci:mocha:session:start')
    const testSessionFinishCh = channel('ci:mocha:session:finish')
    const sessionStarts = []
    const sessionFinishes = []
    let configurationRequests = 0

    function onTestFinish () {}
    function onLibraryConfiguration (request) {
      configurationRequests++
      setImmediate(() => request.onDone({ repositoryRoot: process.cwd() }))
    }
    function onSessionStart (event) {
      sessionStarts.push(event)
    }
    function onSessionFinish (event) {
      sessionFinishes.push(event)
      event.onDone()
    }

    testFinishCh.subscribe(onTestFinish)
    libraryConfigurationCh.subscribe(onLibraryConfiguration)
    testSessionStartCh.subscribe(onSessionStart)
    testSessionFinishCh.subscribe(onSessionFinish)

    try {
      require('../src/webdriverio')

      const localRunner = {
        config: {
          framework: 'mocha',
          rootDir: process.cwd(),
        },
      }
      const worker = createWorker()

      registerWorker(localRunner, worker, path.join(process.cwd(), 'first.spec.js'))
      worker.emit('exit', { exitCode: 1, retries: 0 })

      const shutdownContext = { self: localRunner }
      tracingChannel('orchestrion:@wdio/local-runner:LocalRunner_shutdown').asyncEnd.publish(shutdownContext)
      await shutdownContext.asyncEndPromise

      assert.strictEqual(configurationRequests, 1)
      assert.strictEqual(sessionStarts.length, 1)
      assert.strictEqual(sessionStarts[0].frameworkVersion, undefined)
      assert.strictEqual(sessionFinishes.length, 1)
      assert.strictEqual(sessionFinishes[0].status, 'fail')
      assert.strictEqual(sessionFinishes[0].isParallel, false)
    } finally {
      testFinishCh.unsubscribe(onTestFinish)
      libraryConfigurationCh.unsubscribe(onLibraryConfiguration)
      testSessionStartCh.unsubscribe(onSessionStart)
      testSessionFinishCh.unsubscribe(onSessionFinish)
    }
  })
})

/**
 * Creates a fake WebdriverIO worker instance.
 *
 * @returns {EventEmitter & {childProcess: object, sentMessages: object[]}}
 */
function createWorker () {
  const worker = new EventEmitter()
  worker.sentMessages = []
  worker.childProcess = {
    connected: true,
    send (message, onDone) {
      worker.sentMessages.push(message)
      onDone?.()
    },
  }
  return worker
}

/**
 * Publishes the LocalRunner.run lifecycle for one worker.
 *
 * @param {object} localRunner
 * @param {object} worker
 * @param {string} file
 * @returns {void}
 */
function registerWorker (localRunner, worker, file) {
  const context = {
    self: localRunner,
    arguments: [{ specs: [file] }],
  }
  const runCh = tracingChannel('orchestrion:@wdio/local-runner:LocalRunner_run')
  runCh.start.publish(context)
  context.result = worker
  runCh.asyncEnd.publish(context)
}

/**
 * Requests execution configuration from the coordinator.
 *
 * @param {EventEmitter} worker
 * @param {string} file
 * @param {string} requestId
 * @returns {void}
 */
function requestConfiguration (worker, file, requestId) {
  worker.emit('message', {
    name: CONFIGURATION_REQUEST,
    content: {
      files: [file],
      frameworkVersion: '10.8.2',
      requestId,
    },
  })
}

/**
 * Reports a suite result to the coordinator.
 *
 * @param {EventEmitter} worker
 * @param {string} file
 * @param {string} [status]
 * @returns {void}
 */
function reportSuiteFinish (worker, file, status = 'pass') {
  worker.emit('message', {
    name: SUITE_FINISH,
    content: {
      results: [{ file, status }],
    },
  })
}
