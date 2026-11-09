'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { format } = require('node:util')
const { runInNewContext } = require('node:vm')

const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')
const { isEqual, cloneDeep } = require('lodash')
const {
  TEST_STATUS,
  TEST_FINAL_STATUS,
  TEST_IS_RETRY,
  TEST_RETRY_REASON,
  TEST_RETRY_REASON_TYPES,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_SESSION_EMPTY_REASON,
  formatAttemptToFixSummary,
  TEST_SKIP_REASON,
  TEST_FAILURE_SCREENSHOT_UPLOADED,
  TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR,
  TEST_FAILURE_VIDEO_UPLOADED,
  TEST_FAILURE_VIDEO_UPLOAD_ERROR,
  TEST_FAILURE_VIDEO_SCOPE,
} = require('../../packages/dd-trace/src/plugins/util/test')
const {
  VIDEO_UPLOAD_RESULT_UPLOADED,
  VIDEO_UPLOAD_SCOPE_TEST_SUITE,
} = require('../../packages/dd-trace/src/ci-visibility/test-video')

describe('Cypress plugin run lifecycle', () => {
  const cypressPlugin = require('../../packages/datadog-plugin-cypress/src/cypress-plugin')
  const originalState = {
    cypressConfig: cypressPlugin.cypressConfig,
    isInit: cypressPlugin._isInit,
    libraryConfigurationPromise: cypressPlugin.libraryConfigurationPromise,
    hasOriginalCypressRetries: cypressPlugin.hasOriginalCypressRetries,
    originalCypressRetries: cypressPlugin.originalCypressRetries,
    configuredCypressRetries: cypressPlugin.configuredCypressRetries,
    resolvedCypressRetries: cypressPlugin.resolvedCypressRetries,
    nativeCypressRetriesBaseline: cypressPlugin.nativeCypressRetriesBaseline,
    retryConfigObserver: cypressPlugin.retryConfigObserver,
    tracer: cypressPlugin.tracer,
    finishedTestsByFile: cypressPlugin.finishedTestsByFile,
    hasTestsReported: cypressPlugin.hasTestsReported,
    testSuiteStatuses: cypressPlugin.testSuiteStatuses,
    testsToSkip: cypressPlugin.testsToSkip,
    testSessionSpan: cypressPlugin.testSessionSpan,
    testModuleSpan: cypressPlugin.testModuleSpan,
    testSuiteSpan: cypressPlugin.testSuiteSpan,
    pendingScreenshotUploads: cypressPlugin.pendingScreenshotUploads,
    pendingVideoUploads: cypressPlugin.pendingVideoUploads,
    uploadedVideoPaths: cypressPlugin.uploadedVideoPaths,
    screenshotUploadAbortControllers: cypressPlugin.screenshotUploadAbortControllers,
  }

  afterEach(() => {
    if (cypressPlugin.retryConfigObserver !== originalState.retryConfigObserver) {
      cypressPlugin.retryConfigObserver?.stop()
    }
    cypressPlugin.retryConfigObserver = originalState.retryConfigObserver
    cypressPlugin.cypressConfig = originalState.cypressConfig
    cypressPlugin._isInit = originalState.isInit
    cypressPlugin.libraryConfigurationPromise = originalState.libraryConfigurationPromise
    cypressPlugin.hasOriginalCypressRetries = originalState.hasOriginalCypressRetries
    cypressPlugin.originalCypressRetries = originalState.originalCypressRetries
    cypressPlugin.configuredCypressRetries = originalState.configuredCypressRetries
    cypressPlugin.resolvedCypressRetries = originalState.resolvedCypressRetries
    cypressPlugin.nativeCypressRetriesBaseline = originalState.nativeCypressRetriesBaseline
    cypressPlugin.tracer = originalState.tracer
    cypressPlugin.finishedTestsByFile = originalState.finishedTestsByFile
    cypressPlugin.hasTestsReported = originalState.hasTestsReported
    cypressPlugin.testSuiteStatuses = originalState.testSuiteStatuses
    cypressPlugin.testsToSkip = originalState.testsToSkip
    cypressPlugin.testSessionSpan = originalState.testSessionSpan
    cypressPlugin.testModuleSpan = originalState.testModuleSpan
    cypressPlugin.testSuiteSpan = originalState.testSuiteSpan
    cypressPlugin.pendingScreenshotUploads = originalState.pendingScreenshotUploads
    cypressPlugin.pendingVideoUploads = originalState.pendingVideoUploads
    cypressPlugin.uploadedVideoPaths = originalState.uploadedVideoPaths
    cypressPlugin.screenshotUploadAbortControllers = originalState.screenshotUploadAbortControllers
    sinon.restore()
  })

  function prepareRunFinalization () {
    const createSpan = () => {
      const tags = {}
      return {
        tags,
        context: () => ({
          _trace: { started: [] },
          toTraceId: () => '123',
          toSpanId: () => '456',
          getTag: name => tags[name],
          getTags: () => tags,
        }),
        finish: sinon.stub(),
        setTag: sinon.stub().callsFake((name, value) => { tags[name] = value }),
      }
    }
    const testSessionSpan = createSpan()
    const testModuleSpan = createSpan()

    cypressPlugin.resetRunState()
    cypressPlugin._isInit = true
    cypressPlugin.testSessionSpan = testSessionSpan
    cypressPlugin.testModuleSpan = testModuleSpan
    cypressPlugin.tracer = {
      startSpan: sinon.stub().callsFake(createSpan),
      _tracer: {
        _exporter: {
          flush: callback => callback(),
        },
      },
    }
    sinon.stub(cypressPlugin, 'applySkippedCoverageToTestSessionCoverage').returns(false)
    sinon.stub(cypressPlugin, 'getTestCodeCoverageLinesTotal').returns(undefined)
    sinon.stub(cypressPlugin, 'reportTestSessionCoverage')
    sinon.stub(cypressPlugin, 'ciVisEvent')

    return { testModuleSpan, testSessionSpan, createSpan }
  }

  for (const mustFail of [false, true]) {
    for (const noAutoRetry of [false, true]) {
      const description = `protected=${mustFail}, excluded=${noAutoRetry}`
      it(`keeps recovered ATF notes consistent with protection (${description})`, () => {
        const { createSpan } = prepareRunFinalization()
        const testSuite = 'cypress/e2e/protected-skip.js'
        cypressPlugin.testSuiteSpan = createSpan()
        sinon.stub(cypressPlugin, 'getTestSpan').callsFake(createSpan)
        sinon.stub(cypressPlugin, 'getTestProperties').returns({
          isAttemptToFix: true, isDisabled: true, isQuarantined: true,
        })
        cypressPlugin.getTasks()['dd:testDeclarations']({
          testSuite, testAnnotations: [{ testName: 'skipped', mustFail, noAutoRetry }],
        })
        cypressPlugin.afterSpec({ relative: testSuite }, {
          tests: [{ title: ['skipped'], state: 'pending', attempts: [] }], stats: { tests: 1, pending: 1 },
        })
        const summary = formatAttemptToFixSummary(cypressPlugin.attemptToFixExecutions)
        assert.strictEqual(cypressPlugin.attemptToFixExecutions.size, noAutoRetry ? 0 : 1)
        for (const flag of ['disabled', 'quarantined']) {
          assert.strictEqual(summary.includes(`marked as ${flag}`), !mustFail && !noAutoRetry)
        }
      })
    }
  }

  for (const uploadFails of [false, true]) {
    it(`waits for recovered screenshot-only spans before closing the run (uploadFails=${uploadFails})`, async () => {
      const { testSessionSpan, createSpan } = prepareRunFinalization()
      const testSpan = createSpan()
      testSpan.finish.callsFake(() => { testSpan._duration = 0 })
      const context = testSessionSpan.context()
      context._trace.started.push(testSpan)
      sinon.stub(testSessionSpan, 'context').returns(context)
      const spec = { relative: 'cypress/e2e/failure.cy.js' }
      cypressPlugin.getTestSuiteSpan({ testSuite: spec.relative })
      cypressPlugin.finishedTestsByFile[spec.relative] = [{
        testName: 'fails', testStatus: 'fail', testSpan, finishTime: 900,
      }]
      let completeUpload
      const exporter = cypressPlugin.tracer._tracer._exporter
      exporter.canUploadTestScreenshots = () => true
      exporter.uploadTestScreenshot = sinon.stub().callsFake((options, callback) => { completeUpload = callback })
      const flush = sinon.spy(exporter, 'flush')
      const afterRunPromise = cypressPlugin.afterRun({
        totalFailed: 1,
        totalTests: 1,
        runs: [{
          spec,
          stats: { failures: 1, tests: 1, endedAt: new Date(1000).toISOString() },
          tests: [{
            title: ['fails'],
            state: 'failed',
            attempts: [{ state: 'failed', screenshots: [{ path: '/tmp/failure.png', testFailure: true }] }],
          }],
        }],
      })
      try {
        sinon.assert.calledOnce(exporter.uploadTestScreenshot)
        sinon.assert.notCalled(testSpan.finish)
        sinon.assert.notCalled(testSessionSpan.finish)
        sinon.assert.notCalled(flush)
      } finally {
        completeUpload(uploadFails ? new Error('synthetic upload failure') : undefined)
        await afterRunPromise
      }
      sinon.assert.calledOnceWithExactly(testSpan.finish, 900)
      assert.strictEqual(testSpan.tags[TEST_FAILURE_SCREENSHOT_UPLOADED], uploadFails ? undefined : 'true')
      assert.strictEqual(testSpan.tags[TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR], uploadFails ? 'true' : undefined)
      sinon.assert.calledOnce(testSessionSpan.finish)
      assert.strictEqual(testSessionSpan.tags[TEST_STATUS], 'fail')
    })
  }

  it('waits for the existing initialization before the first run', async () => {
    const initializationError = new Error('stop after existing initialization')
    cypressPlugin._isInit = true
    cypressPlugin.libraryConfigurationPromise = Promise.reject(initializationError)
    const init = sinon.stub(cypressPlugin, 'init')
    const stop = sinon.spy()
    cypressPlugin.retryConfigObserver = { stop }

    await assert.rejects(cypressPlugin.beforeRun({}), error => {
      assert.strictEqual(error, initializationError)
      return true
    })

    sinon.assert.notCalled(init)
    sinon.assert.calledOnce(stop)
  })

  it('reinitializes before a subsequent interactive run', async () => {
    const initializationError = new Error('stop after reinitialization')
    const tracer = {}
    const cypressConfig = {}
    cypressPlugin._isInit = false
    cypressPlugin.tracer = tracer
    cypressPlugin.cypressConfig = cypressConfig
    const init = sinon.stub(cypressPlugin, 'init').rejects(initializationError)

    await assert.rejects(cypressPlugin.beforeRun({}), error => {
      assert.strictEqual(error, initializationError)
      return true
    })

    sinon.assert.calledOnceWithExactly(init, tracer, cypressConfig)
  })

  for (const [summary, status, reason] of [
    [{ totalTests: 2, totalPassed: 0, totalFailed: 0, totalPending: 2, totalSkipped: 0 },
      'skip', 'all_tests_skipped'],
    [{ totalTests: 2, totalPassed: 0, totalFailed: 0, totalPending: 1, totalSkipped: 1 },
      'skip', 'all_tests_skipped'],
    [{ totalTests: 2, totalPassed: 1, totalFailed: 0, totalPending: 1, totalSkipped: 0 },
      'pass', undefined],
    [{ totalTests: 0, totalPassed: 0, totalFailed: 0, totalPending: 0, totalSkipped: 0 },
      'skip', 'zero_tests'],
  ]) {
    it(`reports zero-execution sessions from Cypress statistics: ${JSON.stringify(summary)}`, async () => {
      const { testModuleSpan, testSessionSpan } = prepareRunFinalization()
      await cypressPlugin.afterRun(summary)
      for (const span of [testSessionSpan, testModuleSpan]) {
        assert.strictEqual(span.tags[TEST_STATUS], status)
        assert.strictEqual(span.tags[TEST_SESSION_EMPTY_REASON], reason)
        assert.strictEqual(span.tags[TEST_SKIP_REASON], reason === 'all_tests_skipped'
          ? 'All tests were skipped'
          : reason === 'zero_tests' ? 'No tests were detected' : undefined)
      }
    })
  }

  it('preserves a failed Cypress run that reports zero tests', async () => {
    const { testModuleSpan, testSessionSpan } = prepareRunFinalization()

    await cypressPlugin.afterRun({ totalFailed: 1, totalSkipped: 0, totalTests: 0 })

    for (const span of [testSessionSpan, testModuleSpan]) {
      assert.strictEqual(span.tags[TEST_STATUS], 'fail')
      assert.strictEqual(span.tags[TEST_SKIP_REASON], undefined)
      assert.strictEqual(span.tags[TEST_SESSION_EMPTY_REASON], undefined)
    }
  })

  it('preserves a Cypress failed-run result that reports no tests', async () => {
    const { testModuleSpan, testSessionSpan } = prepareRunFinalization()

    await cypressPlugin.afterRun({ status: 'failed', failures: 1, message: 'Cypress failed to run' })

    for (const span of [testSessionSpan, testModuleSpan]) {
      assert.strictEqual(span.tags[TEST_STATUS], 'fail')
      assert.strictEqual(span.tags[TEST_SKIP_REASON], undefined)
      assert.strictEqual(span.tags[TEST_SESSION_EMPTY_REASON], undefined)
    }
  })

  it('marks an interactive Cypress run with no statistics or tests as empty', async () => {
    const { testModuleSpan, testSessionSpan } = prepareRunFinalization()

    await cypressPlugin.afterRun()

    for (const span of [testSessionSpan, testModuleSpan]) {
      assert.strictEqual(span.tags[TEST_STATUS], 'skip')
      assert.strictEqual(span.tags[TEST_SKIP_REASON], 'No tests were detected')
      assert.strictEqual(span.tags[TEST_SESSION_EMPTY_REASON], 'zero_tests')
    }
  })

  it('does not mark an interactive Cypress run as empty after receiving a test', async () => {
    const { testModuleSpan, testSessionSpan } = prepareRunFinalization()
    cypressPlugin.testsToSkip = [{ name: 'test name', suite: 'test suite' }]

    cypressPlugin.getTasks()['dd:beforeEach']({
      testId: 'test-id',
      testName: 'test name',
      testSuite: 'test suite',
    })
    await cypressPlugin.afterRun()

    for (const span of [testSessionSpan, testModuleSpan]) {
      assert.strictEqual(span.tags[TEST_STATUS], 'pass')
      assert.strictEqual(span.tags[TEST_SKIP_REASON], undefined)
      assert.strictEqual(span.tags[TEST_SESSION_EMPTY_REASON], undefined)
    }
  })

  it('preserves a failed interactive Cypress run without summary statistics', async () => {
    const { testModuleSpan, testSessionSpan } = prepareRunFinalization()
    cypressPlugin.hasTestsReported = true
    cypressPlugin.testSuiteStatuses.add('fail')

    await cypressPlugin.afterRun()

    for (const span of [testSessionSpan, testModuleSpan]) {
      assert.strictEqual(span.tags[TEST_STATUS], 'fail')
      assert.strictEqual(span.tags[TEST_SKIP_REASON], undefined)
      assert.strictEqual(span.tags[TEST_SESSION_EMPTY_REASON], undefined)
    }
  })

  it('preserves an all-skipped interactive Cypress run without summary statistics', async () => {
    const { testModuleSpan, testSessionSpan } = prepareRunFinalization()
    cypressPlugin.hasTestsReported = true
    cypressPlugin.testSuiteSpan = { finish: sinon.stub(), setTag: sinon.stub() }

    cypressPlugin.afterSpec(
      { relative: 'cypress/e2e/skipped-test.js' },
      { stats: { tests: 1, pending: 1 } }
    )
    await cypressPlugin.afterRun()

    for (const span of [testSessionSpan, testModuleSpan]) {
      assert.strictEqual(span.tags[TEST_STATUS], 'skip')
      assert.strictEqual(span.tags[TEST_SKIP_REASON], 'All tests were skipped')
      assert.strictEqual(span.tags[TEST_SESSION_EMPTY_REASON], 'all_tests_skipped')
    }
  })

  it('preserves a Cypress result error without summary statistics', async () => {
    const { testModuleSpan, testSessionSpan } = prepareRunFinalization()
    const resultError = new Error('Cypress failed to load the spec')
    cypressPlugin.testSuiteSpan = { finish: sinon.stub(), setTag: sinon.stub() }

    cypressPlugin.afterSpec(
      { relative: 'cypress/e2e/load-error.js' },
      { error: resultError }
    )
    await cypressPlugin.afterRun()

    for (const span of [testSessionSpan, testModuleSpan]) {
      assert.strictEqual(span.tags[TEST_STATUS], 'fail')
      assert.strictEqual(span.tags[TEST_SKIP_REASON], undefined)
      assert.strictEqual(span.tags[TEST_SESSION_EMPTY_REASON], undefined)
    }
  })

  for (const [description, cypressConfig] of [
    ['finishes completed suites without an after:run boundary', {
      isTextTerminal: false,
      isInteractive: true,
      experimentalInteractiveRunEvents: false,
    }],
    ['finishes completed suites in terminal runs', {
      isTextTerminal: true,
      // Cypress 12 can leave this true during `cypress run`.
      isInteractive: true,
      experimentalInteractiveRunEvents: false,
    }],
    ['finishes completed suites when interactive run events are enabled', {
      isTextTerminal: false,
      isInteractive: true,
      experimentalInteractiveRunEvents: true,
    }],
  ]) {
    it(description, () => {
      const testSuiteSpan = {
        finish: sinon.stub(),
        setTag: sinon.stub(),
      }
      cypressPlugin.cypressConfig = cypressConfig
      cypressPlugin.finishedTestsByFile = {}
      cypressPlugin.testsToSkip = []
      cypressPlugin.testSuiteSpan = testSuiteSpan
      cypressPlugin.tracer = { _tracer: { _exporter: {} } }
      sinon.stub(cypressPlugin, 'ciVisEvent')

      cypressPlugin.afterSpec({ relative: 'cypress/e2e/basic-pass.js' }, { stats: { tests: 1 } })

      sinon.assert.calledOnce(testSuiteSpan.finish)
    })
  }

  it('starts a suite video upload from after:run after Cypress video processing', async () => {
    const testSuiteSpan = {
      context: () => ({ toSpanId: () => '456' }),
      finish: sinon.stub(),
      setTag: sinon.stub(),
    }
    cypressPlugin.cypressConfig = { isTextTerminal: true }
    cypressPlugin.finishedTestsByFile = {}
    cypressPlugin.testsToSkip = []
    cypressPlugin.pendingScreenshotUploads = []
    cypressPlugin.pendingVideoUploads = []
    cypressPlugin._isInit = true
    sinon.stub(cypressPlugin, '_now').returns(789)
    cypressPlugin.testSessionSpan = { context: () => ({ toTraceId: () => '123' }) }
    cypressPlugin.testSuiteSpan = testSuiteSpan
    const flush = sinon.stub().callsFake(callback => callback())
    cypressPlugin.tracer = {
      _tracer: {
        _exporter: {
          canUploadTestVideos: () => true,
          flush,
          uploadTestSuiteVideo: sinon.stub(),
        },
      },
    }
    cypressPlugin.uploadedVideoPaths = new Set()
    sinon.stub(cypressPlugin, 'ciVisEvent')
    let finishUpload
    const upload = sinon.stub(cypressPlugin, 'uploadTestSuiteVideo').returns(new Promise(resolve => {
      finishUpload = resolve
    }))

    const result = cypressPlugin.afterSpec(
      { relative: 'cypress/e2e/basic-fail.js' },
      { stats: { failures: 1, tests: 1 }, video: '/tmp/basic-fail.mp4' }
    )

    assert.strictEqual(result, undefined)
    sinon.assert.notCalled(upload)
    sinon.assert.notCalled(testSuiteSpan.finish)

    const afterRunPromise = cypressPlugin.afterRun({})

    sinon.assert.calledOnceWithExactly(upload, {
      filePath: '/tmp/basic-fail.mp4',
      testSessionId: '123',
      testSuiteId: '456',
    })
    sinon.assert.calledOnce(flush)
    sinon.assert.notCalled(testSuiteSpan.finish)

    finishUpload(VIDEO_UPLOAD_RESULT_UPLOADED)
    await afterRunPromise

    sinon.assert.calledTwice(flush)
    sinon.assert.calledOnceWithExactly(testSuiteSpan.finish, 789)
    sinon.assert.calledWith(testSuiteSpan.setTag, TEST_FAILURE_VIDEO_UPLOADED, 'true')
    sinon.assert.calledWith(testSuiteSpan.setTag, TEST_FAILURE_VIDEO_SCOPE, VIDEO_UPLOAD_SCOPE_TEST_SUITE)
  })

  it('finalizes a failed suite video when a user after:spec handler prevents after:run', async () => {
    const userError = new Error('user after:spec failed')
    const testSuiteSpan = {
      context: () => ({ toSpanId: () => '456' }),
      finish: sinon.stub(),
      setTag: sinon.stub(),
    }
    cypressPlugin.cypressConfig = { isTextTerminal: true }
    cypressPlugin.finishedTestsByFile = {}
    cypressPlugin.testsToSkip = []
    cypressPlugin.pendingScreenshotUploads = []
    cypressPlugin.pendingVideoUploads = []
    cypressPlugin._isInit = true
    cypressPlugin.testSessionSpan = {
      context: () => ({
        toTraceId: () => '123',
        _trace: { started: [testSuiteSpan] },
      }),
    }
    cypressPlugin.testModuleSpan = null
    cypressPlugin.testSuiteSpan = testSuiteSpan
    cypressPlugin.tracer = {
      _tracer: {
        _exporter: {
          canUploadTestVideos: () => true,
          uploadTestSuiteVideo: sinon.stub(),
        },
      },
    }
    cypressPlugin.uploadedVideoPaths = new Set()
    sinon.stub(cypressPlugin, 'ciVisEvent')
    const upload = sinon.stub(cypressPlugin, 'uploadTestSuiteVideo').resolves(VIDEO_UPLOAD_RESULT_UPLOADED)

    await cypressPlugin.afterSpec(
      { relative: 'cypress/e2e/basic-fail.js' },
      { stats: { passes: 1, tests: 1 }, video: '/tmp/basic-fail.mp4' },
      userError
    )

    sinon.assert.notCalled(upload)
    assert.deepStrictEqual(cypressPlugin.pendingVideoUploads, [])
    sinon.assert.calledOnce(testSuiteSpan.finish)
    sinon.assert.calledWith(testSuiteSpan.setTag, TEST_FAILURE_VIDEO_UPLOAD_ERROR, 'true')
    sinon.assert.calledWith(testSuiteSpan.setTag, TEST_FAILURE_VIDEO_SCOPE, VIDEO_UPLOAD_SCOPE_TEST_SUITE)
  })

  it('keeps suite video uploads out of screenshot cancellation', async () => {
    const uploadTestSuiteVideo = sinon.stub().callsFake((options, callback) => callback())
    cypressPlugin.uploadedVideoPaths = new Set()
    cypressPlugin.screenshotUploadAbortControllers = new Set()
    cypressPlugin.tracer = {
      _tracer: {
        _exporter: {
          canUploadTestVideos: () => true,
          uploadTestSuiteVideo,
        },
      },
    }

    const result = cypressPlugin.uploadTestSuiteVideo({
      filePath: '/tmp/basic-fail.mp4',
      testSessionId: '123',
      testSuiteId: '456',
    })

    assert.strictEqual(await result, VIDEO_UPLOAD_RESULT_UPLOADED)
    sinon.assert.calledOnce(uploadTestSuiteVideo)
    assert.strictEqual(uploadTestSuiteVideo.firstCall.args[0].signal, undefined)
    assert.strictEqual(typeof uploadTestSuiteVideo.firstCall.args[1], 'function')
    const screenshotController = new AbortController()
    cypressPlugin.screenshotUploadAbortControllers.add(screenshotController)
    const laterSpecError = new Error('later spec failed')

    cypressPlugin.abortPendingScreenshotUploads(laterSpecError)

    assert.strictEqual(screenshotController.signal.reason, laterSpecError)
    assert.strictEqual(cypressPlugin.screenshotUploadAbortControllers.size, 0)
  })

  for (const [description, uploadError, expectedTag, unexpectedTag] of [
    [
      'tags every test and the suite when a suite video is uploaded',
      undefined,
      TEST_FAILURE_VIDEO_UPLOADED,
      TEST_FAILURE_VIDEO_UPLOAD_ERROR,
    ],
    [
      'tags every test and the suite when a suite video upload fails',
      new Error('upload failed'),
      TEST_FAILURE_VIDEO_UPLOAD_ERROR,
      TEST_FAILURE_VIDEO_UPLOADED,
    ],
  ]) {
    it(description, async () => {
      const makeSpan = () => ({
        finish: sinon.stub(),
        setTag: sinon.stub(),
      })
      const firstTestSpan = makeSpan()
      const secondTestSpan = makeSpan()
      const testSuiteSpan = makeSpan()
      const uploadTestSuiteVideo = sinon.stub().callsFake((options, callback) => callback(uploadError))
      cypressPlugin.uploadedVideoPaths = new Set()
      cypressPlugin.pendingVideoUploads = [{
        filePath: '/tmp/basic-fail.mp4',
        testSessionId: '123',
        testSuiteId: '456',
        testSpanFinishes: [{ testSpan: firstTestSpan }, { testSpan: secondTestSpan }],
        testSuiteSpan,
      }]
      cypressPlugin.tracer = {
        _tracer: {
          _exporter: {
            canUploadTestVideos: () => true,
            uploadTestSuiteVideo,
          },
        },
      }
      sinon.stub(cypressPlugin, 'ciVisEvent')

      await cypressPlugin.uploadPendingTestSuiteVideos()

      for (const span of [firstTestSpan, secondTestSpan, testSuiteSpan]) {
        sinon.assert.calledWith(span.setTag, expectedTag, 'true')
        sinon.assert.calledWith(span.setTag, TEST_FAILURE_VIDEO_SCOPE, VIDEO_UPLOAD_SCOPE_TEST_SUITE)
        sinon.assert.neverCalledWith(span.setTag, unexpectedTag, 'true')
        sinon.assert.calledOnce(span.finish)
      }
    })
  }

  it('does not add video tags when no suite video upload is configured', () => {
    const testSpan = {
      finish: sinon.stub(),
      setTag: sinon.stub(),
    }

    cypressPlugin.finishTestSpans([{ testSpan }])

    sinon.assert.neverCalledWith(testSpan.setTag, TEST_FAILURE_VIDEO_UPLOADED, 'true')
    sinon.assert.neverCalledWith(testSpan.setTag, TEST_FAILURE_VIDEO_UPLOAD_ERROR, 'true')
    sinon.assert.neverCalledWith(testSpan.setTag, TEST_FAILURE_VIDEO_SCOPE, VIDEO_UPLOAD_SCOPE_TEST_SUITE)
    sinon.assert.calledOnce(testSpan.finish)
  })

  for (const [isTextTerminal, pluginMode] of [[false, false], [true, true], [false], [true]]) {
    for (const retries of [0, 2]) {
      const configDescription = `terminal=${isTextTerminal}, plugin=${pluginMode}, retries=${retries}`
      it(`only applies dynamic ATR in terminal mode (${configDescription})`, async () => {
        prepareRunFinalization()
        cypressPlugin.cypressConfig = { isTextTerminal: pluginMode, isInteractive: true }
        sinon.stub(cypressPlugin, 'isDynamicAtrEnabled').value(true)
        const tasks = cypressPlugin.getTasks()
        const hooks = {}
        const events = {}
        const currentTest = {
          id: 'test-1',
          title: 'fails',
          fullTitle: () => 'fails',
          state: 'failed',
          duration: 1,
          _retries: retries,
        }
        const runner = { runTests () {}, suite: { ctx: { currentTest } } }
        const task = sinon.stub().callsFake((name, args) => {
          const result = name === 'dd:testSuiteStart'
            ? tasks[name](args)
            : name === 'dd:afterEach' ? { dynamicAtrRetryCount: 3 } : {}
          return Promise.resolve(result)
        })

        runInNewContext(fs.readFileSync(
          path.join(__dirname, '../../packages/datadog-plugin-cypress/src/support.js'), 'utf8'
        ), {
          Cypress: {
            _: { isEqual, cloneDeep },
            config: name => {
              if (name === undefined) return { retries, isTextTerminal }
              if (name === 'retries') return retries
              assert.strictEqual(name, 'isTextTerminal')
              return isTextTerminal
            },
            on: (name, callback) => { events[name] = callback },
            mocha: {
              getRunner: () => runner,
              getRootSuite: () => ({ file: 'test.cy.js', eachTest: callback => callback(currentTest) }),
            },
          },
          cy: { task, on () {} },
          before: callback => { hooks.before = callback },
          beforeEach: callback => { hooks.beforeEach = callback },
          afterEach: callback => { hooks.afterEach = callback },
          after: callback => { hooks.after = callback },
        })

        await hooks.before()
        assert.strictEqual(currentTest._retries, isTextTerminal ? Math.max(1, retries) : retries)
        const entryPoints = [
          () => events['test:before:run']({}, currentTest),
          () => events['test:before:run:async']({}, currentTest),
          () => hooks.beforeEach.call({ currentTest }),
        ]
        for (const startTest of entryPoints) {
          currentTest._retries = retries
          await startTest()
          assert.strictEqual(currentTest._retries, isTextTerminal ? Math.max(1, retries) : retries)
        }

        await hooks.afterEach()
        for (const startTest of entryPoints) {
          currentTest._retries = retries
          await startTest()
          assert.strictEqual(currentTest._retries, isTextTerminal ? 3 : retries)
        }
        await hooks.after()
      })
    }

    for (const isDynamicAtrEnabled of [false, true]) {
      const configDescription = `terminal=${isTextTerminal}, plugin=${pluginMode}, dynamic=${isDynamicAtrEnabled}`
      it(`only accounts for ATR in terminal mode (${configDescription})`, () => {
        const { createSpan } = prepareRunFinalization()
        cypressPlugin.cypressConfig = { isTextTerminal: pluginMode, isInteractive: true }
        sinon.stub(cypressPlugin, 'isFlakyTestRetriesEnabled').value(true)
        sinon.stub(cypressPlugin, 'flakyTestRetriesCount').value(1)
        sinon.stub(cypressPlugin, 'isDynamicAtrEnabled').value(isDynamicAtrEnabled)
        sinon.stub(cypressPlugin, 'dynamicAtrBuckets').value([1, 1, 1, 1, 1])
        sinon.stub(cypressPlugin, 'getTestSpan').callsFake(createSpan)
        sinon.stub(cypressPlugin, '_now').returns(123)

        const testSuite = 'cypress/e2e/retries.js'
        const tasks = cypressPlugin.getTasks()
        tasks['dd:testSuiteStart']({ testSuite, isTextTerminal })
        const records = []
        const tests = []
        for (const state of ['failed', 'passed']) {
          const attempts = [{ state: 'failed' }, { state }]
          tests.push({ title: [state], state, attempts })
          for (const [attemptIndex, attempt] of attempts.entries()) {
            const test = { testSuite, testId: state, testName: state, state: attempt.state, duration: 1 }
            tasks['dd:beforeEach'](test)
            const span = cypressPlugin.activeTestSpan
            const result = tasks['dd:afterEach']({ test })
            records.push({ span, result, attemptIndex, state: attempt.state, tagsAfterEach: { ...span.tags } })
          }
        }

        cypressPlugin.afterSpec({ relative: testSuite }, { tests, stats: { tests: 2, failures: 1, passes: 1 } })

        for (const { span, result, attemptIndex, state, tagsAfterEach } of records) {
          const isRetry = attemptIndex > 0
          const hasFailedAllRetries = isTextTerminal && isRetry && state === 'failed' ? 'true' : undefined
          assert.strictEqual(span.tags[TEST_IS_RETRY], isRetry ? 'true' : undefined)
          assert.strictEqual(span.tags[TEST_RETRY_REASON], isRetry
            ? TEST_RETRY_REASON_TYPES[isTextTerminal ? 'atr' : 'ext']
            : undefined)
          assert.strictEqual(tagsAfterEach[TEST_HAS_FAILED_ALL_RETRIES], hasFailedAllRetries)
          assert.strictEqual(span.tags[TEST_HAS_FAILED_ALL_RETRIES], hasFailedAllRetries)
          const finalStatus = state === 'passed' ? 'pass' : 'fail'
          assert.strictEqual(span.tags[TEST_FINAL_STATUS], isRetry ? finalStatus : undefined)
          assert.deepStrictEqual(result, isTextTerminal && isDynamicAtrEnabled ? { dynamicAtrRetryCount: 1 } : null)
          sinon.assert.calledOnce(span.finish)
        }
      })
    }
  }

  for (const screenshot of [undefined, false, true]) {
    for (const video of [undefined, false, true]) {
      for (const captureEnabled of [false, true]) {
        const description = `screenshots=${screenshot}, videos=${video}, capture=${captureEnabled}`
        it(`only enables failure media capture for explicit flags (${description})`, async () => {
          const env = { ...process.env }
          delete env.DD_TEST_FAILURE_SCREENSHOTS_ENABLED
          delete env.DD_TEST_FAILURE_VIDEOS_ENABLED
          if (screenshot !== undefined) env.DD_TEST_FAILURE_SCREENSHOTS_ENABLED = String(screenshot)
          if (video !== undefined) env.DD_TEST_FAILURE_VIDEOS_ENABLED = String(video)
          sinon.stub(process, 'env').value(env)
          const config = {
            screenshotOnRunFailure: captureEnabled,
            video: captureEnabled,
            retries: { openMode: 0, runMode: 0 },
            version: '12.0.0',
          }
          const tracer = { _tracer: { _config: { isServiceUserProvided: false } } }

          const result = await cypressPlugin.init(tracer, config)

          assert.strictEqual(result.screenshotOnRunFailure, screenshot === true || captureEnabled)
          assert.strictEqual(result.video, video === true || captureEnabled)
        })
      }
    }
  }

  it('observes retry writes before installing manual lifecycle hooks once', () => {
    const root = { [Symbol.for('dd-trace.cypress.defer-lifecycle')]: true }
    const retryConfig = { runMode: 2, openMode: 0 }
    const hooks = []
    const runner = { runTests () {}, suite: { ctx: {} } }
    const originalRunTests = runner.runTests
    const context = {
      Cypress: {
        _: { isEqual, cloneDeep },
        config: name => {
          if (name === 'retries') return retryConfig
          assert.strictEqual(name, 'isTextTerminal')
          return true
        },
        state () {},
        on: name => hooks.push(name),
        mocha: { getRunner: () => runner, getRootSuite: () => root },
      },
      cy: { on: name => hooks.push(name) },
      before: () => hooks.push('before'),
      beforeEach: () => hooks.push('beforeEach'),
      afterEach: () => hooks.push('afterEach'),
      after: () => hooks.push('after'),
    }
    runInNewContext(fs.readFileSync(
      path.join(__dirname, '../../packages/datadog-plugin-cypress/src/support.js'), 'utf8'
    ), context)
    assert.deepStrictEqual(hooks, [])
    assert.strictEqual(runner.runTests, originalRunTests)
    const observedRetries = context.Cypress.config('retries')
    assert.notStrictEqual(observedRetries, retryConfig)
    observedRetries.runMode = 2
    const install = root[Symbol.for('dd-trace.cypress.install-lifecycle')]
    install()
    const registered = hooks.slice()
    assert.strictEqual(registered.filter(name => name === 'afterEach').length, 1)
    assert.notStrictEqual(runner.runTests, originalRunTests)
    install()
    assert.deepStrictEqual(hooks, registered)
    assert.strictEqual(context.Cypress.config('retries'), observedRetries)
  })

  for (const fields of [
    ['runMode'], ['openMode'], ['experimentalStrategy'],
    ['experimentalOptions', 'maxRetries'], ['experimentalOptions', 'stopIfAnyPassed'], [],
  ]) {
    it(`preserves the native browser accessor receiver for ${fields.join('.') || 'retries'}`, () => {
      const state = {
        retries: {
          runMode: 2,
          openMode: 1,
          experimentalStrategy: 'detect-flake-but-always-fail',
          experimentalOptions: { maxRetries: 2, stopIfAnyPassed: true },
        },
        isTextTerminal: true,
      }
      const target = fields.length === 2 ? state.retries.experimentalOptions : fields.length ? state.retries : state
      const key = fields.at(-1) || 'retries'
      const value = target[key]
      let reads = 0
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        get () { reads++; return this === target ? value : undefined },
      })
      const root = { file: 'test.cy.js', eachTest () {} }
      const context = {
        Cypress: {
          _: { isEqual, cloneDeep },
          config: name => name === undefined ? state : state[name],
          state () {},
          on () {},
          mocha: { getRunner: () => ({ runTests () {}, suite: { ctx: {} } }), getRootSuite: () => root },
        },
        cy: { on () {} },
        before () {},
        beforeEach () {},
        afterEach () {},
        after () {},
      }
      runInNewContext(fs.readFileSync(
        path.join(__dirname, '../../packages/datadog-plugin-cypress/src/support.js'), 'utf8'
      ), context)
      const before = reads
      const observed = context.Cypress.config()
      const result = fields.reduce((current, field) => current[field], observed.retries)
      if (fields.length) assert.strictEqual(result, value)
      else {
        assert.notStrictEqual(result, value)
        assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), value)
      }
      assert.strictEqual(reads, before + 1)
    })
  }

  it('does not evaluate a retries root accessor during ordinary teardown', async () => {
    const state = { retries: 0, isTextTerminal: true }
    const hooks = {}
    const currentTest = { id: 'ordinary', title: 'ordinary', state: 'passed', fullTitle: () => 'ordinary' }
    const root = { file: 'test.cy.js', eachTest () {} }
    const context = {
      Cypress: {
        _: { isEqual, cloneDeep },
        config: name => name === undefined ? state : state[name],
        state () {},
        on () {},
        mocha: {
          getRunner: () => ({ runTests () {}, suite: { ctx: { currentTest } } }),
          getRootSuite: () => root,
        },
      },
      cy: { on () {}, task: () => Promise.resolve() },
      before () {},
      beforeEach () {},
      after () {},
      afterEach: callback => { hooks.afterEach = callback },
    }
    runInNewContext(fs.readFileSync(
      path.join(__dirname, '../../packages/datadog-plugin-cypress/src/support.js'), 'utf8'
    ), context)
    let reads = 0
    Object.defineProperty(context.Cypress.config(), 'retries', {
      configurable: true,
      get () { reads++; throw new Error('teardown must not evaluate retries') },
    })
    hooks.afterEach()
    assert.strictEqual(reads, 0)
  })

  for (const experimental of [false, true]) {
    it(`reports the active browser retry strategy without extra getter reads (experimental=${experimental})`, () => {
      const state = { retries: 2, isTextTerminal: true }
      const hooks = {}
      let reported
      let reads = 0
      const test = { id: 'policy', title: 'policy', state: 'passed', fullTitle: () => 'policy' }
      const root = { file: 'test.cy.js', eachTest () {} }
      const context = {
        Cypress: {
          _: { isEqual, cloneDeep },
          config: name => name === undefined ? state : state[name],
          getTestRetries () {
            const retries = this.config('retries')
            const strategy = retries.experimentalStrategy
            return strategy && retries.runMode === true ? retries.experimentalOptions.maxRetries : retries.runMode
          },
          state: name => name === 'test' ? test : false,
          on () {},
          mocha: {
            getRunner: () => ({ runTests () {}, suite: { ctx: { currentTest: test } } }),
            getRootSuite: () => root,
          },
        },
        cy: { on () {}, task: (_name, args) => { reported = args.test; return Promise.resolve() } },
        before () {},
        beforeEach () {},
        after () {},
        afterEach: callback => { hooks.afterEach = callback },
      }
      runInNewContext(fs.readFileSync(
        path.join(__dirname, '../../packages/datadog-plugin-cypress/src/support.js'), 'utf8'
      ), context)
      const retries = { runMode: experimental ? true : 2, experimentalOptions: { maxRetries: 2 } }
      Object.defineProperty(retries, 'experimentalStrategy', {
        configurable: true,
        enumerable: true,
        get () { reads++; return experimental ? 'detect-flake-but-always-fail' : undefined },
      })
      Object.defineProperty(context.Cypress.config(), 'retries', { value: retries })
      assert.strictEqual(reads, 0)
      assert.strictEqual(context.Cypress.getTestRetries(), 2)
      assert.strictEqual(reads, 1)
      hooks.afterEach()
      assert.strictEqual(reported.hasNativeExperimentalRetries, experimental)
      assert.strictEqual(reads, 1)
    })
  }

  for (const mode of ['known-root', 'fresh-root', 'known-options', 'configurable-options']) {
    it(`preserves locked browser retry descriptor identity (${mode})`, () => {
      for (const instrumented of [false, true]) {
        const state = { retries: { runMode: 2, openMode: 0, experimentalOptions: { maxRetries: 2 } } }
        const root = { [Symbol.for('dd-trace.cypress.defer-lifecycle')]: true }
        const context = {
          Cypress: {
            _: { isEqual, cloneDeep },
            config: name => name === undefined ? state : state[name],
            state () {},
            mocha: { getRootSuite: () => root },
          },
        }
        if (instrumented) {
          runInNewContext(fs.readFileSync(
            path.join(__dirname, '../../packages/datadog-plugin-cypress/src/support.js'), 'utf8'
          ), context)
        }
        const config = context.Cypress.config()
        const retries = config.retries
        const isOptions = mode.endsWith('options')
        const target = isOptions ? retries : config
        const key = isOptions ? 'experimentalOptions' : 'retries'
        const value = isOptions
          ? retries.experimentalOptions
          : mode === 'known-root' ? retries : { runMode: 2, openMode: 0 }
        const configurable = mode === 'configurable-options'
        Object.defineProperty(target, key, { value, writable: false, configurable })
        assert.strictEqual(target[key], value)
        const descriptor = Object.getOwnPropertyDescriptor(target, key)
        assert.strictEqual(descriptor.value, value)
        assert.strictEqual(descriptor.writable, false)
        assert.strictEqual(descriptor.configurable, configurable)
      }
    })
  }

  it('does not read browser config getters for flags-only descriptor changes', () => {
    for (const instrumented of [false, true]) {
      const state = { retries: { runMode: 0, openMode: 0 } }
      let reads = 0
      Object.defineProperty(state, 'custom', {
        configurable: true,
        get () { reads++; return 1 },
      })
      const root = { [Symbol.for('dd-trace.cypress.defer-lifecycle')]: true }
      const context = {
        Cypress: {
          _: { isEqual, cloneDeep },
          config: name => name === undefined ? state : state[name],
          state () {},
          mocha: { getRootSuite: () => root },
        },
      }
      if (instrumented) {
        runInNewContext(fs.readFileSync(
          path.join(__dirname, '../../packages/datadog-plugin-cypress/src/support.js'), 'utf8'
        ), context)
      }
      Object.defineProperty(context.Cypress.config(), 'custom', { configurable: false })
      assert.strictEqual(reads, 0)
    }
  })

  for (const key of ['retries', 'custom']) {
    it(`deletes browser ${key} accessors without evaluating them`, () => {
      for (const instrumented of [false, true]) {
        const state = { retries: 0 }
        const root = { [Symbol.for('dd-trace.cypress.defer-lifecycle')]: true }
        const context = {
          Cypress: {
            _: { isEqual, cloneDeep },
            config: name => name === undefined ? state : state[name],
            state () {},
            mocha: { getRootSuite: () => root },
          },
        }
        if (instrumented) {
          runInNewContext(fs.readFileSync(
            path.join(__dirname, '../../packages/datadog-plugin-cypress/src/support.js'), 'utf8'
          ), context)
        }
        let reads = 0
        const config = context.Cypress.config()
        Object.defineProperty(config, key, {
          configurable: true,
          get () {
            reads++
            throw new Error('deletion must not evaluate the getter')
          },
        })
        assert.strictEqual(Reflect.deleteProperty(config, key), true)
        assert.strictEqual(reads, 0)
        assert.strictEqual(Object.getOwnPropertyDescriptor(state, key), undefined)
      }
    })
  }

  for (const stage of ['complete', 'restoring', 'pending', 'suite', 'explicit-root']) {
    it(`retains saved browser retry object provenance at ${stage} stage`, async () => {
      const localRetries = { runMode: 2, openMode: 0 }
      const state = { retries: { runMode: 4, openMode: 0 }, isTextTerminal: true }
      let currentTest
      const hooks = {}
      const events = {}
      const root = { file: 'test.cy.js', eachTest () {} }
      const context = {
        Cypress: {
          _: { isEqual, cloneDeep },
          config: function (key, value) {
            if (!arguments.length) return state
            if (arguments.length > 1) state[key] = value
            return state[key]
          },
          state: name => name === 'test' ? currentTest : false,
          on: (name, callback) => { events[name] = callback },
          mocha: { getRunner: () => ({ runTests () {}, suite: { ctx: {} } }), getRootSuite: () => root },
        },
        cy: {
          on () {},
          task: () => Promise.resolve({
            frameworkRetries: 0,
            originalRetries: { runMode: 0, openMode: 0 },
            configuredRetries: { runMode: 4, openMode: 0 },
            isTextTerminal: true,
          }),
        },
        before: callback => { hooks.before = callback },
        beforeEach () {},
        afterEach () {},
        after () {},
      }
      runInNewContext(fs.readFileSync(
        path.join(__dirname, '../../packages/datadog-plugin-cypress/src/support.js'), 'utf8'
      ), context)
      await hooks.before()
      const applied = ['suite', 'explicit-root'].includes(stage)
        ? 'complete'
        : stage === 'pending' ? undefined : stage
      currentTest = {
        _testConfig: { applied, unverifiedTestConfig: stage === 'suite' ? {} : { retries: localRetries } },
        ...(stage === 'suite' && { parent: { _testConfig: { retries: localRetries } } }),
      }
      if (['complete', 'suite', 'explicit-root'].includes(stage)) state.retries = { ...localRetries }
      if (stage === 'explicit-root') context.Cypress.config('retries', { runMode: 3, openMode: 0 })
      const saved = context.Cypress.config('retries')
      state.retries = { runMode: 4, openMode: 0 }
      currentTest = {
        _testConfig: { applied: 'complete', unverifiedTestConfig: {} },
        _ddTestAnnotations: { noAutoRetry: true },
        _retries: 4,
      }
      context.Cypress.config('retries', saved)
      events['test:before:run']({}, currentTest)
      assert.strictEqual(currentTest._retries, stage === 'explicit-root'
        ? 3
        : stage === 'complete' || stage === 'suite' ? 2 : 0)
    })
  }

  for (const mode of [
    'field-mode', 'field-child-options', 'saved-accessor-options', 'detached-accessor-options',
    'object-config-getter', 'inherited-config-getter', 'accessor-root',
    'raw-after', 'raw-before', 'raw-saved', 'raw-detached', 'locked-root', 'locked-root-unchanged',
    'suite-owner', 'suite-root-owner', 'framework-known-root', 'framework-scalar',
    'same-options', 'locked-options', 'assigned-options', 'raw-locked-options',
    'pre-suite-options', 'queued-detached-options', 'descriptor-root', 'descriptor-options',
    'saved-options', 'saved-descriptor-options', 'saved-detached-options', 'saved-checkpoint-options',
    'cross-root-options', 'cross-root-descriptor-options', 'cross-root-detached-options',
    'cross-root-queued-options',
    'saved-equal-options',
    'saved-queued-options', 'saved-initial-options',
    'inactive-mode', 'deleted-mode', 'partial-root', 'same-root', 'saved-root', 'runtime-root',
    'threshold-options', 'disabled-options', 'threshold-disabled-options',
  ]) {
    it(`reconciles observed browser retry snapshots for ${mode}`, async () => {
      const scalar = mode === 'framework-scalar'
      const experimental = mode.endsWith('-options')
      const experimentalPolicy = ['threshold-options', 'disabled-options', 'threshold-disabled-options'].includes(mode)
      const native = experimental
        ? {
            runMode: !mode.includes('disabled'),
            openMode: false,
            experimentalStrategy: mode.startsWith('threshold')
              ? 'detect-flake-and-pass-on-threshold'
              : 'detect-flake-but-always-fail',
            experimentalOptions: mode.startsWith('threshold')
              ? { maxRetries: 2, passesRequired: 2 }
              : { maxRetries: 2, stopIfAnyPassed: false },
          }
        : scalar ? 0 : { runMode: 0, openMode: 0 }
      const configured = experimental
        ? { ...native, runMode: true, experimentalOptions: { ...native.experimentalOptions, maxRetries: 4 } }
        : scalar ? 0 : { runMode: 4, openMode: 0 }
      const state = { retries: cloneDeep(configured), isTextTerminal: true }
      const currentTest = {
        _testConfig: { applied: 'complete', unverifiedTestConfig: {} },
        _ddTestAnnotations: { noAutoRetry: true },
        _retries: 4,
        ...(experimentalPolicy && { id: 'excluded', title: 'excluded', fullTitle: () => 'excluded', state: 'failed' }),
      }
      const hooks = {}
      const events = {}
      const root = { file: 'test.cy.js', eachTest () {} }
      let report
      const context = {
        Cypress: {
          _: { isEqual, cloneDeep },
          ...((mode.startsWith('field-') || mode === 'saved-accessor-options') && {
            getTestRetries (...args) {
              assert.strictEqual(this, context.Cypress)
              if (args.length) assert.deepStrictEqual(args, ['native-budget', currentTest])
              const retries = this.config('retries')
              const active = retries.runMode
              return active === true ? retries.experimentalOptions.maxRetries : active
            },
          }),
          config: function (key, value) {
            if (!arguments.length) return state
            if (key && typeof key === 'object') {
              for (const name in key) state[name] = key[name]
              return key
            }
            if (arguments.length > 1) state[key] = value
            return state[key]
          },
          state: name => name === 'test' ? currentTest : false,
          on: (name, callback) => { events[name] = callback },
          mocha: { getRunner: () => ({ runTests () {}, suite: { ctx: { currentTest } } }), getRootSuite: () => root },
        },
        cy: {
          on () {},
          task: (name, args) => {
            if (name === 'dd:afterEach') {
              report = args.test
              return Promise.resolve({ dynamicAtrRetryCount: 0 })
            }
            return Promise.resolve({
              frameworkRetries: experimental && native.runMode ? 2 : 0,
              originalRetries: native,
              configuredRetries: configured,
              isTextTerminal: true,
              isDynamicAtrEnabled: experimentalPolicy,
            })
          },
        },
        before: callback => { hooks.before = callback },
        beforeEach () {},
        afterEach: callback => { hooks.afterEach = callback },
        after () {},
      }
      runInNewContext(fs.readFileSync(
        path.join(__dirname, '../../packages/datadog-plugin-cypress/src/support.js'), 'utf8'
      ), context)
      if (mode === 'saved-accessor-options') {
        await hooks.before()
        const saved = context.Cypress.config('retries')
        let reads = 0
        Object.defineProperty(context.Cypress.config(), 'retries', {
          configurable: true,
          get () { reads++; return saved },
        })
        assert.strictEqual(reads, 0)
        currentTest._retries = context.Cypress.getTestRetries()
        const nativeReads = reads
        events['test:before:run']({}, currentTest)
        assert.strictEqual(currentTest._retries, 2)
        assert.strictEqual(reads, nativeReads)
        return
      }
      if (mode === 'detached-accessor-options') {
        await hooks.before()
        const retries = context.Cypress.config('retries')
        const saved = retries.experimentalOptions
        let reads = 0
        Object.defineProperty(retries, 'experimentalOptions', {
          configurable: true,
          get () { reads++; throw new Error('replacement getter must remain unread') },
        })
        saved.maxRetries = 3
        assert.strictEqual(reads, 0)
        return
      }
      if (mode.startsWith('field-')) {
        await hooks.before()
        const retries = context.Cypress.config('retries')
        const nested = mode === 'field-child-options'
        const target = nested ? retries.experimentalOptions : retries
        const key = nested ? 'maxRetries' : 'runMode'
        let ready = false
        let reads = 0
        Object.defineProperty(target, key, {
          enumerable: true,
          configurable: true,
          get () {
            if (!ready) throw new Error('retry getter read before support initialized')
            reads++
            return 3
          },
        })
        Object.defineProperty(target, key, { configurable: false })
        retries.openMode = 1
        assert.strictEqual(reads, 0)
        ready = true
        currentTest._retries = context.Cypress.getTestRetries('native-budget', currentTest)
        assert.strictEqual(currentTest._retries, 3)
        const nativeReads = reads
        events['test:before:run']({}, currentTest)
        events['test:before:run:async']({}, currentTest)
        assert.strictEqual(currentTest._retries, 3)
        assert.strictEqual(reads, nativeReads)
        return
      }
      if (mode.startsWith('cross-root-')) {
        if (mode !== 'cross-root-queued-options') await hooks.before()
        const config = context.Cypress.config
        const saved = config('retries').experimentalOptions
        config().retries = { ...native, experimentalOptions: { maxRetries: 1, stopIfAnyPassed: false } }
        const replacement = config('retries')
        if (mode === 'cross-root-detached-options') saved.maxRetries = 3
        if (mode === 'cross-root-descriptor-options') {
          Object.defineProperty(replacement, 'experimentalOptions', { value: saved })
        } else replacement.experimentalOptions = saved
        if (mode === 'cross-root-queued-options') await hooks.before()
        events['test:before:run']({}, currentTest)
        assert.strictEqual(currentTest._retries, mode === 'cross-root-detached-options' ? 3 : 2)
        return
      }
      if (['saved-queued-options', 'saved-initial-options'].includes(mode)) {
        const retries = context.Cypress.config('retries')
        const saved = retries.experimentalOptions
        retries.experimentalOptions = { maxRetries: 1, stopIfAnyPassed: false }
        if (mode === 'saved-queued-options') saved.maxRetries = 3
        retries.experimentalOptions = saved
        await hooks.before()
        events['test:before:run']({}, currentTest)
        assert.strictEqual(currentTest._retries, mode === 'saved-queued-options' ? 3 : 2)
        return
      }
      if (mode === 'queued-detached-options') {
        const config = context.Cypress.config
        const retries = config('retries')
        const proxied = retries.experimentalOptions
        const raw = Object.getOwnPropertyDescriptor(retries, 'experimentalOptions').value
        raw.maxRetries = 3
        retries.experimentalOptions = proxied
        config('retries', 0)
        await hooks.before()
        proxied.maxRetries = 4
        raw.maxRetries = 3
        config('retries', retries)
        events['test:before:run']({}, currentTest)
        assert.strictEqual(currentTest._retries, 3)
        return
      }
      if (mode === 'pre-suite-options') {
        const retries = context.Cypress.config('retries')
        const proxied = retries.experimentalOptions
        const raw = Object.getOwnPropertyDescriptor(retries, 'experimentalOptions').value
        raw.maxRetries = 3
        retries.experimentalOptions = proxied
        raw.maxRetries = 4
        await hooks.before()
        events['test:before:run']({}, currentTest)
        assert.strictEqual(currentTest._retries, 4)
        return
      }
      await hooks.before()
      const config = context.Cypress.config
      if (experimentalPolicy) {
        const budget = native.runMode ? 2 : 0
        events['test:before:run']({}, currentTest)
        assert.strictEqual(currentTest._retries, budget)
        await hooks.afterEach()
        assert.strictEqual(report.nativeRetryFloor, budget)
        assert.strictEqual(report.hasNativeExperimentalRetries, true)
        events['test:before:run']({}, currentTest)
        assert.strictEqual(currentTest._retries, budget)
        return
      }
      if (['inactive-mode', 'deleted-mode', 'partial-root', 'same-root', 'saved-root', 'runtime-root'].includes(mode)) {
        if (mode === 'inactive-mode') config('retries').openMode = 1
        if (mode === 'deleted-mode') delete config('retries').runMode
        if (mode === 'partial-root') config('retries', { openMode: 1 })
        if (mode === 'same-root') {
          const saved = config('retries')
          config().retries = saved
          saved.runMode = 2
        }
        if (mode === 'saved-root') {
          const saved = config('retries')
          config('retries', 1)
          config('retries', saved)
        }
        if (mode === 'runtime-root') config('retries', 2)
        events['test:before:run']({}, currentTest)
        assert.strictEqual(currentTest._retries, ['same-root', 'runtime-root'].includes(mode) ? 2 : 0)
        return
      }
      if (experimental) {
        const retries = config('retries')
        const saved = retries.experimentalOptions
        if (mode.startsWith('saved-')) {
          const raw = Object.getOwnPropertyDescriptor(retries, 'experimentalOptions').value
          retries.experimentalOptions = { maxRetries: 1, stopIfAnyPassed: false }
          if (mode === 'saved-detached-options') saved.maxRetries = 3
          if (mode === 'saved-equal-options') saved.maxRetries = 4
          if (mode === 'saved-checkpoint-options') {
            raw.maxRetries = 3
            Object.defineProperty(saved, 'stopIfAnyPassed', { configurable: false })
            raw.maxRetries = 4
          }
          events['test:before:run']({}, currentTest)
          assert.strictEqual(currentTest._retries, 1)
          if (mode === 'saved-descriptor-options') {
            Object.defineProperty(retries, 'experimentalOptions', { value: saved })
          } else retries.experimentalOptions = saved
          assert.strictEqual(retries.experimentalOptions, saved)
          events['test:before:run']({}, currentTest)
          assert.strictEqual(currentTest._retries, mode === 'saved-detached-options'
            ? 3
            : ['saved-checkpoint-options', 'saved-equal-options'].includes(mode) ? 4 : 2)
          return
        }
        if (mode === 'descriptor-options') {
          const descriptor = Object.getOwnPropertyDescriptor(retries, 'experimentalOptions')
          assert.strictEqual(descriptor.value, state.retries.experimentalOptions)
          descriptor.value.maxRetries = 3
        } else if (mode === 'assigned-options') retries.experimentalOptions = saved
        else if (mode === 'raw-locked-options') {
          Object.defineProperty(retries, 'experimentalOptions', { writable: false, configurable: false })
          retries.experimentalOptions.maxRetries = 3
        } else {
          const locked = mode === 'locked-options'
          Object.defineProperty(retries, 'experimentalOptions', {
            value: saved, writable: !locked, configurable: !locked,
          })
        }
        if (mode !== 'raw-locked-options') assert.strictEqual(retries.experimentalOptions, saved)
        events['test:before:run']({}, currentTest)
        assert.strictEqual(currentTest._retries, ['raw-locked-options', 'descriptor-options'].includes(mode) ? 3 : 2)
        return
      }
      if (mode.startsWith('framework-')) {
        const original = config('retries')
        config('retries', 2)
        currentTest._testConfig.applied = 'restoring'
        config('retries', original)
        currentTest._testConfig.applied = 'complete'
        events['test:before:run']({}, currentTest)
        assert.strictEqual(currentTest._retries, 0)
        return
      }
      if (mode.startsWith('suite-')) {
        currentTest.parent = { _testConfig: { retries: { runMode: 2, openMode: 0 } } }
        const raw = { runMode: 2, openMode: 0 }
        state.retries = raw
        if (mode === 'suite-owner') {
          config('retries').openMode = 1
          raw.runMode = 3
        } else {
          config('retries', { runMode: 3, openMode: 0 })
        }
        events['test:before:run']({}, currentTest)
        assert.strictEqual(currentTest._retries, 2)
        delete currentTest.parent
        currentTest._testConfig.applied = 'restoring'
        config('retries', { runMode: 4, openMode: 0 })
        currentTest._testConfig.applied = 'complete'
        events['test:before:run']({}, currentTest)
        assert.strictEqual(currentTest._retries, 0)
        return
      }
      if (mode === 'object-config-getter' || mode === 'inherited-config-getter') {
        let reads = 0
        const prototype = { inherited: 'retained' }
        const supplied = Object.create(prototype)
        Object.defineProperty(mode === 'inherited-config-getter' ? prototype : supplied, 'retries', {
          enumerable: true, get: () => ++reads,
        })
        Object.defineProperty(supplied, Symbol('ignored'), {
          enumerable: true,
          get () {
            throw new Error('native configuration ignores symbol properties')
          },
        })
        assert.strictEqual(config(supplied), supplied)
        assert.strictEqual(reads, 1)
        assert.strictEqual(state.retries, 1)
        assert.strictEqual(state.inherited, 'retained')
        events['test:before:run']({}, currentTest)
        assert.strictEqual(currentTest._retries, 1)
        return
      }
      if (mode === 'accessor-root') {
        let reads = 0
        let budget = 2
        const getter = () => { reads++; return budget }
        Object.defineProperty(config(), 'retries', { get: getter, configurable: true, enumerable: true })
        assert.strictEqual(reads, 0)
        assert.strictEqual(Object.getOwnPropertyDescriptor(config(), 'retries').get, getter)
        assert.strictEqual(reads, 0)
        assert.strictEqual(Reflect.set(config(), 'retries', 9), false)
        assert.strictEqual(reads, 0)
        assert.throws(() => config('retries', 9), TypeError)
        assert.strictEqual(reads, 0)
        assert.strictEqual(config('retries'), 2)
        assert.strictEqual(reads, 1)
        events['test:before:run']({}, currentTest)
        assert.strictEqual(currentTest._retries, 2)
        budget = 3
        events['test:before:run']({}, currentTest)
        assert.strictEqual(currentTest._retries, 3)
        const beforeReplacement = reads
        Object.defineProperty(config(), 'retries', { value: 0, writable: true })
        assert.strictEqual(reads, beforeReplacement)
        events['test:before:run']({}, currentTest)
        assert.strictEqual(currentTest._retries, 0)
        Object.defineProperty(config(), 'retries', {
          get: getter,
          set: value => { budget = value },
          configurable: true,
        })
        const beforeSet = reads
        assert.strictEqual(Reflect.set(config(), 'retries', 5), true)
        assert.strictEqual(reads, beforeSet)
        assert.strictEqual(budget, 5)
        config('retries', 6)
        assert.strictEqual(reads, beforeSet + 1)
        assert.strictEqual(budget, 6)
        return
      }
      if (mode === 'descriptor-root') {
        const descriptor = Object.getOwnPropertyDescriptor(config(), 'retries')
        assert.strictEqual(descriptor.value, state.retries)
        assert.strictEqual(descriptor.writable, true)
        assert.strictEqual(descriptor.configurable, true)
        descriptor.value.runMode = 3
      } else if (mode.startsWith('locked-root')) {
        Object.defineProperty(config(), 'retries', { writable: false, configurable: false })
        if (mode === 'locked-root') config().retries.runMode = 3
      } else {
        const raw = { runMode: mode === 'raw-detached' ? 3 : 1, openMode: 0 }
        config('retries', raw)
        const observed = config('retries')
        if (mode === 'raw-before') raw.runMode = 3
        observed.openMode = 1
        if (['raw-saved', 'raw-detached'].includes(mode)) config('retries', 0)
        if (mode === 'raw-detached') observed.runMode = 1
        if (mode !== 'raw-before') raw.runMode = 3
        if (['raw-saved', 'raw-detached'].includes(mode)) config('retries', observed)
      }
      events['test:before:run']({}, currentTest)
      assert.strictEqual(currentTest._retries, mode === 'locked-root-unchanged' ? 0 : 3)
    })
  }

  it('restores declaration capture after a skipped-suite callback throws', () => {
    const declareTest = (title, callback) => ({ title, fn: callback, stack: new Error().stack })
    const declareSuite = (title, callback) => callback()
    declareSuite.skip = (title, callback) => callback()
    const root = { file: 'test.cy.js', eachTest () {} }
    const context = {
      Cypress: {
        _: { isEqual, cloneDeep },
        config: name => {
          if (name === 'retries') return 0
          assert.strictEqual(name, 'isTextTerminal')
          return true
        },
        on () {},
        mocha: { getRunner: () => ({ runTests () {}, suite: { ctx: {} } }), getRootSuite: () => root },
      },
      cy: { on () {} },
      before () {},
      beforeEach () {},
      afterEach () {},
      after () {},
      it: declareTest,
      specify: declareTest,
      describe: declareSuite,
    }
    runInNewContext(fs.readFileSync(
      path.join(__dirname, '../../packages/datadog-plugin-cypress/src/support.js'), 'utf8'
    ), context)
    const alias = context.it
    const error = new Error('suite declaration failed')
    assert.throws(() => context.describe.skip('throws', () => { throw error }), candidate => candidate === error)
    const callback = () => {}
    callback[Symbol.for('dd-trace:test-annotations')] = { mustFail: true, noAutoRetry: true }
    const test = alias('after declaration failure', callback)
    assert.strictEqual(context.it, alias)
    assert.strictEqual(test.fn, callback)
    assert.doesNotMatch(test.stack, /captureTestDeclaration/)
  })

  it('preserves native data descriptors and captures fresh retry roots at handoff', () => {
    const observeRetryConfig = require('../../packages/datadog-plugin-cypress/src/retry-config-observer')
    const config = { retries: { runMode: 2, openMode: 0 } }
    const changes = []
    const observer = observeRetryConfig(config, value => changes.push(JSON.parse(JSON.stringify(value))))
    try {
      assert.strictEqual(JSON.stringify(config), '{"retries":{"runMode":2,"openMode":0}}')
      assert.strictEqual(changes.length, 0)
      const descriptor = Object.getOwnPropertyDescriptor(config, 'retries')
      assert.strictEqual(descriptor.get, undefined)
      assert.strictEqual(descriptor.set, undefined)
      assert.strictEqual(descriptor.writable, true)
      const stale = config.retries
      config.retries = { runMode: 2, openMode: 0 }
      stale.runMode = 8
      assert.strictEqual(changes.length, 0)
      const current = config.retries
      observer.stop()
      assert.deepStrictEqual(changes, [{ runMode: 2, openMode: 0 }])
      assert.strictEqual(Object.getOwnPropertyDescriptor(config, 'retries').enumerable, true)
      current.runMode = 3
      assert.strictEqual(changes.length, 1)
      assert.strictEqual(config.retries.runMode, 3)
    } finally {
      observer.stop(false)
    }
  })

  it('preserves retry observer aliases and paths through same-reference root assignments', () => {
    const observeRetryConfig = require('../../packages/datadog-plugin-cypress/src/retry-config-observer')
    const config = { retries: { runMode: 2, openMode: 0 } }
    const writes = []
    const observer = observeRetryConfig(config, (value, path) => writes.push(path))
    try {
      const alias = config.retries
      config.retries = alias
      assert.strictEqual(config.retries, alias)
      assert.deepStrictEqual(writes, [])
      alias.openMode = 1
      alias.runMode = 2
      assert.deepStrictEqual(writes, [['openMode'], ['runMode']])
      config.retries = { runMode: 2 }
      assert.deepStrictEqual(writes, [['openMode'], ['runMode']])
      observer.stop()
      assert.deepStrictEqual(writes, [['openMode'], ['runMode'], []])
    } finally {
      observer.stop()
    }
  })

  it('preserves frozen retry objects and does not replace readonly data descriptors', () => {
    const observeRetryConfig = require('../../packages/datadog-plugin-cypress/src/retry-config-observer')
    const config = { retries: 0 }
    const changes = []
    const observer = observeRetryConfig(config, value => changes.push(value))
    const frozen = Object.freeze({ runMode: true, experimentalOptions: Object.freeze({ maxRetries: 2 }) })
    config.retries = frozen
    assert.deepStrictEqual(JSON.parse(JSON.stringify(config.retries)), frozen)
    assert.strictEqual(changes.length, 0)
    observer.stop()
    assert.strictEqual(changes.length, 1)
    assert.strictEqual(config.retries, frozen)
    Object.defineProperty(config, 'retries', { configurable: false, writable: false })
    assert.strictEqual(observeRetryConfig(config, () => assert.fail('must not observe')), undefined)
    assert.strictEqual(config.retries, frozen)
  })

  for (const inherited of [false, true]) {
    it(`ignores omitted setup reply retry getters (inherited=${inherited})`, async () => {
      const observeSetupHandoff = require('../../packages/datadog-plugin-cypress/src/setup-handoff')
      const descriptor = Object.getOwnPropertyDescriptor(process, 'send')
      const receiver = {}
      const handle = {}
      const options = { keepOpen: true }
      const callback = () => {}
      let reads = 0
      const owner = {}
      Object.defineProperty(owner, 'retries', {
        enumerable: inherited,
        get () {
          reads++
          throw new Error('omitted retry getter must not run')
        },
      })
      const setupConfig = inherited ? Object.create(owner) : owner
      const message = { event: 'setupTestingType:reply', args: [{ setupConfig }] }
      const nativeWire = JSON.parse(JSON.stringify(message))
      let observed
      let forwarded
      process.send = function (...args) {
        assert.strictEqual(this, receiver)
        forwarded = args
        assert.deepStrictEqual(JSON.parse(JSON.stringify(args[0])), nativeWire)
        return 42
      }
      const stop = observeSetupHandoff(config => { observed = config })
      try {
        assert.strictEqual(process.send.call(receiver, message, handle, options, callback), 42)
        assert.strictEqual(reads, 0)
        assert.strictEqual(observed, undefined)
        assert.deepStrictEqual(forwarded.slice(1), [handle, options, callback])
        assert.strictEqual(message.args[0].setupConfig, setupConfig)
      } finally {
        stop()
        if (descriptor) Object.defineProperty(process, 'send', descriptor)
        else delete process.send
      }
    })
  }

  it('serializes returned retry getter values once while retaining IPC arguments', () => {
    const observeRetryConfig = require('../../packages/datadog-plugin-cypress/src/retry-config-observer')
    const descriptor = Object.getOwnPropertyDescriptor(process, 'send')
    const calls = []
    const originalSend = function (...args) {
      calls.push({ receiver: this, args, wire: JSON.parse(JSON.stringify(args[0])) })
      return 17
    }
    Object.defineProperty(process, 'send', { configurable: true, writable: true, value: originalSend })
    const config = { retries: 0 }
    const changes = []
    const observer = observeRetryConfig(config, value => changes.push(value))
    try {
      let reads = 0
      const getter = () => ++reads
      const returned = Object.freeze(Object.defineProperty({}, 'retries', { enumerable: true, get: getter }))
      const extra = { preserved: true }
      const message = Object.freeze({
        event: 'setupTestingType:reply',
        args: Object.freeze([Object.freeze({ setupConfig: returned, extra }), extra]),
      })
      const receiver = {}
      const handle = {}
      const options = {}
      const callback = () => {}
      assert.strictEqual(process.send.call(receiver, message, handle, options, callback), 17)
      assert.strictEqual(reads, 1)
      assert.deepStrictEqual(changes, [1])
      assert.strictEqual(calls.length, 1)
      assert.strictEqual(calls[0].receiver, receiver)
      assert.strictEqual(calls[0].args[1], handle)
      assert.strictEqual(calls[0].args[2], options)
      assert.strictEqual(calls[0].args[3], callback)
      assert.strictEqual(calls[0].args[0].args[1], extra)
      assert.strictEqual(calls[0].args[0].args[0].extra, extra)
      assert.strictEqual(calls[0].wire.args[0].setupConfig.retries, 1)
      assert.strictEqual(message.args[0].setupConfig, returned)
      assert.strictEqual(Object.getOwnPropertyDescriptor(returned, 'retries').get, getter)
      assert.strictEqual(process.send, originalSend)
    } finally {
      observer.stop(false)
      if (descriptor) Object.defineProperty(process, 'send', descriptor)
      else delete process.send
    }
  })

  it('observes the native setup snapshot and restores IPC identity without mutating the input', () => {
    const observeRetryConfig = require('../../packages/datadog-plugin-cypress/src/retry-config-observer')
    const descriptor = Object.getOwnPropertyDescriptor(process, 'send')
    const calls = []
    const originalSend = function (...args) { calls.push({ receiver: this, args }); return 17 }
    Object.defineProperty(process, 'send', { configurable: true, writable: true, value: originalSend })
    let observer
    try {
      const config = { retries: { runMode: 2, openMode: 0 } }
      const changes = []
      observer = observeRetryConfig(config, value => changes.push(value))
      const receiver = {}
      const unrelated = { event: 'other:reply', args: [{ setupConfig: { retries: 9 } }] }
      assert.strictEqual(process.send.call(receiver, unrelated, 'handle', 'options'), 17)
      assert.strictEqual(changes.length, 0)
      assert.notStrictEqual(process.send, originalSend)
      assert.strictEqual(calls[0].receiver, receiver)
      assert.deepStrictEqual(calls[0].args, [unrelated, 'handle', 'options'])
      const returnedConfig = { retries: { runMode: 2, openMode: 0 } }
      const reply = { event: 'setupTestingType:reply', args: [{ setupConfig: returnedConfig }] }
      assert.strictEqual(process.send(reply), 17)
      assert.strictEqual(changes.length, 1)
      assert.deepStrictEqual(changes[0], returnedConfig.retries)
      assert.deepStrictEqual(calls[1].args[0], reply)
      assert.strictEqual(observer.isWatching(config), false)
      assert.strictEqual(Object.getOwnPropertyDescriptor(config, 'retries').get, undefined)
      config.retries.openMode = 7
      assert.strictEqual(changes.length, 1)
      assert.strictEqual(process.send, originalSend)
      observer.stop()
      observer = observeRetryConfig(config, value => changes.push(value))
      process.send({ event: 'setupTestingType:error', args: [{ error: 'setup failed' }] })
      assert.strictEqual(changes.length, 1)
      assert.strictEqual(process.send, originalSend)
      observer.stop()
      observer = observeRetryConfig(config, value => changes.push(value))
      observer.stopIpc()
      assert.strictEqual(process.send, originalSend)
      // This branch checks IPC-only cleanup, without a final configuration snapshot.
      observer.stop(false)
      observer = observeRetryConfig(config, value => changes.push(value))
      const retained = process.send
      const outer = function (...args) { return retained.apply(this, args) }
      process.send = outer
      observer.stopIpc()
      const laterReply = { event: 'setupTestingType:reply', args: [{ setupConfig: { retries: 9 } }] }
      assert.strictEqual(process.send.call(receiver, laterReply, 'handle'), 17)
      assert.strictEqual(changes.length, 1)
      assert.strictEqual(process.send, outer)
      assert.strictEqual(calls.at(-1).receiver, receiver)
      assert.deepStrictEqual(calls.at(-1).args, [laterReply, 'handle'])
      config.retries.runMode = 2
      assert.strictEqual(changes.length, 2)
    } finally {
      observer?.stop()
      if (descriptor) Object.defineProperty(process, 'send', descriptor)
      else delete process.send
    }
  })

  it('rearms retry observation on the same config without mutating developer-held native data', async () => {
    const nativeRetries = { openMode: 0, runMode: 0 }
    const config = { retries: nativeRetries, version: '12.0.0' }
    const tracer = { _tracer: { _config: { isServiceUserProvided: false } } }
    assert.strictEqual(await cypressPlugin.init(tracer, config), config)
    const prior = config.retries
    config.retries.runMode = 2
    assert.deepStrictEqual(nativeRetries, { openMode: 0, runMode: 0 })
    assert.deepStrictEqual(cypressPlugin.originalCypressRetries, { openMode: 0, runMode: 2 })
    assert.strictEqual(await cypressPlugin.init(tracer, config), config)
    prior.runMode = 7
    assert.strictEqual(config.retries.runMode, 2)
    assert.strictEqual(cypressPlugin.originalCypressRetries.runMode, 2)
    config.retries.runMode = 2
    assert.deepStrictEqual(JSON.parse(JSON.stringify(config.retries)), { openMode: 0, runMode: 2 })
    assert.strictEqual(cypressPlugin.retryConfigObserver.isWatching(config), true)
  })

  for (const mode of ['deleted', 'redefined', 'intact']) {
    it(`reconciles ${mode} root retries at the beforeRun fallback without an IPC handoff`, async () => {
      const config = { retries: { runMode: 0, openMode: 0 }, version: '12.0.0' }
      const tracer = { _tracer: { _config: { isServiceUserProvided: false } } }
      await cypressPlugin.init(tracer, config)
      config.retries = 2
      if (mode !== 'intact') delete config.retries
      if (mode === 'redefined') {
        Object.defineProperty(config, 'retries', { value: 2, configurable: true, writable: true, enumerable: true })
      }
      const afterObservation = new Error('stop after observing the run-start configuration')
      cypressPlugin.libraryConfigurationPromise = Promise.reject(afterObservation)
      await assert.rejects(cypressPlugin.beforeRun({ config: { retries: mode === 'deleted' ? 0 : 2 } }),
        error => error === afterObservation)
      if (mode === 'deleted') {
        assert.deepStrictEqual(cypressPlugin.originalCypressRetries, { runMode: 0, openMode: 0 })
        assert.strictEqual(Object.hasOwn(config, 'retries'), false)
      } else {
        assert.strictEqual(cypressPlugin.originalCypressRetries, 2)
        assert.strictEqual(config.retries, 2)
      }
      assert.strictEqual(cypressPlugin.retryConfigObserver.isWatching(config), false)
    })
  }

  it('preserves numeric native mode budgets after an observed inactive-mode write', async () => {
    const config = { retries: 2, version: '16.2.0' }
    const tracer = {
      _tracer: {
        _config: { isServiceUserProvided: false },
        _exporter: {
          getLibraryConfiguration: (config, callback) => callback(null, {
            isFlakyTestRetriesEnabled: true,
            flakyTestRetriesCount: 4,
          }),
        },
      },
    }
    await cypressPlugin.init(tracer, config)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(config.retries)), { openMode: 2, runMode: 4 })
    config.retries.openMode = 1
    assert.deepStrictEqual(cypressPlugin.originalCypressRetries, { runMode: 2, openMode: 1 })
  })

  it('preserves numeric native mode budgets when reconciling resolved retry objects', async () => {
    cypressPlugin._isInit = false
    cypressPlugin.retryConfigObserver = undefined
    cypressPlugin.cypressConfig = { version: '16.2.0', retries: { runMode: 4, openMode: 2 } }
    cypressPlugin.originalCypressRetries = 2
    cypressPlugin.nativeCypressRetriesBaseline = 2
    cypressPlugin.configuredCypressRetries = { runMode: 4, openMode: 2 }
    const afterReconcile = new Error('stop after resolving native modes')
    sinon.stub(cypressPlugin, 'init').rejects(afterReconcile)
    await assert.rejects(cypressPlugin.beforeRun({ config: { retries: { runMode: 4, openMode: 1 } } }),
      error => error === afterReconcile)
    assert.deepStrictEqual(cypressPlugin.originalCypressRetries, { runMode: 2, openMode: 1 })
  })

  for (const atrEnabled of [false, true]) {
    it(`preserves a readonly retry root on first initialization (ATR=${atrEnabled})`, async () => {
      const native = { runMode: 2, openMode: 0 }
      const config = { retries: native, version: '16.2.0' }
      Object.defineProperty(config, 'retries', { writable: false, configurable: false })
      const tracer = {
        _tracer: {
          _config: { isServiceUserProvided: false },
          _exporter: {
            getLibraryConfiguration: (config, callback) => callback(null, {
              isFlakyTestRetriesEnabled: atrEnabled,
              flakyTestRetriesCount: 4,
            }),
          },
        },
      }
      const result = await cypressPlugin.init(tracer, config)
      assert.notStrictEqual(result, config)
      assert.strictEqual(config.retries, native)
      assert.strictEqual(Object.getOwnPropertyDescriptor(config, 'retries').writable, false)
      assert.strictEqual(Object.getOwnPropertyDescriptor(config, 'retries').configurable, false)
      assert.deepStrictEqual(native, { runMode: 2, openMode: 0 })
      assert.deepStrictEqual(JSON.parse(JSON.stringify(result.retries)),
        { runMode: atrEnabled ? 4 : 2, openMode: 0 })
      assert.deepStrictEqual(cypressPlugin.originalCypressRetries, { runMode: 2, openMode: 0 })
    })
  }

  it('reinitializes a reused frozen configuration without changing its native root', async () => {
    const config = { retries: { runMode: 0, openMode: 0 }, version: '12.0.0' }
    const tracer = { _tracer: { _config: { isServiceUserProvided: false } } }
    await cypressPlugin.init(tracer, config)
    const saved = config.retries
    saved.runMode = 2
    Object.freeze(config)
    const result = await cypressPlugin.init(tracer, config)
    assert.notStrictEqual(result, config)
    assert.strictEqual(config.retries, saved)
    assert.strictEqual(Object.isFrozen(config), true)
    assert.strictEqual(Object.getOwnPropertyDescriptor(config, 'retries').writable, false)
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result.retries)), { runMode: 2, openMode: 0 })
    saved.runMode = 7
    assert.strictEqual(result.retries.runMode, 2)
    assert.deepStrictEqual(cypressPlugin.originalCypressRetries, { runMode: 2, openMode: 0 })
  })

  for (const [atrEnabled, settingsError] of [[false, false], [true, false], [false, true]]) {
    it(`preserves a config frozen while initialization settings resolve (ATR=${atrEnabled}, error=${settingsError})`,
      async () => {
        const config = { retries: { runMode: 2, openMode: 0 }, version: '16.2.0' }
        const settingsFailure = settingsError ? new Error('settings failed') : null
        const tracer = {
          _tracer: {
            _config: { isServiceUserProvided: false },
            _exporter: {
              getLibraryConfiguration: (config, callback) => callback(settingsFailure, {
                isFlakyTestRetriesEnabled: atrEnabled,
                flakyTestRetriesCount: 4,
              }),
            },
          },
        }
        const pending = cypressPlugin.init(tracer, config)
        const native = config.retries
        Object.freeze(config)
        const result = await pending
        assert.notStrictEqual(result, config)
        assert.strictEqual(Object.isFrozen(config), true)
        assert.strictEqual(config.retries, native)
        assert.strictEqual(Object.getOwnPropertyDescriptor(config, 'retries').writable, false)
        assert.deepStrictEqual(native, { runMode: 2, openMode: 0 })
        assert.deepStrictEqual(JSON.parse(JSON.stringify(result.retries)),
          { runMode: atrEnabled ? 4 : 2, openMode: 0 })
        assert.deepStrictEqual(cypressPlugin.originalCypressRetries, { runMode: 2, openMode: 0 })
        assert.strictEqual(cypressPlugin.retryConfigObserver.isWatching(result), true)
      })
  }

  for (const writeMode of ['seal', 'freeze', 'strict', 'sloppy', 'nested']) {
    for (const atrEnabled of [false, true]) {
      it(`preserves locked Node config writes (${writeMode}, ATR=${atrEnabled})`, async () => {
        const config = { retries: { runMode: 0, openMode: 0 }, version: '14.5.4' }
        const tracer = {
          _tracer: {
            _config: { isServiceUserProvided: false },
            _exporter: {
              getLibraryConfiguration: (config, callback) => callback(null, {
                isFlakyTestRetriesEnabled: atrEnabled, flakyTestRetriesCount: 4,
              }),
            },
          },
        }
        const result = await cypressPlugin.init(tracer, config)
        const saved = writeMode === 'nested' ? result.retries : undefined
        if (writeMode !== 'nested') result.retries = 2
        Object[writeMode === 'seal' ? 'seal' : 'freeze'](result)
        if (writeMode === 'strict') {
          assert.throws(() => { result.retries = 3 }, TypeError)
        } else if (writeMode === 'sloppy') {
          runInNewContext('config.retries = 3', { config: result })
          assert.strictEqual(result.retries, 2)
        } else if (writeMode === 'nested') saved.runMode = 2
        cypressPlugin.retryConfigObserver.stop()
        assert.deepStrictEqual(cypressPlugin.originalCypressRetries,
          writeMode === 'nested' ? { runMode: 2, openMode: 0 } : 2)
      })
    }
  }

  for (const lock of ['freeze', 'seal']) {
    for (const experimental of [false, true]) {
      it(`preserves native retry intent across descriptor-only ${lock} (experimental=${experimental})`, async () => {
        const native = experimental
          ? {
              runMode: true,
              openMode: false,
              experimentalStrategy: 'detect-flake-but-always-fail',
              experimentalOptions: { maxRetries: 2, stopIfAnyPassed: false },
            }
          : { runMode: 0, openMode: 0 }
        const config = { retries: native, version: '16.2.0' }
        const tracer = {
          _tracer: {
            _config: { isServiceUserProvided: false },
            _exporter: {
              getLibraryConfiguration: (config, callback) => callback(null, {
                isFlakyTestRetriesEnabled: true,
                flakyTestRetriesCount: 4,
              }),
            },
          },
        }
        await cypressPlugin.init(tracer, config)
        Object[lock](experimental ? config.retries.experimentalOptions : config.retries)
        assert.deepStrictEqual(cypressPlugin.originalCypressRetries, native)
        cypressPlugin.retryConfigObserver.stop()
        assert.deepStrictEqual(cypressPlugin.originalCypressRetries, native)
      })
    }
  }

  it('reconciles mutable nested retries returned through a frozen Node retry root', async () => {
    const native = {
      runMode: true,
      openMode: false,
      experimentalStrategy: 'detect-flake-but-always-fail',
      experimentalOptions: { maxRetries: 2, stopIfAnyPassed: false },
    }
    const control = JSON.parse(JSON.stringify(native))
    Object.freeze(control)
    control.experimentalOptions.maxRetries = 3
    const config = { retries: native, version: '16.2.0' }
    const tracer = {
      _tracer: {
        _config: { isServiceUserProvided: false },
        _exporter: {
          getLibraryConfiguration: (config, callback) => callback(null, {
            isFlakyTestRetriesEnabled: true,
            flakyTestRetriesCount: 4,
          }),
        },
      },
    }
    await cypressPlugin.init(tracer, config)
    Object.freeze(config.retries)
    config.retries.experimentalOptions.maxRetries = 3
    cypressPlugin.retryConfigObserver.stop()
    assert.deepStrictEqual(cypressPlugin.originalCypressRetries, control)
  })

  it('preserves config-load defaults for raw and proxied nested Node retry deletions', async () => {
    for (const raw of [false, true]) {
      const native = {
        runMode: true,
        openMode: false,
        experimentalStrategy: 'detect-flake-but-always-fail',
        experimentalOptions: { maxRetries: 2, stopIfAnyPassed: false },
      }
      const config = { retries: native, version: '16.2.0' }
      const tracer = {
        _tracer: {
          _config: { isServiceUserProvided: false },
          _exporter: {
            getLibraryConfiguration: (config, callback) => callback(null, {
              isFlakyTestRetriesEnabled: true,
              flakyTestRetriesCount: 4,
            }),
          },
        },
      }
      await cypressPlugin.init(tracer, config)
      config.retries.experimentalOptions.maxRetries = 3
      if (raw) Object.freeze(config.retries)
      delete config.retries.experimentalOptions.maxRetries
      cypressPlugin.retryConfigObserver.stop()
      assert.deepStrictEqual(cypressPlugin.originalCypressRetries, native)
    }
  })

  it('refreshes a detached Node root after a same-object write', async () => {
    const native = {
      runMode: true,
      openMode: false,
      experimentalStrategy: 'detect-flake-but-always-fail',
      experimentalOptions: { maxRetries: 2, stopIfAnyPassed: false },
    }
    const config = { retries: native, version: '16.2.0' }
    const tracer = {
      _tracer: {
        _config: { isServiceUserProvided: false },
        _exporter: {
          getLibraryConfiguration: (config, callback) => callback(null, {
            isFlakyTestRetriesEnabled: true,
            flakyTestRetriesCount: 4,
          }),
        },
      },
    }
    await cypressPlugin.init(tracer, config)
    const owned = config.retries
    const proxied = owned.experimentalOptions
    const raw = Object.getOwnPropertyDescriptor(owned, 'experimentalOptions').value
    config.retries = 0
    raw.maxRetries = 3
    owned.experimentalOptions = proxied
    raw.maxRetries = 4
    config.retries = owned
    cypressPlugin.retryConfigObserver.stop()
    assert.deepStrictEqual(cypressPlugin.originalCypressRetries,
      { ...native, experimentalOptions: { maxRetries: 4, stopIfAnyPassed: false } })
  })

  it('reconciles raw writes after proxy writes to a detached Node retry root', async () => {
    const native = {
      runMode: true,
      openMode: false,
      experimentalStrategy: 'detect-flake-but-always-fail',
      experimentalOptions: { maxRetries: 2, stopIfAnyPassed: false },
    }
    const config = { retries: native, version: '16.2.0' }
    const tracer = {
      _tracer: {
        _config: { isServiceUserProvided: false },
        _exporter: {
          getLibraryConfiguration: (config, callback) => callback(null, {
            isFlakyTestRetriesEnabled: true,
            flakyTestRetriesCount: 4,
          }),
        },
      },
    }
    await cypressPlugin.init(tracer, config)
    const owned = config.retries
    const proxied = owned.experimentalOptions
    const raw = Object.getOwnPropertyDescriptor(owned, 'experimentalOptions').value
    config.retries = 0
    proxied.maxRetries = 3
    raw.maxRetries = 4
    config.retries = owned
    cypressPlugin.retryConfigObserver.stop()
    assert.deepStrictEqual(cypressPlugin.originalCypressRetries,
      { ...native, experimentalOptions: { maxRetries: 4, stopIfAnyPassed: false } })
  })

  for (const [operation, locked] of [
    ['define', false], ['define', true], ['assign', false], ['fresh', false], ['primitive', false],
  ]) {
    it(`preserves nested Node retry ownership for ${operation} (locked=${locked})`, async () => {
      const native = {
        runMode: true,
        openMode: false,
        experimentalStrategy: 'detect-flake-but-always-fail',
        experimentalOptions: { maxRetries: 2, stopIfAnyPassed: false },
      }
      const config = { retries: native, version: '16.2.0' }
      const tracer = {
        _tracer: {
          _config: { isServiceUserProvided: false },
          _exporter: {
            getLibraryConfiguration: (config, callback) => callback(null, {
              isFlakyTestRetriesEnabled: true,
              flakyTestRetriesCount: 4,
            }),
          },
        },
      }
      await cypressPlugin.init(tracer, config)
      const saved = config.retries.experimentalOptions
      if (operation === 'define') {
        Object.defineProperty(config.retries, 'experimentalOptions', {
          value: saved, writable: !locked, configurable: !locked,
        })
      } else if (operation === 'assign') {
        config.retries.experimentalOptions = saved
      } else if (operation === 'fresh') {
        config.retries.experimentalOptions = { ...saved }
      } else {
        const injected = saved.maxRetries
        saved.maxRetries = injected
      }
      if (operation !== 'fresh') assert.strictEqual(config.retries.experimentalOptions, saved)
      cypressPlugin.retryConfigObserver.stop()
      assert.deepStrictEqual(cypressPlugin.originalCypressRetries,
        operation === 'fresh' || operation === 'primitive'
          ? { ...native, experimentalOptions: { maxRetries: 4, stopIfAnyPassed: false } }
          : native)
    })
  }

  for (const throws of [false, true]) {
    it(`does not evaluate a replacement getter when a detached retry alias changes (throws=${throws})`, () => {
      const observeRetryConfig = require('../../packages/datadog-plugin-cypress/src/retry-config-observer')
      const config = { retries: { runMode: 0, openMode: 0 } }
      const observer = observeRetryConfig(config, () => {})
      const saved = config.retries
      let reads = 0
      Object.defineProperty(config, 'retries', {
        enumerable: true,
        configurable: true,
        get () {
          reads++
          if (throws) throw new Error('native serialization getter')
          return { runMode: reads, openMode: 0 }
        },
      })
      try {
        saved.runMode = 2
        assert.strictEqual(reads, 0)
        if (throws) {
          assert.throws(() => JSON.stringify(config), /native serialization getter/)
        } else {
          assert.deepStrictEqual(JSON.parse(JSON.stringify(config)), { retries: { runMode: 1, openMode: 0 } })
        }
        assert.strictEqual(reads, 1)
      } finally {
        observer.stop(false)
      }
    })
  }

  it('keeps stopped retry proxies inert for same-object and descriptor-only writes', () => {
    const observeRetryConfig = require('../../packages/datadog-plugin-cypress/src/retry-config-observer')
    const config = { retries: { experimentalOptions: { maxRetries: 2 } } }
    const reconcileNative = sinon.spy(native => native)
    const observer = observeRetryConfig(config, () => {}, {
      nativeRetries: { experimentalOptions: { maxRetries: 2 } },
      updateNative: native => native,
      reconcileNative,
    })
    const owned = config.retries
    const options = owned.experimentalOptions
    observer.stop()
    const calls = reconcileNative.callCount
    owned.experimentalOptions = options
    Object.defineProperty(owned, 'experimentalOptions', { configurable: false })
    assert.strictEqual(reconcileNative.callCount, calls)
  })

  for (const locked of [false, true]) {
    it(`preserves a supplied nested proxy in a retry descriptor (locked=${locked})`, () => {
      const observeRetryConfig = require('../../packages/datadog-plugin-cypress/src/retry-config-observer')
      const config = { retries: { experimentalOptions: { maxRetries: 2 } } }
      const observer = observeRetryConfig(config, () => {})
      try {
        const saved = config.retries.experimentalOptions
        Object.defineProperty(config.retries, 'experimentalOptions', {
          value: saved, writable: !locked, configurable: !locked,
        })
        assert.strictEqual(config.retries.experimentalOptions, saved)
        assert.deepStrictEqual(JSON.parse(JSON.stringify(config.retries)), { experimentalOptions: { maxRetries: 2 } })
      } finally {
        observer.stop()
      }
    })
  }

  it('captures native retries written during initialization while retaining config-load defaults', async () => {
    const config = { retries: { runMode: 0, openMode: 0 }, version: '12.0.0' }
    const tracer = { _tracer: { _config: { isServiceUserProvided: false } } }
    const pending = cypressPlugin.init(tracer, config)
    config.retries.runMode = 2
    await pending
    assert.deepStrictEqual(cypressPlugin.originalCypressRetries, { runMode: 2, openMode: 0 })
    assert.deepStrictEqual(cypressPlugin.nativeCypressRetriesBaseline, { runMode: 0, openMode: 0 })
    config.retries = { openMode: 1 }
    cypressPlugin.retryConfigObserver.stop()
    assert.deepStrictEqual(cypressPlugin.originalCypressRetries, { runMode: 0, openMode: 1 })
  })

  for (const [name, initial, partial, expected] of [
    ['mode', { runMode: 2, openMode: 0 }, { openMode: 1 }, { runMode: 2, openMode: 1 }],
    ['experimental policy', {
      runMode: true,
      openMode: false,
      experimentalStrategy: 'detect-flake-but-always-fail',
      experimentalOptions: { maxRetries: 4, stopIfAnyPassed: false },
    }, { experimentalOptions: { stopIfAnyPassed: true } }, {
      runMode: true,
      openMode: false,
      experimentalStrategy: 'detect-flake-but-always-fail',
      experimentalOptions: { maxRetries: 4, stopIfAnyPassed: true },
    }],
  ]) {
    it(`retains native ${name} defaults for a partial retry object during initialization`, async () => {
      const config = { retries: initial, version: '16.2.0' }
      const tracer = { _tracer: { _config: { isServiceUserProvided: false } } }
      const pending = cypressPlugin.init(tracer, config)
      config.retries = partial
      await pending
      assert.deepStrictEqual(cypressPlugin.nativeCypressRetriesBaseline, initial)
      assert.deepStrictEqual(cypressPlugin.originalCypressRetries, expected)
      assert.deepStrictEqual(config.retries, expected)
    })
  }

  for (const selection of ['detached', 'selected', 'deleted-field']) {
    it(`captures ${selection} Node retry provenance at handoff`, async () => {
      const config = { retries: { runMode: 0, openMode: 0 }, version: '12.0.0' }
      const tracer = { _tracer: { _config: { isServiceUserProvided: false } } }
      await cypressPlugin.init(tracer, config)
      const saved = config.retries
      config.retries = 1
      saved.runMode = 2
      assert.strictEqual(config.retries, 1)
      if (selection !== 'detached') config.retries = saved
      if (selection === 'deleted-field') delete saved.runMode
      cypressPlugin.retryConfigObserver.stop()
      if (selection === 'detached') {
        assert.strictEqual(cypressPlugin.originalCypressRetries, 1)
      } else {
        assert.deepStrictEqual(cypressPlugin.originalCypressRetries, {
          runMode: selection === 'deleted-field' ? 0 : 2, openMode: 0,
        })
      }
    })
  }

  it('restores native defaults on deleted or undefined Node retry fields', async () => {
    const config = { retries: { runMode: 2, openMode: 0 }, version: '12.0.0' }
    const tracer = { _tracer: { _config: { isServiceUserProvided: false } } }
    await cypressPlugin.init(tracer, config)
    config.retries.runMode = 8
    config.retries.openMode = 1
    delete config.retries.runMode
    assert.deepStrictEqual(cypressPlugin.originalCypressRetries, { runMode: 2, openMode: 1 })
    config.retries.runMode = 9
    config.retries.runMode = undefined
    assert.deepStrictEqual(cypressPlugin.originalCypressRetries, { runMode: 2, openMode: 1 })
    config.retries = { openMode: 3 }
    cypressPlugin.retryConfigObserver.stop()
    assert.deepStrictEqual(cypressPlugin.originalCypressRetries, { runMode: 2, openMode: 3 })
  })

  it('restores user retries before requesting configuration for a subsequent run', async () => {
    const cypressConfig = { retries: { openMode: 1, runMode: 2 }, version: '12.0.0' }
    cypressPlugin.cypressConfig = cypressConfig
    cypressPlugin.hasOriginalCypressRetries = true
    cypressPlugin.originalCypressRetries = { openMode: 1, runMode: 2 }
    cypressConfig.retries.runMode = 5

    const tracer = {
      _tracer: {
        _config: { isServiceUserProvided: false },
      },
    }

    const result = await cypressPlugin.init(tracer, cypressConfig)

    assert.strictEqual(result.retries.openMode, 1)
    assert.strictEqual(result.retries.runMode, 2)
  })
})

