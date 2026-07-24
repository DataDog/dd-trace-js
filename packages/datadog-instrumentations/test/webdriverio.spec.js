'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')

const { channel, tracingChannel } = require('../src/helpers/instrument')
const rewriter = require('../src/helpers/rewriter')
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
    const libraryConfigurationCh = channel('ci:mocha:library-configuration')
    const testSessionStartCh = channel('ci:mocha:session:start')
    const testSessionFinishCh = channel('ci:mocha:session:finish')
    const testSuiteStartCh = channel('ci:mocha:test-suite:start')
    const testSuiteFinishCh = channel('ci:mocha:test-suite:finish')

    const sessionStarts = []
    const sessionFinishes = []
    const suiteStarts = []
    const suiteFinishes = []
    let configurationRequests = 0

    function onTestFinish () {}
    function onLibraryConfiguration (request) {
      configurationRequests++
      request.onDone({
        isTestDynamicInstrumentationEnabled: false,
        libraryConfig: {
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
          isTestManagementEnabled: false,
          testManagementAttemptToFixRetries: 0,
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

    testFinishCh.subscribe(onTestFinish)
    libraryConfigurationCh.subscribe(onLibraryConfiguration)
    testSessionStartCh.subscribe(onSessionStart)
    testSessionFinishCh.subscribe(onSessionFinish)
    testSuiteStartCh.subscribe(onSuiteStart)
    testSuiteFinishCh.subscribe(onSuiteFinish)

    try {
      require('../src/webdriverio')

      const localRunner = {
        _config: {
          framework: 'mocha',
          rootDir: process.cwd(),
          runnerEnv: { USER_ENV: 'preserved' },
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

      assert.strictEqual(firstWorker.sentMessages[0].name, CONFIGURATION_RESPONSE)
      assert.strictEqual(firstWorker.sentMessages[0].content.requestId, 'first-request')
      assert.strictEqual(secondWorker.sentMessages[0].name, CONFIGURATION_RESPONSE)
      assert.strictEqual(secondWorker.sentMessages[0].content.requestId, 'second-request')

      reportSuiteFinish(firstWorker, firstFile)
      reportSuiteFinish(secondWorker, secondFile)
      firstWorker.emit('exit', { exitCode: 0 })
      secondWorker.emit('exit', { exitCode: 0 })

      const shutdownContext = { self: localRunner }
      tracingChannel('orchestrion:@wdio/local-runner:LocalRunner_shutdown').asyncEnd.publish(shutdownContext)
      await shutdownContext.asyncEndPromise

      assert.strictEqual(configurationRequests, 1)
      assert.strictEqual(sessionStarts.length, 1)
      assert.strictEqual(sessionFinishes.length, 1)
      assert.strictEqual(sessionFinishes[0].status, 'pass')
      assert.strictEqual(sessionFinishes[0].isParallel, true)
      assert.deepStrictEqual(suiteStarts.map(({ testSuiteAbsolutePath }) => testSuiteAbsolutePath), [
        firstFile,
        secondFile,
      ])
      assert.deepStrictEqual(suiteFinishes.map(({ status }) => status), ['pass', 'pass'])
    } finally {
      testFinishCh.unsubscribe(onTestFinish)
      libraryConfigurationCh.unsubscribe(onLibraryConfiguration)
      testSessionStartCh.unsubscribe(onSessionStart)
      testSessionFinishCh.unsubscribe(onSessionFinish)
      testSuiteStartCh.unsubscribe(onSuiteStart)
      testSuiteFinishCh.unsubscribe(onSuiteFinish)
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
 * Reports a passing suite to the coordinator.
 *
 * @param {EventEmitter} worker
 * @param {string} file
 * @returns {void}
 */
function reportSuiteFinish (worker, file) {
  worker.emit('message', {
    name: SUITE_FINISH,
    content: {
      results: [{ file, status: 'pass' }],
    },
  })
}