describe('cypress config instrumentation', () => {
  const temporaryDirectories = []
  let errors

  beforeEach(() => {
    errors = []
    sinon.stub(console, 'error').callsFake((...args) => errors.push(format(...args)))
  })

  afterEach(() => {
    sinon.restore()
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { force: true, recursive: true })
    }
  })

  /**
   * @param {string} code filesystem error code
   * @param {string} filePath affected path
   * @param {string} [syscall] failed system call
   * @returns {Error & { code: string, path: string, syscall: string }} filesystem error
   */
  function createFileError (code, filePath, syscall = 'open') {
    return Object.assign(new Error(`${code}: ${syscall} ${filePath}`), {
      code,
      path: filePath,
      syscall,
    })
  }

  function createProjectRoot () {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-cypress-config-'))
    temporaryDirectories.push(projectRoot)
    return projectRoot
  }

  /**
   * @param {object} [fsStub] filesystem overrides
   * @param {() => string} [randomUUID] UUID generator
   * @param {object} [setupNodeEventsChannel] setup-node-events diagnostic channel
   * @returns {{
   *   cypressConfig: object,
   *   errors: string[],
   *   manualPluginOwner: object,
   *   warnings: string[]
   * }} loaded instrumentation and logs
   */
  function loadCypressConfig (fsStub, randomUUID, setupNodeEventsChannel) {
    const warnings = []
    let uuid = 0
    const log = {
      error: (...args) => errors.push(format(...args)),
      warn: (...args) => warnings.push(format(...args)),
    }
    const finalization = proxyquire('../../packages/datadog-plugin-cypress/src/finalization', {
      '../../dd-trace/src/log': log,
    })
    const stubs = {
      crypto: {
        randomUUID: randomUUID || (() => `uuid-${++uuid}`),
      },
      '../../datadog-plugin-cypress/src/finalization': finalization,
      '../../dd-trace/src/log': log,
      './helpers/instrument': {
        channel: () => setupNodeEventsChannel || { hasSubscribers: false, publish: () => {} },
      },
    }

    if (fsStub) stubs.fs = fsStub

    return {
      cypressConfig: proxyquire('../../packages/datadog-instrumentations/src/cypress-config', stubs),
      errors,
      manualPluginOwner: finalization.manualPluginOwner,
      warnings,
    }
  }

  /**
   * @param {object} cypressConfig Cypress config instrumentation
   * @param {object} resolvedConfig resolved Cypress config
   * @returns {{ handlers: Record<string, Function>, result: object }} registered handlers and returned config
   */
  function injectSupportFile (cypressConfig, resolvedConfig) {
    const configFile = { e2e: {} }
    const handlers = {}
    cypressConfig.wrapConfig(configFile)

    const result = configFile.e2e.setupNodeEvents((event, handler) => {
      handlers[event] = handler
    }, resolvedConfig)

    return { handlers, result }
  }

  /**
   * @param {string} directory directory to inspect
   * @returns {string[]} generated Cypress files
   */
  function getGeneratedFiles (directory) {
    return fs.readdirSync(directory)
      .filter(file => file.startsWith('dd-cypress-support-') || file.startsWith('.dd-cypress-config-'))
  }

  /**
   * @param {string} code error code raised after a partial write
   * @param {(writeNumber: number) => boolean} [shouldFail] selects the write that fails
   * @returns {object} filesystem stub
   */
  function createPartialWriteFailure (code, shouldFail = () => true) {
    const pathsByDescriptor = new Map()
    let writeNumber = 0

    return {
      openSync (filePath, flags) {
        const descriptor = fs.openSync(filePath, flags)
        pathsByDescriptor.set(descriptor, filePath)
        return descriptor
      },
      writeFileSync (file, content, ...args) {
        if (typeof file === 'number' && pathsByDescriptor.has(file)) {
          writeNumber++
          if (!shouldFail(writeNumber)) return fs.writeFileSync(file, content, ...args)

          const filePath = pathsByDescriptor.get(file)
          fs.writeFileSync(file, 'partial')
          throw createFileError(code, filePath, 'write')
        }
        return fs.writeFileSync(file, content, ...args)
      },
      closeSync (descriptor) {
        pathsByDescriptor.delete(descriptor)
        return fs.closeSync(descriptor)
      },
    }
  }

  describe('support wrapper', () => {
    it('does not enable interactive run events when Test Optimization does not register', () => {
      const projectRoot = createProjectRoot()
      const { cypressConfig, warnings } = loadCypressConfig()
      const resolvedConfig = {
        projectRoot,
        supportFile: false,
        isInteractive: true,
        experimentalInteractiveRunEvents: false,
      }

      injectSupportFile(cypressConfig, resolvedConfig)

      assert.strictEqual(resolvedConfig.experimentalInteractiveRunEvents, false)
      assert.deepStrictEqual(warnings, [])
    })

    it('enables interactive run events after Test Optimization registers', () => {
      const projectRoot = createProjectRoot()
      const setupNodeEventsChannel = {
        hasSubscribers: true,
        publish (payload) {
          payload.registered = true
        },
      }
      const { cypressConfig, warnings } = loadCypressConfig(undefined, undefined, setupNodeEventsChannel)
      const resolvedConfig = {
        projectRoot,
        supportFile: false,
        isInteractive: true,
        experimentalInteractiveRunEvents: false,
      }

      injectSupportFile(cypressConfig, resolvedConfig)

      assert.strictEqual(resolvedConfig.experimentalInteractiveRunEvents, true)
      assert.deepStrictEqual(warnings, [
        'Datadog enabled Cypress experimentalInteractiveRunEvents so Test Optimization can finish the test session.',
      ])
    })

    it('falls back to the project root when the support directory is not writable', async () => {
      const projectRoot = createProjectRoot()
      const supportDirectory = path.join(projectRoot, 'cypress', 'support')
      const supportFile = path.join(supportDirectory, 'e2e.js')
      fs.mkdirSync(supportDirectory, { recursive: true })
      fs.writeFileSync(supportFile, '// user support\n')

      const { cypressConfig, warnings } = loadCypressConfig({
        openSync (filePath, flags) {
          if (path.dirname(filePath) === supportDirectory) {
            throw createFileError('EACCES', filePath)
          }
          return fs.openSync(filePath, flags)
        },
      })
      const resolvedConfig = { projectRoot, supportFile }
      const { handlers } = injectSupportFile(cypressConfig, resolvedConfig)

      assert.strictEqual(path.dirname(resolvedConfig.supportFile), projectRoot)
      assert.deepStrictEqual(warnings, [])
      assert.strictEqual(getGeneratedFiles(projectRoot).length, 2)

      await handlers['after:run']({})
      assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
    })

    it('removes generated support files when the config process exits without after:run', () => {
      const projectRoot = createProjectRoot()
      const generatedCountFile = path.join(projectRoot, 'generated-count')
      const cypressConfigPath = require.resolve('../../packages/datadog-instrumentations/src/cypress-config')
      const script = [
        'const fs = require("node:fs")',
        `const cypressConfig = require(${JSON.stringify(cypressConfigPath)})`,
        `const projectRoot = ${JSON.stringify(projectRoot)}`,
        'const config = { e2e: {} }',
        'cypressConfig.wrapConfig(config)',
        'config.e2e.setupNodeEvents(() => {}, { projectRoot, supportFile: false })',
        'const generatedCount = fs.readdirSync(projectRoot)',
        '  .filter(file => file.startsWith("dd-cypress-support-")).length',
        `fs.writeFileSync(${JSON.stringify(generatedCountFile)}, String(generatedCount))`,
        'process.exit(0)',
      ].join('\n')

      execFileSync(process.execPath, ['-e', script], {
        env: { ...process.env, NODE_OPTIONS: '' },
      })

      assert.strictEqual(fs.readFileSync(generatedCountFile, 'utf8'), '2')
      assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
    })

    it('logs an error with every failed location when no directory is writable', () => {
      const projectRoot = createProjectRoot()
      const supportDirectory = path.join(projectRoot, 'cypress', 'support')
      const supportFile = path.join(supportDirectory, 'e2e.js')
      fs.mkdirSync(supportDirectory, { recursive: true })
      fs.writeFileSync(supportFile, '// user support\n')

      const { cypressConfig, errors, warnings } = loadCypressConfig({
        openSync (filePath) {
          throw createFileError('EROFS', filePath)
        },
      })
      const resolvedConfig = { projectRoot, supportFile }
      injectSupportFile(cypressConfig, resolvedConfig)

      assert.strictEqual(resolvedConfig.supportFile, supportFile)
      assert.strictEqual(errors.length, 1)
      assert.deepStrictEqual(warnings, [])
      assert.match(errors[0], /^ERROR: Datadog could not create the Cypress support wrapper/)
      assert.strictEqual(errors[0].match(/EROFS during open/g).length, 2)
      assert.match(errors[0], new RegExp(supportDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.match(errors[0], new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    })

    it('logs an error when the original support file cannot be read', () => {
      const projectRoot = createProjectRoot()
      const supportFile = path.join(projectRoot, 'e2e.js')
      fs.writeFileSync(supportFile, '// user support\n')

      const { cypressConfig, errors } = loadCypressConfig({
        readFileSync (filePath, ...args) {
          if (filePath === supportFile) throw createFileError('EACCES', filePath, 'read')
          return fs.readFileSync(filePath, ...args)
        },
      })
      const resolvedConfig = { projectRoot, supportFile }
      injectSupportFile(cypressConfig, resolvedConfig)

      assert.strictEqual(resolvedConfig.supportFile, supportFile)
      assert.strictEqual(errors.length, 1)
      assert.match(errors[0], /^ERROR: Datadog could not read the Cypress support file/)
      assert.match(errors[0], /EACCES during read/)
    })

    it('logs an error when the Datadog browser hooks cannot be read', () => {
      const projectRoot = createProjectRoot()
      const browserHooksPath = require.resolve('../../packages/datadog-plugin-cypress/src/support')

      const { cypressConfig, errors } = loadCypressConfig({
        readFileSync (filePath, ...args) {
          if (filePath === browserHooksPath) throw createFileError('EACCES', filePath, 'read')
          return fs.readFileSync(filePath, ...args)
        },
      })
      const resolvedConfig = { projectRoot, supportFile: false }
      injectSupportFile(cypressConfig, resolvedConfig)

      assert.strictEqual(resolvedConfig.supportFile, false)
      assert.strictEqual(errors.length, 1)
      assert.match(errors[0], /^ERROR: Datadog could not read its Cypress browser support hooks/)
      assert.match(errors[0], /EACCES during read/)
    })

    it('logs an error when no project directory is available for the support wrapper', () => {
      const { cypressConfig, errors } = loadCypressConfig()
      const resolvedConfig = { supportFile: false }
      injectSupportFile(cypressConfig, resolvedConfig)

      assert.strictEqual(resolvedConfig.supportFile, false)
      assert.strictEqual(errors.length, 1)
      assert.match(errors[0], /^ERROR: Datadog could not create the Cypress support wrapper/)
      assert.match(errors[0], /no project directory was available/)
    })

    it('removes partial support files when the filesystem runs out of space', () => {
      const projectRoot = createProjectRoot()
      const supportDirectory = path.join(projectRoot, 'cypress', 'support')
      const supportFile = path.join(supportDirectory, 'e2e.js')
      fs.mkdirSync(supportDirectory, { recursive: true })
      fs.writeFileSync(supportFile, '// user support\n')

      const { cypressConfig, errors } = loadCypressConfig(createPartialWriteFailure('ENOSPC'))
      injectSupportFile(cypressConfig, { projectRoot, supportFile })

      assert.strictEqual(errors.length, 1)
      assert.match(errors[0], /ENOSPC during write/)
      assert.deepStrictEqual(getGeneratedFiles(supportDirectory), [])
      assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
    })

    it('removes the browser hooks when writing the support wrapper fails', () => {
      const projectRoot = createProjectRoot()
      const supportDirectory = path.join(projectRoot, 'cypress', 'support')
      const supportFile = path.join(supportDirectory, 'e2e.js')
      fs.mkdirSync(supportDirectory, { recursive: true })
      fs.writeFileSync(supportFile, '// user support\n')

      const failWrapperWrites = writeNumber => writeNumber % 2 === 0
      const { cypressConfig, errors } = loadCypressConfig(
        createPartialWriteFailure('ENOSPC', failWrapperWrites)
      )
      injectSupportFile(cypressConfig, { projectRoot, supportFile })

      assert.strictEqual(errors.length, 1)
      assert.strictEqual(errors[0].match(/ENOSPC during write/g).length, 2)
      assert.deepStrictEqual(getGeneratedFiles(supportDirectory), [])
      assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
    })

    it('removes partial support files when closing them fails', () => {
      const projectRoot = createProjectRoot()
      const supportDirectory = path.join(projectRoot, 'cypress', 'support')
      const supportFile = path.join(supportDirectory, 'e2e.js')
      const pathsByDescriptor = new Map()
      fs.mkdirSync(supportDirectory, { recursive: true })
      fs.writeFileSync(supportFile, '// user support\n')

      const { cypressConfig, errors } = loadCypressConfig({
        openSync (filePath, flags) {
          const descriptor = fs.openSync(filePath, flags)
          pathsByDescriptor.set(descriptor, filePath)
          return descriptor
        },
        closeSync (descriptor) {
          const filePath = pathsByDescriptor.get(descriptor)
          pathsByDescriptor.delete(descriptor)
          fs.closeSync(descriptor)
          throw createFileError('EIO', filePath, 'close')
        },
      })
      injectSupportFile(cypressConfig, { projectRoot, supportFile })

      assert.strictEqual(errors.length, 1)
      assert.strictEqual(errors[0].match(/EIO during close/g).length, 2)
      assert.deepStrictEqual(getGeneratedFiles(supportDirectory), [])
      assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
    })

    it('warns when generated support files cannot be removed', async () => {
      const projectRoot = createProjectRoot()

      const { cypressConfig, errors, warnings } = loadCypressConfig({
        unlinkSync (filePath) {
          throw createFileError('EACCES', filePath, 'unlink')
        },
      })
      const { handlers } = injectSupportFile(cypressConfig, { projectRoot, supportFile: false })

      await handlers['after:run']({})

      assert.deepStrictEqual(errors, [])
      assert.strictEqual(warnings.length, 2)
      assert.ok(warnings.every(warning => warning.includes('could not remove generated Cypress file')))
      assert.ok(warnings.every(warning => warning.includes('EACCES during unlink')))
      assert.strictEqual(getGeneratedFiles(projectRoot).length, 2)
    })
  })

  describe('manual plugin', () => {
    it('keeps interactive run events enabled when setupNodeEvents returns a partial config', async () => {
      const projectRoot = createProjectRoot()
      const datadogAfterSpecHandler = sinon.stub()
      datadogAfterSpecHandler[Symbol.for('dd-trace.cypress.after-spec.handler')] = true
      const datadogAfterRunHandler = sinon.stub()
      datadogAfterRunHandler[Symbol.for('dd-trace.cypress.after-run.handler')] = true
      const setupNodeEventsChannel = {
        hasSubscribers: true,
        publish: sinon.stub(),
      }
      const { cypressConfig, manualPluginOwner, warnings } = loadCypressConfig(
        undefined,
        undefined,
        setupNodeEventsChannel
      )
      const taskHandler = {
        'dd:testSuiteStart': sinon.stub(),
        'dd:beforeEach': sinon.stub(),
        'dd:afterEach': sinon.stub(),
        'dd:addTags': sinon.stub(),
        [Symbol.for('dd-trace.cypress.task.handler')]: manualPluginOwner,
      }
      const config = {
        e2e: {
          setupNodeEvents (on) {
            on('after:spec', datadogAfterSpecHandler)
            on('after:run', datadogAfterRunHandler)
            on('task', taskHandler)
            return { env: { returned: true } }
          },
        },
      }
      const handlers = {}
      const initialConfig = {
        projectRoot,
        supportFile: false,
        isInteractive: true,
        experimentalInteractiveRunEvents: false,
      }
      setupNodeEventsChannel.publish.resetHistory()

      cypressConfig.wrapConfig(config)
      const returnedConfig = config.e2e.setupNodeEvents((event, handler) => {
        handlers[event] = handler
      }, initialConfig)

      assert.notStrictEqual(returnedConfig, initialConfig)
      assert.deepStrictEqual(returnedConfig.env, { returned: true })
      assert.strictEqual(returnedConfig.experimentalInteractiveRunEvents, true)
      assert.strictEqual(initialConfig.experimentalInteractiveRunEvents, true)
      assert.deepStrictEqual(warnings, [
        'Datadog enabled Cypress experimentalInteractiveRunEvents so Test Optimization can finish the test session.',
      ])
      sinon.assert.notCalled(setupNodeEventsChannel.publish)
      await handlers['after:run']({})
    })

    it('removes a pre-screenshot manual before:run handler when current instrumentation takes ownership', () => {
      const projectRoot = createProjectRoot()
      const legacyBeforeRunHandler = sinon.stub()
      const currentBeforeRunHandler = sinon.stub()
      const registrations = []
      const setupNodeEventsChannel = {
        hasSubscribers: true,
        publish: sinon.stub().callsFake((payload) => {
          if (!payload.on) return
          payload.on('before:run', currentBeforeRunHandler)
          payload.registered = true
          payload.cleanupWrapper()
        }),
      }
      const taskHandler = {
        'dd:testSuiteStart': sinon.stub(),
        'dd:beforeEach': sinon.stub(),
        'dd:afterEach': sinon.stub(),
        'dd:addTags': sinon.stub(),
      }
      const config = {
        e2e: {
          /**
           * @param {Function} on Cypress event registration function
           */
          setupNodeEvents (on) {
            on('before:run', legacyBeforeRunHandler)
            on('after:spec', sinon.stub())
            on('after:run', sinon.stub())
            on('task', taskHandler)
          },
        },
      }
      const { cypressConfig } = loadCypressConfig(undefined, undefined, setupNodeEventsChannel)

      cypressConfig.wrapConfig(config)
      config.e2e.setupNodeEvents((event, handler) => {
        registrations.push([event, handler])
      }, { projectRoot, supportFile: false, isInteractive: false })

      assert.deepStrictEqual(
        registrations.filter(([event]) => event === 'before:run'),
        [['before:run', currentBeforeRunHandler]]
      )
    })

    it('retains current manual handlers and tasks when an adapter strips lifecycle markers', async () => {
      const projectRoot = createProjectRoot()
      const userError = new Error('user after:spec failed')
      const userHandler = sinon.stub().rejects(userError)
      const datadogAfterSpecHandler = sinon.stub()
      const datadogAfterRunHandler = sinon.stub()
      const setupNodeEventsChannel = {
        hasSubscribers: true,
        publish: sinon.stub(),
      }
      const { cypressConfig, manualPluginOwner } = loadCypressConfig(
        undefined,
        undefined,
        setupNodeEventsChannel
      )
      const taskHandler = {
        'dd:testSuiteStart': sinon.stub(),
        'dd:beforeEach': sinon.stub(),
        'dd:afterEach': sinon.stub(),
        'dd:addTags': sinon.stub(),
        [Symbol.for('dd-trace.cypress.task.handler')]: manualPluginOwner,
      }
      const config = {
        e2e: {
          /**
           * @param {Function} on Cypress event registration function
           */
          setupNodeEvents (on) {
            on('before:run', sinon.stub())
            on('after:screenshot', sinon.stub())
            on('after:spec', (...args) => datadogAfterSpecHandler(...args))
            on('after:run', (...args) => datadogAfterRunHandler(...args))
            on('task', taskHandler)
            on('after:spec', userHandler)
          },
        },
      }
      const handlers = {}
      const spec = { relative: 'cypress/e2e/basic-pass.js' }
      const results = { stats: { passes: 1 } }
      setupNodeEventsChannel.publish.resetHistory()

      cypressConfig.wrapConfig(config)
      config.e2e.setupNodeEvents((event, handler) => {
        handlers[event] = handler
      }, { projectRoot, supportFile: false, isInteractive: false })

      await assert.rejects(handlers['after:spec'](spec, results), error => error === userError)
      sinon.assert.calledOnceWithExactly(datadogAfterSpecHandler, spec, results, userError)
      assert.strictEqual(handlers.task, taskHandler)
      sinon.assert.notCalled(setupNodeEventsChannel.publish)
      await handlers['after:run']({ totalPassed: 1 })
    })

    it('preserves user handlers when a no-op manual plugin only registers tasks', async () => {
      const projectRoot = createProjectRoot()
      const userBeforeRunHandler = sinon.stub()
      const userAfterSpecHandler = sinon.stub()
      const userAfterRunHandler = sinon.stub()
      const userAfterScreenshotHandler = sinon.stub().returns({ path: 'renamed.png' })
      const noopTaskHandler = {
        'dd:testSuiteStart': sinon.stub(),
        'dd:beforeEach': sinon.stub(),
        'dd:afterEach': sinon.stub(),
        'dd:addTags': sinon.stub(),
        [Symbol.for('dd-trace.cypress.noop-task.handler')]: true,
      }
      const setupNodeEventsChannel = {
        hasSubscribers: true,
        publish: sinon.stub(),
      }
      const config = {
        e2e: {
          /**
           * @param {Function} on Cypress event registration function
           */
          setupNodeEvents (on) {
            on('after:screenshot', userAfterScreenshotHandler)
            on('before:run', userBeforeRunHandler)
            on('after:spec', userAfterSpecHandler)
            on('after:run', userAfterRunHandler)
            on('task', noopTaskHandler)
          },
        },
      }
      const handlers = {}
      const { cypressConfig, warnings } = loadCypressConfig(undefined, undefined, setupNodeEventsChannel)
      const spec = { relative: 'cypress/e2e/basic-pass.js' }
      const results = { stats: { passes: 1 } }
      const screenshot = { path: 'original.png' }
      const resolvedConfig = {
        projectRoot,
        supportFile: false,
        isInteractive: true,
        experimentalInteractiveRunEvents: false,
      }
      setupNodeEventsChannel.publish.resetHistory()

      cypressConfig.wrapConfig(config)
      config.e2e.setupNodeEvents((event, handler) => {
        handlers[event] = handler
      }, resolvedConfig)

      await handlers['before:run']({})
      await handlers['after:spec'](spec, results)
      assert.deepStrictEqual(await handlers['after:screenshot'](screenshot), { path: 'renamed.png' })
      await handlers['after:run']({ totalPassed: 1 })

      sinon.assert.calledOnce(userBeforeRunHandler)
      sinon.assert.calledOnceWithExactly(userAfterSpecHandler, spec, results)
      sinon.assert.calledOnceWithExactly(userAfterScreenshotHandler, screenshot)
      sinon.assert.calledOnce(userAfterRunHandler)
      sinon.assert.notCalled(setupNodeEventsChannel.publish)
      assert.strictEqual(resolvedConfig.experimentalInteractiveRunEvents, false)
      assert.deepStrictEqual(warnings, [])
    })

    for (const event of ['after:run', 'after:spec']) {
      for (const position of ['before', 'after']) {
        it(`supports an older manual ${event} handler registered ${position} the user handler`, async () => {
          const projectRoot = createProjectRoot()
          const userError = new Error(`user ${event} failed`)
          const userHandler = sinon.stub().rejects(userError)
          const datadogAfterSpecHandler = sinon.stub()
          const datadogAfterRunHandler = sinon.stub()
          const taskHandler = {
            'dd:testSuiteStart': sinon.stub(),
            'dd:beforeEach': sinon.stub(),
            'dd:afterEach': sinon.stub(),
            'dd:addTags': sinon.stub(),
          }
          const config = {
            e2e: {
              /**
               * @param {Function} on Cypress event registration function
               */
              setupNodeEvents (on) {
                if (position === 'before') on(event, userHandler)
                on('before:run', sinon.stub())
                on('after:screenshot', sinon.stub())
                on('after:spec', datadogAfterSpecHandler)
                on('after:run', datadogAfterRunHandler)
                on('task', taskHandler)
                if (position === 'after') on(event, userHandler)
              },
            },
          }
          const handlers = {}
          const { cypressConfig } = loadCypressConfig()
          const eventArguments = event === 'after:run'
            ? [{ totalPassed: 1 }]
            : [{ relative: 'cypress/e2e/basic-pass.js' }, { stats: { passes: 1 } }]

          cypressConfig.wrapConfig(config)
          config.e2e.setupNodeEvents((registeredEvent, handler) => {
            handlers[registeredEvent] = handler
          }, { projectRoot, supportFile: false, isInteractive: false })

          assert.strictEqual(getGeneratedFiles(projectRoot).length, 2)
          await assert.rejects(handlers[event](...eventArguments), error => error === userError)
          sinon.assert.callOrder(userHandler, event === 'after:run'
            ? datadogAfterRunHandler
            : datadogAfterSpecHandler)
          const finalizer = event === 'after:run' ? datadogAfterRunHandler : datadogAfterSpecHandler
          const finalizerError = finalizer.lastCall.args.at(-1)
          assert.ok(finalizerError instanceof Error)
          assert.strictEqual(finalizerError.message, userError.message)
          assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
        })
      }
    }

    it('cleans generated support files when an older manual after:spec finalizer rejects', async () => {
      const projectRoot = createProjectRoot()
      const finalizationError = new Error('older manual after:spec failed')
      const datadogAfterSpecHandler = sinon.stub().rejects(finalizationError)
      const taskHandler = {
        'dd:testSuiteStart': sinon.stub(),
        'dd:beforeEach': sinon.stub(),
        'dd:afterEach': sinon.stub(),
        'dd:addTags': sinon.stub(),
      }
      const config = {
        e2e: {
          /**
           * @param {Function} on Cypress event registration function
           */
          setupNodeEvents (on) {
            on('before:run', sinon.stub())
            on('after:screenshot', sinon.stub())
            on('after:spec', datadogAfterSpecHandler)
            on('after:run', sinon.stub())
            on('task', taskHandler)
          },
        },
      }
      const handlers = {}
      const { cypressConfig } = loadCypressConfig()

      cypressConfig.wrapConfig(config)
      config.e2e.setupNodeEvents((event, handler) => {
        handlers[event] = handler
      }, { projectRoot, supportFile: false, isInteractive: false })

      assert.strictEqual(getGeneratedFiles(projectRoot).length, 2)
      await assert.rejects(handlers['after:spec']({}, {}), finalizationError)
      assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
    })

    for (const event of ['after:run', 'after:spec']) {
      it(`defers a wrapped legacy ${event} helper to the manual plugin finalizer`, async () => {
        const projectRoot = createProjectRoot()
        const legacyFinalizer = sinon.stub()
        const legacyHelper = proxyquire(`../../packages/datadog-plugin-cypress/src/${event.replace(':', '-')}`, {
          './cypress-plugin': {
            [event === 'after:run' ? 'afterRun' : 'afterSpec']: legacyFinalizer,
          },
        })
        const datadogHandler = sinon.stub()
        datadogHandler[Symbol.for(`dd-trace.cypress.${event.replace(':', '-')}.handler`)] = true
        const rejection = `${event} string rejection`
        const userHandler = sinon.stub().callsFake(() => Promise.reject(rejection))
        const taskHandler = {
          'dd:testSuiteStart': sinon.stub(),
          'dd:beforeEach': sinon.stub(),
          'dd:afterEach': sinon.stub(),
          'dd:addTags': sinon.stub(),
        }
        const config = {
          e2e: {
            /**
             * @param {Function} on Cypress event registration function
             */
            setupNodeEvents (on) {
              on(event, (...args) => legacyHelper(...args))
              on(event, datadogHandler)
              on(event, userHandler)
              on('task', taskHandler)
            },
          },
        }
        const handlers = {}
        const { cypressConfig } = loadCypressConfig()
        const eventArguments = event === 'after:run'
          ? [{ totalPassed: 1 }]
          : [{ relative: 'cypress/e2e/basic-pass.js' }, { stats: { passes: 1 } }]

        cypressConfig.wrapConfig(config)
        config.e2e.setupNodeEvents((registeredEvent, handler) => {
          handlers[registeredEvent] = handler
        }, { projectRoot, supportFile: false, isInteractive: false })

        await assert.rejects(handlers[event](...eventArguments), error => error === rejection)
        sinon.assert.notCalled(legacyFinalizer)
        sinon.assert.calledOnce(userHandler)
        sinon.assert.calledOnce(datadogHandler)
        const finalizerError = datadogHandler.lastCall.args.at(-1)
        assert.ok(finalizerError instanceof Error)
        assert.strictEqual(finalizerError.message, rejection)

        if (event === 'after:spec') await handlers['after:run']({})
      })
    }

    for (const { position, finalization } of [
      { position: 'before', finalization: 'rejects' },
      { position: 'before', finalization: 'throws' },
      { position: 'after' },
    ]) {
      const finalizationDescription = finalization ? ` when finalization ${finalization}` : ''
      const testName =
        `finalizes with the original error from a handler registered ${position} Datadog${finalizationDescription}`
      it(testName, async () => {
        const projectRoot = createProjectRoot()
        const userError = new Error(`user handler ${position} Datadog failed`)
        const userHandler = sinon.stub().rejects(userError)
        const finalizationError = new Error('Datadog finalization failed')
        const datadogHandler = finalization
          ? sinon.stub()[finalization](finalizationError)
          : sinon.stub()
        datadogHandler[Symbol.for('dd-trace.cypress.after-run.handler')] = true
        const taskHandler = {
          'dd:testSuiteStart': sinon.stub(),
          'dd:beforeEach': sinon.stub(),
          'dd:afterEach': sinon.stub(),
          'dd:addTags': sinon.stub(),
        }
        const config = {
          e2e: {
            /**
             * @param {Function} on Cypress event registration function
             */
            setupNodeEvents (on) {
              if (position === 'before') on('after:run', userHandler)
              on('after:run', datadogHandler)
              if (position === 'after') on('after:run', userHandler)
              on('task', taskHandler)
            },
          },
        }
        const handlers = {}
        const { cypressConfig, errors } = loadCypressConfig()
        const results = { totalPassed: 1 }

        cypressConfig.wrapConfig(config)
        config.e2e.setupNodeEvents((event, handler) => {
          handlers[event] = handler
        }, { projectRoot, supportFile: false, isInteractive: false })

        await assert.rejects(handlers['after:run'](results), error => {
          assert.strictEqual(error, userError)
          return true
        })
        sinon.assert.calledOnceWithExactly(userHandler, results)
        sinon.assert.calledOnceWithExactly(datadogHandler, results, userError)
        if (finalization) {
          assert.strictEqual(errors.length, 1)
          assert.match(errors[0], /Datadog finalization failed/)
        } else {
          assert.deepStrictEqual(errors, [])
        }
      })
    }

    for (const position of ['before', 'after']) {
      it(`runs manual Datadog after:spec finalization after a user handler registered ${position}`, async () => {
        const projectRoot = createProjectRoot()
        const userError = new Error(`user handler ${position} Datadog failed`)
        const userHandler = sinon.stub().rejects(userError)
        const datadogHandler = sinon.stub()
        datadogHandler[Symbol.for('dd-trace.cypress.after-spec.handler')] = true
        const taskHandler = {
          'dd:testSuiteStart': sinon.stub(),
          'dd:beforeEach': sinon.stub(),
          'dd:afterEach': sinon.stub(),
          'dd:addTags': sinon.stub(),
        }
        const config = {
          e2e: {
            /**
             * @param {Function} on Cypress event registration function
             */
            setupNodeEvents (on) {
              if (position === 'before') on('after:spec', userHandler)
              on('after:spec', datadogHandler)
              if (position === 'after') on('after:spec', userHandler)
              on('task', taskHandler)
            },
          },
        }
        const handlers = {}
        const { cypressConfig } = loadCypressConfig()
        const spec = { relative: 'cypress/e2e/basic-pass.js' }
        const results = { stats: { passes: 1 } }

        cypressConfig.wrapConfig(config)
        config.e2e.setupNodeEvents((event, handler) => {
          handlers[event] = handler
        }, { projectRoot, supportFile: false, isInteractive: false })

        try {
          await assert.rejects(handlers['after:spec'](spec, results), error => {
            assert.strictEqual(error, userError)
            return true
          })
          sinon.assert.callOrder(userHandler, datadogHandler)
          sinon.assert.calledOnceWithExactly(userHandler, spec, results)
          sinon.assert.calledOnceWithExactly(datadogHandler, spec, results, userError)
        } finally {
          await handlers['after:run']({})
        }
      })
    }

    it('runs the latest after:screenshot handler after user handlers', async () => {
      const projectRoot = createProjectRoot()
      const userHandler = sinon.stub().returns({ path: 'updated.png' })
      const datadogHandler = sinon.stub()
      const datadogAfterRunHandler = sinon.stub()
      datadogAfterRunHandler[Symbol.for('dd-trace.cypress.after-run.handler')] = true
      const taskHandler = {
        'dd:testSuiteStart': sinon.stub(),
        'dd:beforeEach': sinon.stub(),
        'dd:afterEach': sinon.stub(),
        'dd:addTags': sinon.stub(),
      }
      const config = {
        e2e: {
          /**
           * @param {Function} on Cypress event registration function
           */
          setupNodeEvents (on) {
            on('after:screenshot', userHandler)
            on('after:screenshot', datadogHandler)
            on('after:run', datadogAfterRunHandler)
            on('task', taskHandler)
          },
        },
      }
      const handlers = {}
      const { cypressConfig, warnings } = loadCypressConfig()
      const resolvedConfig = {
        projectRoot,
        supportFile: false,
        isInteractive: true,
        experimentalInteractiveRunEvents: false,
      }

      cypressConfig.wrapConfig(config)
      config.e2e.setupNodeEvents(
        /**
         * @param {string} event Cypress event name
         * @param {Function} handler Cypress event handler
         */
        (event, handler) => {
          handlers[event] = handler
        },
        resolvedConfig
      )

      assert.strictEqual(resolvedConfig.experimentalInteractiveRunEvents, true)
      assert.deepStrictEqual(warnings, [
        'Datadog enabled Cypress experimentalInteractiveRunEvents so Test Optimization can finish the test session.',
      ])

      const details = { path: 'original.png' }
      await handlers['after:screenshot'](details)
      await handlers['after:run']({})

      assert.strictEqual(userHandler.calledOnceWithExactly(details), true)
      assert.strictEqual(datadogHandler.calledOnceWithExactly({ path: 'updated.png' }), true)
      sinon.assert.calledOnceWithExactly(datadogAfterRunHandler, {})
    })
  })

  describe('configuration wrapper', () => {
    it('falls back to the project root when the config directory is not writable', () => {
      const projectRoot = createProjectRoot()
      const configDirectory = path.join(projectRoot, 'config')
      const configFile = path.join(configDirectory, 'cypress.config.js')
      fs.mkdirSync(configDirectory)
      fs.writeFileSync(configFile, 'module.exports = {}\n')

      const { cypressConfig, warnings } = loadCypressConfig({
        openSync (filePath, flags) {
          if (path.dirname(filePath) === configDirectory) {
            throw createFileError('EACCES', filePath)
          }
          return fs.openSync(filePath, flags)
        },
      })
      const result = cypressConfig.wrapCliConfigFileOptions({
        configFile,
        project: projectRoot,
      })

      assert.strictEqual(path.dirname(result.options.configFile), projectRoot)
      assert.deepStrictEqual(warnings, [])
      assert.strictEqual(getGeneratedFiles(projectRoot).length, 1)

      result.cleanup()
      assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
    })

    it('uses .cts when a CommonJS TypeScript config falls back into an ESM scope', () => {
      const projectRoot = createProjectRoot()
      const configDirectory = path.join(projectRoot, 'config')
      const configFile = path.join(configDirectory, 'cypress.config.ts')
      fs.mkdirSync(configDirectory)
      fs.writeFileSync(path.join(projectRoot, 'package.json'), '{ "type": "module" }')
      fs.writeFileSync(path.join(configDirectory, 'package.json'), '{ "type": "commonjs" }')
      fs.writeFileSync(configFile, 'module.exports = {}\n')

      const { cypressConfig, warnings } = loadCypressConfig({
        openSync (filePath, flags) {
          if (path.dirname(filePath) === configDirectory) {
            throw createFileError('EACCES', filePath)
          }
          return fs.openSync(filePath, flags)
        },
      })
      const result = cypressConfig.wrapCliConfigFileOptions({
        configFile,
        project: projectRoot,
      })

      assert.strictEqual(path.dirname(result.options.configFile), projectRoot)
      assert.strictEqual(path.extname(result.options.configFile), '.cts')
      assert.match(fs.readFileSync(result.options.configFile, 'utf8'), /module\.exports/)
      assert.deepStrictEqual(warnings, [])

      result.cleanup()
      assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
    })

    it('uses .mts when an ESM TypeScript config falls back into a CommonJS scope', () => {
      const projectRoot = createProjectRoot()
      const configDirectory = path.join(projectRoot, 'config')
      const configFile = path.join(configDirectory, 'cypress.config.ts')
      fs.mkdirSync(configDirectory)
      fs.writeFileSync(path.join(projectRoot, 'package.json'), '{ "type": "commonjs" }')
      fs.writeFileSync(path.join(configDirectory, 'package.json'), '{ "type": "module" }')
      fs.writeFileSync(configFile, 'export default {}\n')

      const { cypressConfig, warnings } = loadCypressConfig({
        openSync (filePath, flags) {
          if (path.dirname(filePath) === configDirectory) {
            throw createFileError('EACCES', filePath)
          }
          return fs.openSync(filePath, flags)
        },
      })
      const result = cypressConfig.wrapCliConfigFileOptions({
        configFile,
        project: projectRoot,
      })

      assert.strictEqual(path.dirname(result.options.configFile), projectRoot)
      assert.strictEqual(path.extname(result.options.configFile), '.mts')
      assert.match(fs.readFileSync(result.options.configFile, 'utf8'), /export default/)
      assert.deepStrictEqual(warnings, [])

      result.cleanup()
      assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
    })

    it('warns with every failed location when no directory is writable', () => {
      const projectRoot = createProjectRoot()
      const configDirectory = path.join(projectRoot, 'config')
      const configFile = path.join(configDirectory, 'cypress.config.js')
      fs.mkdirSync(configDirectory)
      fs.writeFileSync(configFile, 'module.exports = {}\n')

      const { cypressConfig, errors, warnings } = loadCypressConfig({
        openSync (filePath) {
          throw createFileError('EROFS', filePath)
        },
      })
      const options = { configFile, project: projectRoot }
      const result = cypressConfig.wrapCliConfigFileOptions(options)

      assert.strictEqual(result.options, options)
      assert.deepStrictEqual(errors, [])
      assert.strictEqual(warnings.length, 1)
      assert.match(warnings[0], /could not create the Cypress configuration wrapper/)
      assert.strictEqual(warnings[0].match(/EROFS during open/g).length, 2)
      assert.match(warnings[0], new RegExp(configDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.match(warnings[0], new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    })

    it('does not overwrite an existing configuration wrapper', () => {
      const projectRoot = createProjectRoot()
      const configFile = path.join(projectRoot, 'cypress.config.js')
      const existingWrapper = path.join(projectRoot, `.dd-cypress-config-${process.pid}-collision.cjs`)
      fs.writeFileSync(configFile, 'module.exports = {}\n')
      fs.writeFileSync(existingWrapper, 'existing content\n')

      const { cypressConfig, warnings } = loadCypressConfig(undefined, () => 'collision')
      const options = { configFile, project: projectRoot }
      const result = cypressConfig.wrapCliConfigFileOptions(options)

      assert.strictEqual(result.options, options)
      assert.strictEqual(fs.readFileSync(existingWrapper, 'utf8'), 'existing content\n')
      assert.strictEqual(warnings.length, 1)
      assert.match(warnings[0], /EEXIST during open/)
    })

    it('removes a partial configuration wrapper when the filesystem runs out of space', () => {
      const projectRoot = createProjectRoot()
      const configFile = path.join(projectRoot, 'cypress.config.js')
      fs.writeFileSync(configFile, 'module.exports = {}\n')

      const { cypressConfig, warnings } = loadCypressConfig(createPartialWriteFailure('ENOSPC'))
      const options = { configFile, project: projectRoot }
      const result = cypressConfig.wrapCliConfigFileOptions(options)

      assert.strictEqual(result.options, options)
      assert.strictEqual(warnings.length, 1)
      assert.match(warnings[0], /ENOSPC during write/)
      assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
    })
  })
})
