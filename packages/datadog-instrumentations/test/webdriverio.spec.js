'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { promisify } = require('node:util')

const MochaTest = require('mocha/lib/test')
const sinon = require('sinon')

const MochaPlugin = require('../../datadog-plugin-mocha/src')
const log = require('../../dd-trace/src/log')
const { channel, tracingChannel } = require('../src/helpers/instrument')
const rewriter = require('../src/helpers/rewriter')
const { createEfdRetryPolicy } = require('../../dd-trace/src/ci-visibility/efd-retry-policy')
const { RUM_TEST_EXECUTION_ID_COOKIE_NAME } = require('../../dd-trace/src/ci-visibility/rum')
const { detectRum } = require('../src/rum-browser-scripts')
const {
  adjustRunnerFailuresForTestOptimization,
  efdTests,
} = require('../src/mocha/utils')
const {
  MOCHA_WORKER_LOGS_PAYLOAD_CODE,
  MOCHA_WORKER_TELEMETRY_PAYLOAD_CODE,
  MOCHA_WORKER_TRACE_PAYLOAD_CODE,
  TEST_FAILURE_SCREENSHOT_UPLOADED,
  TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR,
  TEST_HAS_DYNAMIC_NAME,
  TEST_BROWSER_NAME,
  TEST_BROWSER_VERSION,
  TEST_IS_RUM_ACTIVE,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_NAME,
  TEST_STATUS,
  TEST_SUITE,
  TEST_SUITE_EXECUTION_ID,
} = require('../../dd-trace/src/plugins/util/test')
const {
  CONFIGURATION_REQUEST,
  CONFIGURATION_RESPONSE,
  requestWebdriverioScreenshotUpload,
  SCREENSHOT_UPLOAD_RESPONSE,
  SCREENSHOT_UPLOAD_TIMEOUT_MS,
  SUITE_FINISH,
  WEBDRIVERIO_WORKER_ENV,
  WORKER_READY,
} = require('../src/mocha/webdriverio-protocol')
const { FINAL_FLUSH_TIMEOUT } = require('../../dd-trace/src/ci-visibility/final-flush')

const fixturePath = path.join(__dirname, 'fixtures', 'webdriverio-local-runner.mjs')
const delayedWorkerFixturePath = path.join(__dirname, 'fixtures', 'webdriverio-delayed-worker.js')
const disconnectedWorkerFixturePath = path.join(__dirname, 'fixtures', 'webdriverio-disconnected-worker.js')
const regularMochaWorkerFixturePath = path.join(__dirname, 'fixtures', 'mocha-regular-worker.js')
const fixtureModulePath = path.join(
  __dirname,
  'fixtures',
  'node_modules',
  '@wdio',
  'local-runner',
  'build',
  'index.js'
)
const runnerFixturePath = path.join(__dirname, 'fixtures', 'webdriverio-runner.mjs')
const runnerFixtureModulePath = path.join(
  __dirname,
  'fixtures',
  'node_modules',
  '@wdio',
  'runner',
  'build',
  'index.js'
)
const jasmineFixturePath = path.join(__dirname, 'fixtures', 'webdriverio-jasmine-framework.mjs')
const jasmineFixtureModulePath = path.join(
  __dirname,
  'fixtures',
  'node_modules',
  '@wdio',
  'jasmine-framework',
  'build',
  'index.js'
)
const jasmineCoreFixturePath = path.join(__dirname, 'fixtures', 'jasmine-core.js')
const jasmineCoreFixtureModulePath = path.join(
  __dirname,
  'fixtures',
  'node_modules',
  'jasmine-core',
  'lib',
  'jasmine-core',
  'jasmine.js'
)
const launcherFixturePath = path.join(__dirname, 'fixtures', 'webdriverio-launcher.mjs')
const launcherFixtureModulePath = path.join(
  __dirname,
  'fixtures',
  'node_modules',
  '@wdio',
  'cli',
  'build',
  'index.js'
)
const utilsFixturePath = path.join(__dirname, 'fixtures', 'webdriverio-utils.mjs')
const utilsFixtureModulePath = path.join(
  __dirname,
  'fixtures',
  'node_modules',
  '@wdio',
  'utils',
  'build',
  'index.js'
)
const browserFixturePath = path.join(__dirname, 'fixtures', 'webdriverio-browser.mjs')
const browserFixtureModulePaths = ['index.js', 'node.js'].map(file => path.join(
  __dirname,
  'fixtures',
  'node_modules',
  'webdriverio',
  'build',
  file
))
const execFileAsync = promisify(execFile)
const PNG_SCREENSHOT = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')

/**
 * Waits for a rewriter completion callback in unit tests.
 *
 * @param {(onDone: () => void) => void} callback
 * @returns {Promise<void>}
 */
function runCallback (callback) {
  return new Promise(callback)
}

/**
 * Cleans retained browser state through the same lifecycle used at worker exit.
 *
 * @returns {Promise<void>}
 */
async function cleanupRumState () {
  const context = {}
  tracingChannel('orchestrion:@wdio/runner:BaseReporter_waitForSync').asyncEnd.publish(context)
  if (context.resolveCallback) await runCallback(context.resolveCallback)
}

describe('webdriverio instrumentation', () => {
  it('detects RUM before its initialization configuration is available', () => {
    const previousWindow = global.window
    global.window = {
      DD_RUM: {
        getInitConfiguration: () => undefined,
        getInternalContext: () => undefined,
      },
    }

    try {
      assert.deepStrictEqual(detectRum(), {
        isRumActive: false,
        isRumInstrumented: true,
        rumSamplingRate: null,
      })
    } finally {
      if (previousWindow === undefined) {
        delete global.window
      } else {
        global.window = previousWindow
      }
    }
  })

  it('rewrites the ESM launcher scheduler', () => {
    const source = fs.readFileSync(launcherFixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, launcherFixtureModulePath, 'module')

    assert.notStrictEqual(rewrittenSource, source)
    assert.match(rewrittenSource, /orchestrion:@wdio\/cli:Launcher_startInstance/)
  })

  it('rewrites the ESM local runner and waits for coordinator shutdown', () => {
    const source = fs.readFileSync(fixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, fixtureModulePath, 'module')

    assert.notStrictEqual(rewrittenSource, source)
    assert.match(rewrittenSource, /orchestrion:@wdio\/local-runner:LocalRunner_run/)
    assert.match(rewrittenSource, /orchestrion:@wdio\/local-runner:LocalRunner_shutdown/)
    assert.match(rewrittenSource, /__apm\$ctx\.resolveCallback/)
    assert.match(rewrittenSource, /__apm\$ctx\.rejectCallback/)
  })

  it('rewrites the ESM worker runner and waits before worker exit', () => {
    const source = fs.readFileSync(runnerFixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, runnerFixtureModulePath, 'module')

    assert.notStrictEqual(rewrittenSource, source)
    assert.match(rewrittenSource, /orchestrion:@wdio\/runner:Runner_run/)
    assert.match(rewrittenSource, /__apm\$ctx\.rumCleanupCallback/)
    assert.match(rewrittenSource, /orchestrion:@wdio\/runner:BaseReporter_waitForSync/)
    assert.match(rewrittenSource, /__apm\$ctx\.resolveCallback/)
    assert.match(rewrittenSource, /__apm\$ctx\.rejectCallback/)
  })

  it('rewrites the ESM Jasmine adapter and reporter', () => {
    const source = fs.readFileSync(jasmineFixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, jasmineFixtureModulePath, 'module')

    assert.notStrictEqual(rewrittenSource, source)
    assert.match(rewrittenSource, /orchestrion:@wdio\/jasmine-framework:JasmineAdapter_init/)
    assert.match(rewrittenSource, /orchestrion:@wdio\/jasmine-framework:JasmineAdapter_run/)
    assert.match(rewrittenSource, /orchestrion:@wdio\/jasmine-framework:JasmineReporter_specDone/)
    assert.match(rewrittenSource, /orchestrion:@wdio\/jasmine-framework:JasmineReporter_specStarted/)
    assert.match(rewrittenSource, /orchestrion:@wdio\/jasmine-framework:JasmineReporter_suiteDone/)
    assert.match(rewrittenSource, /orchestrion:@wdio\/jasmine-framework:JasmineReporter_suiteStarted/)
    assert.match(rewrittenSource, /__apm\$ctx\.resolveCallback/)
    assert.match(rewrittenSource, /__apm\$ctx\.rejectCallback/)
  })

  it('rewrites the ESM WebdriverIO test-function wrapper', () => {
    const source = fs.readFileSync(utilsFixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, utilsFixtureModulePath, 'module')

    assert.notStrictEqual(rewrittenSource, source)
    assert.match(rewrittenSource, /orchestrion:@wdio\/utils:executeAsync/)
    assert.match(rewrittenSource, /orchestrion:@wdio\/utils:testFrameworkFnWrapper/)
    assert.match(rewrittenSource, /__apm\$ctx\.resolveCallback/)
    assert.match(rewrittenSource, /__apm\$ctx\.rejectCallback/)
    assert.match(rewrittenSource, /__apm\$ctx\.rumCleanupCallback/)
    assert.match(rewrittenSource, /__apm\$ctx\.rumStartCallback/)
    assert.match(rewrittenSource, /__apm\$ctx\.retryCallback/)
  })

  it('rewrites WebdriverIO URL navigation and waits for RUM correlation', () => {
    const source = fs.readFileSync(browserFixturePath, 'utf8')
    for (const modulePath of browserFixtureModulePaths) {
      const rewrittenSource = rewriter.rewrite(source, modulePath, 'module')

      assert.notStrictEqual(rewrittenSource, source)
      assert.match(rewrittenSource, /orchestrion:webdriverio:url/)
      assert.match(rewrittenSource, /__apm\$ctx\.rumPreloadCallback/)
      assert.match(rewrittenSource, /__apm\$ctx\.resolveCallback/)
      assert.match(rewrittenSource, /__apm\$ctx\.rejectCallback/)
    }
  })

  it('installs BiDi RUM correlation before a non-blocking navigation', async () => {
    require('../src/webdriverio')

    const source = fs.readFileSync(browserFixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, browserFixtureModulePaths[0], 'module')
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-webdriverio-browser-rewriter-'))
    const outputPath = path.join(outputDirectory, 'index.mjs')
    const correlationCh = channel('ci:webdriverio:rum:page-navigate')
    const testFunctionCh = tracingChannel('orchestrion:@wdio/utils:testFrameworkFnWrapper')
    const calls = []
    const rumStates = []
    const browser = {
      scriptAddPreloadScript: sinon.stub().callsFake(() => {
        calls.push('add-preload')
        return Promise.resolve({ script: 'rum-preload' })
      }),
      scriptRemovePreloadScript: sinon.stub().callsFake(() => {
        calls.push('remove-preload')
        return Promise.resolve()
      }),
      capabilities: {},
      deleteCookies: sinon.stub().callsFake(() => {
        calls.push('delete')
        return Promise.resolve()
      }),
      execute: sinon.stub()
        .onFirstCall().callsFake(() => {
          calls.push('detect')
          return Promise.resolve({
            isRumActive: false,
            isRumInstrumented: false,
            rumSamplingRate: null,
          })
        })
        .onSecondCall().callsFake(() => {
          calls.push('detect-at-test-end')
          return Promise.resolve({
            isRumActive: true,
            isRumInstrumented: true,
            rumSamplingRate: 100,
          })
        })
        .onThirdCall().callsFake(() => {
          calls.push('cleanup')
          return Promise.resolve(false)
        }),
      getWindowHandle: sinon.stub().callsFake(() => {
        calls.push('handle')
        return Promise.resolve('window-a')
      }),
      getWindowHandles: sinon.stub().callsFake(() => {
        calls.push('handles')
        return Promise.resolve(['window-a'])
      }),
      isBidi: true,
      navigateTo: sinon.stub().callsFake((url, options) => {
        calls.push(`navigate:${options.wait}`)
        return Promise.resolve()
      }),
      storageDeleteCookies: sinon.stub().resolves(),
      switchToWindow: sinon.stub().callsFake((windowHandle) => {
        calls.push(`switch:${windowHandle}`)
        return Promise.resolve()
      }),
    }
    const correlate = context => {
      rumStates.push(context.isRumActive)
      context.testExecutionId = '1234'
    }
    correlationCh.subscribe(correlate)

    try {
      fs.writeFileSync(outputPath, rewrittenSource)
      const { url3 } = await import(pathToFileURL(outputPath))
      await url3.call(browser, 'https://example.test', { wait: 'none' })

      assert.deepStrictEqual(calls, [
        'add-preload',
        'handle',
        'navigate:none',
        'detect',
      ])

      const testContext = { arguments: [undefined, 'Test'] }
      testFunctionCh.asyncEnd.publish(testContext)
      await runCallback(testContext.resolveCallback)

      assert.deepStrictEqual(calls.slice(4), [
        'detect-at-test-end',
      ])
      assert.deepStrictEqual(rumStates, [undefined, false, true])

      const afterEachContext = {
        arguments: [undefined, 'Hook', undefined, undefined, undefined, undefined, undefined, 'afterEach'],
      }
      testFunctionCh.asyncEnd.publish(afterEachContext)
      await runCallback(afterEachContext.resolveCallback)

      assert.deepStrictEqual(calls.slice(5), [
        'cleanup',
        'remove-preload',
        'handle',
        'handles',
        'switch:window-a',
        'delete',
      ])
    } finally {
      correlationCh.unsubscribe(correlate)
    }
  })

  it('correlates classic sessions before asynchronous RUM initialization', async () => {
    require('../src/webdriverio')

    const correlationCh = channel('ci:webdriverio:rum:page-navigate')
    const urlCh = tracingChannel('orchestrion:webdriverio:url')
    const testFunctionCh = tracingChannel('orchestrion:@wdio/utils:testFrameworkFnWrapper')
    const rumStates = []
    const browser = {
      capabilities: {},
      deleteCookies: sinon.stub().resolves(),
      execute: sinon.stub()
        .onFirstCall().resolves({
          isRumActive: false,
          isRumInstrumented: false,
          rumSamplingRate: null,
        })
        .onSecondCall().resolves({
          isRumActive: true,
          isRumInstrumented: true,
          rumSamplingRate: 100,
        })
        .onThirdCall().resolves({
          isRumActive: false,
          isRumInstrumented: true,
          rumSamplingRate: 50,
        }),
      sendCommand: sinon.stub().resolves(),
      setCookies: sinon.stub().resolves(),
    }
    browser.execute.onCall(3).resolves({
      isRumActive: true,
      isRumInstrumented: true,
      rumSamplingRate: 100,
    })
    browser.execute.onCall(4).resolves(false)
    const correlate = context => {
      rumStates.push(context.isRumActive)
      context.testExecutionId = 'classic-test-id'
    }
    correlationCh.subscribe(correlate)

    try {
      const navigationContext = { self: browser }
      urlCh.asyncEnd.publish(navigationContext)
      await runCallback(navigationContext.resolveCallback)

      assert.deepStrictEqual(browser.setCookies.firstCall.args, [{
        name: RUM_TEST_EXECUTION_ID_COOKIE_NAME,
        value: 'classic-test-id',
      }])

      const executeAsyncContext = {}
      channel('tracing:orchestrion:@wdio/utils:executeAsync:start').runStores(executeAsyncContext, () => {})
      await executeAsyncContext.rumStartCallback()
      await executeAsyncContext.rumStartCallback()

      const testContext = { arguments: [undefined, 'Test'] }
      testFunctionCh.asyncEnd.publish(testContext)
      await runCallback(testContext.resolveCallback)

      const afterEachContext = {
        arguments: [undefined, 'Hook', undefined, undefined, undefined, undefined, undefined, 'afterEach'],
      }
      testFunctionCh.asyncEnd.publish(afterEachContext)
      await runCallback(afterEachContext.resolveCallback)

      assert.deepStrictEqual(rumStates, [false, true, true])
    } finally {
      correlationCh.unsubscribe(correlate)
    }
  })

  it('cleans the RUM correlation cookie from every classic Chromium origin without loading it', async () => {
    require('../src/webdriverio')

    const correlationCh = channel('ci:webdriverio:rum:page-navigate')
    const urlCh = tracingChannel('orchestrion:webdriverio:url')
    const testFunctionCh = tracingChannel('orchestrion:@wdio/utils:testFrameworkFnWrapper')
    const calls = []
    let mainWindowUrl = 'https://first.example.test/path'
    let currentUrl = mainWindowUrl
    const browser = {
      capabilities: {},
      deleteCookies: sinon.stub().callsFake(() => {
        calls.push(`delete:${new URL(currentUrl).origin}`)
        return Promise.resolve()
      }),
      execute: sinon.stub().resolves({
        isRumActive: true,
        isRumInstrumented: true,
        rumSamplingRate: 100,
      }),
      getUrl: sinon.stub().callsFake(() => Promise.resolve(currentUrl)),
      getWindowHandle: sinon.stub().resolves('window-a'),
      getWindowHandles: sinon.stub().resolves(['window-a']),
      sendCommand: sinon.stub().callsFake((command, { url }) => {
        calls.push(`command:${command}:${url}`)
        return Promise.resolve()
      }),
      setCookies: sinon.stub().callsFake(() => {
        calls.push(`set:${new URL(currentUrl).origin}`)
        return Promise.resolve()
      }),
      switchToWindow: sinon.stub().callsFake((windowHandle) => {
        calls.push(`switch:${windowHandle}`)
        if (windowHandle === 'window-a') currentUrl = mainWindowUrl
        return Promise.resolve()
      }),
    }
    const correlate = context => {
      context.testExecutionId = '1234'
    }
    correlationCh.subscribe(correlate)

    try {
      const firstNavigationContext = { self: browser }
      urlCh.asyncEnd.publish(firstNavigationContext)
      await runCallback(firstNavigationContext.resolveCallback)

      mainWindowUrl = 'https://second.example.test/path'
      currentUrl = mainWindowUrl
      const secondNavigationContext = { self: browser }
      urlCh.asyncEnd.publish(secondNavigationContext)
      await runCallback(secondNavigationContext.resolveCallback)

      const testContext = { arguments: [undefined, 'Test'] }
      testFunctionCh.asyncEnd.publish(testContext)
      await runCallback(testContext.resolveCallback)

      const afterEachContext = {
        arguments: [undefined, 'Hook', undefined, undefined, undefined, undefined, undefined, 'afterEach'],
      }
      testFunctionCh.asyncEnd.publish(afterEachContext)
      await runCallback(afterEachContext.resolveCallback)

      assert.deepStrictEqual(calls, [
        'switch:window-a',
        'set:https://first.example.test',
        'switch:window-a',
        'set:https://second.example.test',
        'switch:window-a',
        'delete:https://second.example.test',
        'command:Network.deleteCookies:https://first.example.test/path',
      ])
      assert.strictEqual(browser.execute.callCount, 4)
    } finally {
      correlationCh.unsubscribe(correlate)
    }
  })

  it('does not leave RUM correlation cookies in classic browsers without cross-origin cleanup', async () => {
    require('../src/webdriverio')

    const correlationCh = channel('ci:webdriverio:rum:page-navigate')
    const urlCh = tracingChannel('orchestrion:webdriverio:url')
    const browser = {
      capabilities: {
        browserName: 'firefox',
        browserVersion: '123',
      },
      execute: sinon.stub().resolves({
        isRumActive: true,
        isRumInstrumented: true,
        rumSamplingRate: 100,
      }),
      setCookies: sinon.stub().resolves(),
    }
    const correlationContexts = []
    const correlate = context => {
      correlationContexts.push({
        browserName: context.browserName,
        browserVersion: context.browserVersion,
        isRumActive: context.isRumActive,
      })
      context.testExecutionId = '1234'
    }
    correlationCh.subscribe(correlate)

    try {
      const navigationContext = { self: browser }
      urlCh.asyncEnd.publish(navigationContext)
      await runCallback(navigationContext.resolveCallback)

      const executeAsyncContext = {}
      channel('tracing:orchestrion:@wdio/utils:executeAsync:start').runStores(executeAsyncContext, () => {})
      await executeAsyncContext.rumCorrelationCallback([browser], 'retry-execution-id')

      assert.deepStrictEqual(correlationContexts, [{
        browserName: 'firefox',
        browserVersion: '123',
        isRumActive: false,
      }])
      assert.strictEqual(browser.setCookies.callCount, 0)
    } finally {
      correlationCh.unsubscribe(correlate)
    }
  })

  it('does not retain standalone WebdriverIO clients in regular Mocha tests', async () => {
    require('../src/webdriverio')
    await cleanupRumState()

    const correlationCh = channel('ci:webdriverio:rum:page-navigate')
    const urlCh = tracingChannel('orchestrion:webdriverio:url')
    const browser = {
      capabilities: {},
      deleteCookies: sinon.stub().resolves(),
      execute: sinon.stub().resolves({
        isRumActive: true,
        isRumInstrumented: true,
        rumSamplingRate: 100,
      }),
      setCookies: sinon.stub().resolves(),
    }
    const ignoreCorrelation = () => {}
    correlationCh.subscribe(ignoreCorrelation)

    try {
      const navigationContext = { self: browser }
      urlCh.asyncEnd.publish(navigationContext)
      await runCallback(navigationContext.resolveCallback)

      const workerExitContext = {}
      tracingChannel('orchestrion:@wdio/runner:BaseReporter_waitForSync').asyncEnd.publish(workerExitContext)

      assert.strictEqual(browser.setCookies.callCount, 0)
      assert.strictEqual(workerExitContext.resolveCallback, undefined)
    } finally {
      correlationCh.unsubscribe(ignoreCorrelation)
    }
  })

  it('correlates a page left behind by a rejected URL command', async () => {
    require('../src/webdriverio')

    const source = fs.readFileSync(browserFixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, browserFixtureModulePaths[0], 'module')
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-webdriverio-browser-rewriter-'))
    const outputPath = path.join(outputDirectory, 'index.mjs')
    const correlationCh = channel('ci:webdriverio:rum:page-navigate')
    const testFunctionCh = tracingChannel('orchestrion:@wdio/utils:testFrameworkFnWrapper')
    const navigationError = new Error('page load timed out')
    const calls = []
    const browser = {
      capabilities: {},
      deleteCookies: sinon.stub().callsFake((name) => {
        calls.push(`delete:${name}`)
        return Promise.resolve()
      }),
      execute: sinon.stub()
        .onFirstCall().resolves({
          isRumActive: true,
          isRumInstrumented: true,
          rumSamplingRate: 100,
        })
        .onSecondCall().resolves({
          isRumActive: true,
          isRumInstrumented: true,
          rumSamplingRate: 100,
        })
        .onThirdCall().resolves(false),
      navigateTo: sinon.stub().callsFake(() => {
        calls.push('navigate')
        return Promise.reject(navigationError)
      }),
      sendCommand: sinon.stub().resolves(),
      setCookies: sinon.stub().callsFake(() => {
        calls.push('set')
        return Promise.resolve()
      }),
    }
    const correlate = context => {
      context.testExecutionId = '1234'
    }
    correlationCh.subscribe(correlate)

    try {
      fs.writeFileSync(outputPath, rewrittenSource)
      const { url3 } = await import(pathToFileURL(outputPath))
      await assert.rejects(url3.call(browser, 'https://example.test'), error => error === navigationError)

      const testContext = { arguments: [undefined, 'Test'] }
      testFunctionCh.asyncEnd.publish(testContext)
      await runCallback(testContext.resolveCallback)

      const afterEachContext = {
        arguments: [undefined, 'Hook', undefined, undefined, undefined, undefined, undefined, 'afterEach'],
      }
      testFunctionCh.asyncEnd.publish(afterEachContext)
      await runCallback(afterEachContext.resolveCallback)

      assert.deepStrictEqual(calls, [
        'navigate',
        'set',
        `delete:${RUM_TEST_EXECUTION_ID_COOKIE_NAME}`,
      ])
      assert.strictEqual(browser.execute.callCount, 3)
    } finally {
      correlationCh.unsubscribe(correlate)
    }
  })

  it('preserves a suite-hook page when RUM becomes active after navigation', async () => {
    require('../src/webdriverio')

    const source = fs.readFileSync(utilsFixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, utilsFixtureModulePath, 'module')
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-webdriverio-utils-rewriter-'))
    const outputPath = path.join(outputDirectory, 'index.mjs')
    const correlationCh = channel('ci:webdriverio:rum:page-navigate')
    const testFunctionCh = tracingChannel('orchestrion:@wdio/utils:testFrameworkFnWrapper')
    const urlCh = tracingChannel('orchestrion:webdriverio:url')
    const calls = []
    let hasTestSpan = false
    const browser = {
      capabilities: {},
      deleteCookies: sinon.stub().callsFake(() => {
        calls.push('delete')
        return Promise.resolve()
      }),
      execute: sinon.stub()
        .onFirstCall().resolves({
          isRumActive: false,
          isRumInstrumented: false,
          rumSamplingRate: null,
        })
        .onSecondCall().resolves({
          isRumActive: true,
          isRumInstrumented: true,
          rumSamplingRate: 100,
        })
        .onThirdCall().resolves({
          isRumActive: true,
          isRumInstrumented: true,
          rumSamplingRate: 100,
        })
        .onCall(3).callsFake(() => {
          calls.push('stop')
          return Promise.resolve(true)
        }),
      sendCommand: sinon.stub().resolves(),
      setCookies: sinon.stub().callsFake(() => {
        calls.push('set')
        return Promise.resolve()
      }),
    }
    const correlate = context => {
      context.isTestOptimizationRunner = true
      if (hasTestSpan) context.testExecutionId = 'suite-test-id'
    }
    correlationCh.subscribe(correlate)

    try {
      const navigationContext = { self: browser }
      urlCh.asyncEnd.publish(navigationContext)
      await runCallback(navigationContext.resolveCallback)

      hasTestSpan = true
      fs.writeFileSync(outputPath, rewrittenSource)
      const { executeAsync } = await import(pathToFileURL(outputPath))
      await executeAsync(() => {
        calls.push('test')
      }, { attempts: 0, limit: 0 })

      const afterEachContext = {
        arguments: [undefined, 'Hook', undefined, undefined, undefined, undefined, undefined, 'afterEach'],
      }
      testFunctionCh.asyncEnd.publish(afterEachContext)
      await runCallback(afterEachContext.resolveCallback)

      assert.deepStrictEqual(calls, ['set', 'test', 'delete'])
      assert.strictEqual(browser.execute.callCount, 3)
      assert.deepStrictEqual(browser.setCookies.firstCall.args, [{
        name: RUM_TEST_EXECUTION_ID_COOKIE_NAME,
        value: 'suite-test-id',
      }])
    } finally {
      correlationCh.unsubscribe(correlate)
      await cleanupRumState()
    }
  })

  it('rewrites legacy and modern Jasmine spec lifecycles', () => {
    const source = fs.readFileSync(jasmineCoreFixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, jasmineCoreFixtureModulePath)

    assert.notStrictEqual(rewrittenSource, source)
    assert.match(rewrittenSource, /orchestrion:jasmine-core:Spec_execute/)
    assert.match(rewrittenSource, /orchestrion:jasmine-core:Spec_attemptDone/)
  })

  it('runs the WebdriverIO retry callback before a failed test is retried', async () => {
    const source = fs.readFileSync(utilsFixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, utilsFixtureModulePath, 'module')
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-webdriverio-utils-rewriter-'))
    const outputPath = path.join(outputDirectory, 'index.mjs')
    const callbacks = []
    const retries = { attempts: 0, limit: 2 }
    const executeAsyncCh = tracingChannel('orchestrion:@wdio/utils:executeAsync')
    const subscriber = {
      start (ctx) {
        ctx.retryCallback = async function (error) {
          callbacks.push(error.message)
          await new Promise(resolve => setImmediate(resolve))
        }
      },
    }
    let attempts = 0

    executeAsyncCh.subscribe(subscriber)
    try {
      fs.writeFileSync(outputPath, rewrittenSource)

      const { executeAsync } = await import(pathToFileURL(outputPath))
      const result = await executeAsync(() => {
        attempts++
        if (attempts === 1) {
          throw new Error('failed attempt')
        }
        return attempts
      }, retries)

      assert.strictEqual(result, 2)
      assert.strictEqual(retries.attempts, 1)
      assert.deepStrictEqual(callbacks, ['failed attempt'])
    } finally {
      executeAsyncCh.unsubscribe(subscriber)
    }
  })

  it('honors WebdriverIO retry limits changed by the callback', async () => {
    const source = fs.readFileSync(utilsFixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, utilsFixtureModulePath, 'module')
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-webdriverio-utils-rewriter-'))
    const outputPath = path.join(outputDirectory, 'index.mjs')
    const failedRetries = { attempts: 0, limit: 1 }
    const executeAsyncCh = tracingChannel('orchestrion:@wdio/utils:executeAsync')
    const subscriber = {
      start (ctx) {
        ctx.retryCallback = async function () {
          failedRetries.limit = 0
        }
      },
    }
    let failedAttempts = 0

    executeAsyncCh.subscribe(subscriber)
    try {
      fs.writeFileSync(outputPath, rewrittenSource)

      const { executeAsync } = await import(pathToFileURL(outputPath))
      await assert.rejects(executeAsync(() => {
        failedAttempts++
        throw new Error('failed attempt')
      }, failedRetries), /failed attempt/)

      assert.strictEqual(failedAttempts, 1)
      assert.strictEqual(failedRetries.attempts, 0)
    } finally {
      executeAsyncCh.unsubscribe(subscriber)
    }
  })

  it('preserves WebdriverIO retries when the retry callback rejects', async () => {
    const source = fs.readFileSync(utilsFixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, utilsFixtureModulePath, 'module')
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-webdriverio-utils-rewriter-'))
    const outputPath = path.join(outputDirectory, 'index.mjs')
    const retries = { attempts: 0, limit: 1 }
    const executeAsyncCh = tracingChannel('orchestrion:@wdio/utils:executeAsync')
    const subscriber = {
      start (ctx) {
        ctx.retryCallback = () => Promise.reject(new Error('observability callback failed'))
      },
    }
    let attempts = 0

    executeAsyncCh.subscribe(subscriber)
    try {
      fs.writeFileSync(outputPath, rewrittenSource)

      const { executeAsync } = await import(pathToFileURL(outputPath))
      const result = await executeAsync(() => {
        attempts++
        if (attempts === 1) {
          throw new Error('test failed')
        }
        return 'passed'
      }, retries)

      assert.strictEqual(result, 'passed')
      assert.strictEqual(attempts, 2)
      assert.strictEqual(retries.attempts, 1)
    } finally {
      executeAsyncCh.unsubscribe(subscriber)
    }
  })

  it('keeps RUM correlated after a failed beforeEach hook', async () => {
    require('../src/webdriverio')

    const source = fs.readFileSync(utilsFixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, utilsFixtureModulePath, 'module')
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-webdriverio-utils-rewriter-'))
    const outputPath = path.join(outputDirectory, 'index.mjs')
    const correlationCh = channel('ci:webdriverio:rum:page-navigate')
    const urlCh = tracingChannel('orchestrion:webdriverio:url')
    const calls = []
    const browser = {
      capabilities: {},
      deleteCookies: sinon.stub().callsFake((name) => {
        calls.push(`delete:${name}`)
        return Promise.resolve()
      }),
      execute: sinon.stub()
        .onFirstCall().resolves({
          isRumActive: true,
          isRumInstrumented: true,
          rumSamplingRate: 100,
        })
        .onSecondCall().resolves(false),
      sendCommand: sinon.stub().resolves(),
      setCookies: sinon.stub().callsFake(() => {
        calls.push('set')
        return Promise.resolve()
      }),
    }
    const correlate = context => {
      context.testExecutionId = '1234'
    }
    const beforeEachError = new Error('beforeEach failed')

    correlationCh.subscribe(correlate)
    try {
      const navigationContext = { self: browser }
      urlCh.asyncEnd.publish(navigationContext)
      await runCallback(navigationContext.resolveCallback)

      fs.writeFileSync(outputPath, rewrittenSource)
      const { testFrameworkFnWrapper } = await import(pathToFileURL(outputPath))
      await assert.rejects(testFrameworkFnWrapper(
        {},
        'Hook',
        { specFn: () => { throw beforeEachError } },
        undefined,
        undefined,
        '0-0',
        0,
        'beforeEach'
      ), error => error === beforeEachError)

      assert.deepStrictEqual(calls, [
        'set',
      ])
      assert.strictEqual(browser.execute.callCount, 1)
    } finally {
      correlationCh.unsubscribe(correlate)
      await cleanupRumState()
    }
  })

  it('detects RUM activated by same-page afterEach activity before cleanup', async () => {
    require('../src/webdriverio')

    const correlationCh = channel('ci:webdriverio:rum:page-navigate')
    const urlCh = tracingChannel('orchestrion:webdriverio:url')
    const testFunctionCh = tracingChannel('orchestrion:@wdio/utils:testFrameworkFnWrapper')
    const calls = []
    const rumStates = []
    const browser = {
      capabilities: {
        browserName: 'chrome',
        browserVersion: '123',
      },
      deleteCookies: sinon.stub().callsFake((name) => {
        calls.push(`delete:${name}`)
        return Promise.resolve()
      }),
      execute: sinon.stub()
        .onFirstCall().resolves({
          isRumActive: false,
          isRumInstrumented: false,
          rumSamplingRate: null,
        })
        .onSecondCall().resolves({
          isRumActive: false,
          isRumInstrumented: false,
          rumSamplingRate: null,
        })
        .onThirdCall().resolves({
          isRumActive: true,
          isRumInstrumented: true,
          rumSamplingRate: 100,
        }),
      sendCommand: sinon.stub().resolves(),
      setCookies: sinon.stub().callsFake((cookie) => {
        calls.push(`set:${cookie.value}`)
        return Promise.resolve()
      }),
    }
    const correlate = context => {
      assert.strictEqual(context.browserName, 'chrome')
      assert.strictEqual(context.browserVersion, '123')
      rumStates.push(context.isRumActive)
      context.testExecutionId = '1234'
    }
    correlationCh.subscribe(correlate)

    try {
      const navigationContext = { self: browser }
      urlCh.asyncEnd.publish(navigationContext)
      await runCallback(navigationContext.resolveCallback)

      assert.strictEqual(browser.execute.callCount, 1)
      assert.strictEqual(browser.execute.firstCall.args.length, 1)
      assert.deepStrictEqual(calls, [
        'set:1234',
      ])
      assert.deepStrictEqual(rumStates, [false])

      calls.push('user-after-test')
      const testContext = { arguments: [undefined, 'Test'] }
      testFunctionCh.asyncEnd.publish(testContext)
      await runCallback(testContext.resolveCallback)

      assert.deepStrictEqual(calls, [
        'set:1234',
        'user-after-test',
      ])
      assert.strictEqual(browser.execute.callCount, 2)
      assert.deepStrictEqual(rumStates, [false])

      const beforeEachContext = {
        arguments: [undefined, 'Hook', undefined, undefined, undefined, undefined, undefined, 'beforeEach'],
      }
      testFunctionCh.asyncEnd.publish(beforeEachContext)
      assert.strictEqual(beforeEachContext.resolveCallback, undefined)

      calls.push('user-after-each')

      const afterEachContext = {
        arguments: [undefined, 'Hook', undefined, undefined, undefined, undefined, undefined, 'afterEach'],
      }
      testFunctionCh.asyncEnd.publish(afterEachContext)
      await runCallback(afterEachContext.resolveCallback)

      assert.deepStrictEqual(calls, [
        'set:1234',
        'user-after-test',
        'user-after-each',
        `delete:${RUM_TEST_EXECUTION_ID_COOKIE_NAME}`,
      ])
      assert.strictEqual(browser.execute.callCount, 3)
      assert.deepStrictEqual(rumStates, [false, true])
    } finally {
      correlationCh.unsubscribe(correlate)
    }
  })

  it('re-correlates a RUM page reused by the next test without navigation', async () => {
    require('../src/webdriverio')

    const source = fs.readFileSync(utilsFixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, utilsFixtureModulePath, 'module')
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-webdriverio-utils-rewriter-'))
    const outputPath = path.join(outputDirectory, 'index.mjs')
    const correlationCh = channel('ci:webdriverio:rum:page-navigate')
    const urlCh = tracingChannel('orchestrion:webdriverio:url')
    const calls = []
    const browser = {
      capabilities: {},
      deleteCookies: sinon.stub().callsFake(() => {
        calls.push('delete')
        return Promise.resolve()
      }),
      execute: sinon.stub().callsFake((script) => {
        if (script.name === 'detectRum') {
          calls.push('detect')
          return Promise.resolve({
            isRumActive: true,
            isRumInstrumented: true,
            rumSamplingRate: 100,
          })
        }
        calls.push('stop')
        return Promise.resolve(true)
      }),
      sendCommand: sinon.stub().resolves(),
      setCookies: sinon.stub().callsFake(({ value }) => {
        calls.push(`set:${value}`)
        return Promise.resolve()
      }),
    }
    let testExecutionId = 'first-test-id'
    const correlate = context => { context.testExecutionId = testExecutionId }
    correlationCh.subscribe(correlate)

    try {
      const navigationContext = { self: browser }
      urlCh.asyncEnd.publish(navigationContext)
      await runCallback(navigationContext.resolveCallback)

      fs.writeFileSync(outputPath, rewrittenSource)
      const { executeAsync, testFrameworkFnWrapper } = await import(pathToFileURL(outputPath))
      const firstTestError = new Error('first test failed')
      await assert.rejects(testFrameworkFnWrapper({}, 'Test', {
        specFn () {
          calls.push('first-test')
          throw firstTestError
        },
      }), error => error === firstTestError)
      await testFrameworkFnWrapper({}, 'Test', {
        async specFn () {
          testExecutionId = 'second-test-id'
          await executeAsync(() => {
            calls.push('second-test')
          }, { attempts: 0, limit: 0 })
        },
      })

      assert.deepStrictEqual(calls, [
        'detect',
        'set:first-test-id',
        'first-test',
        'detect',
        'delete',
        'detect',
        'set:second-test-id',
        'second-test',
        'detect',
      ])
    } finally {
      correlationCh.unsubscribe(correlate)
      await cleanupRumState()
    }
  })

  it('preloads RUM correlation in current and future browsing contexts', async () => {
    require('../src/webdriverio')

    const correlationCh = channel('ci:webdriverio:rum:page-navigate')
    const urlCh = tracingChannel('orchestrion:webdriverio:url')
    const testFunctionCh = tracingChannel('orchestrion:@wdio/utils:testFrameworkFnWrapper')
    const calls = []
    let preloadScript
    const browser = {
      scriptAddPreloadScript: sinon.stub().callsFake((options) => {
        calls.push('add-preload')
        preloadScript = options.functionDeclaration
        return Promise.resolve({ script: 'rum-preload' })
      }),
      scriptRemovePreloadScript: sinon.stub().callsFake(() => {
        calls.push('remove-preload')
        return Promise.resolve()
      }),
      capabilities: {},
      deleteCookies: sinon.stub().callsFake(() => {
        calls.push('delete-current')
        return Promise.resolve()
      }),
      execute: sinon.stub().callsFake((script) => Promise.resolve(script.name === 'detectRum'
        ? { isRumActive: true, isRumInstrumented: true, rumSamplingRate: 100 }
        : false)),
      getWindowHandle: sinon.stub().resolves('window-a'),
      getWindowHandles: sinon.stub().resolves(['window-a']),
      isBidi: true,
      setCookies: sinon.stub().callsFake(() => {
        calls.push('set-current')
        return Promise.resolve()
      }),
      switchToWindow: sinon.stub().callsFake((windowHandle) => {
        calls.push(`switch:${windowHandle}`)
        return Promise.resolve()
      }),
      storageDeleteCookies: sinon.stub().callsFake(() => {
        calls.push('delete-all')
        return Promise.resolve()
      }),
    }
    const correlate = context => {
      context.testExecutionId = '1234'
    }
    correlationCh.subscribe(correlate)

    try {
      const firstNavigationContext = { self: browser }
      urlCh.asyncEnd.publish(firstNavigationContext)
      await runCallback(firstNavigationContext.resolveCallback)

      assert.strictEqual(
        preloadScript,
        'cookie => { globalThis.document.cookie = cookie }'
      )

      const testContext = { arguments: [undefined, 'Test'] }
      testFunctionCh.asyncEnd.publish(testContext)
      await runCallback(testContext.resolveCallback)

      const afterEachContext = {
        arguments: [undefined, 'Hook', undefined, undefined, undefined, undefined, undefined, 'afterEach'],
      }
      testFunctionCh.asyncEnd.publish(afterEachContext)
      await runCallback(afterEachContext.resolveCallback)

      assert.deepStrictEqual(calls, [
        'switch:window-a',
        'set-current',
        'add-preload',
        'remove-preload',
        'switch:window-a',
        'delete-current',
        'delete-all',
      ])
      assert.deepStrictEqual(browser.storageDeleteCookies.firstCall.args, [{
        filter: { name: RUM_TEST_EXECUTION_ID_COOKIE_NAME },
      }])
      assert.deepStrictEqual(browser.scriptAddPreloadScript.firstCall.args, [{
        arguments: [{
          type: 'string',
          value: `${RUM_TEST_EXECUTION_ID_COOKIE_NAME}=1234; path=/`,
        }],
        functionDeclaration: preloadScript,
      }])
      assert.deepStrictEqual(browser.scriptRemovePreloadScript.firstCall.args, [{ script: 'rum-preload' }])
      assert.strictEqual(browser.execute.callCount, 3)
    } finally {
      correlationCh.unsubscribe(correlate)
    }
  })

  it('re-correlates every browser window with a retry execution ID', async () => {
    require('../src/webdriverio')

    const executeAsyncContext = {}
    let currentWindowHandle = 'window-a'
    const browser = {
      capabilities: {
        browserName: 'chrome',
        browserVersion: '123',
      },
      deleteCookies: sinon.stub().resolves(),
      execute: sinon.stub().resolves(false),
      getWindowHandle: sinon.stub().callsFake(() => Promise.resolve(currentWindowHandle)),
      getWindowHandles: sinon.stub().resolves(['window-a', 'window-b']),
      isBidi: true,
      scriptAddPreloadScript: sinon.stub().resolves({ script: 'rum-preload' }),
      scriptRemovePreloadScript: sinon.stub().resolves(),
      setCookies: sinon.stub().resolves(),
      storageDeleteCookies: sinon.stub().resolves(),
      switchToWindow: sinon.stub().callsFake((windowHandle) => {
        currentWindowHandle = windowHandle
        return Promise.resolve()
      }),
    }

    channel('tracing:orchestrion:@wdio/utils:executeAsync:start').runStores(executeAsyncContext, () => {})
    await executeAsyncContext.rumCorrelationCallback([browser], 'initial-execution-id')
    browser.setCookies.resetHistory()
    browser.switchToWindow.resetHistory()

    const rumCorrelation = await executeAsyncContext.rumRetryCallback('retry-execution-id')

    assert.deepStrictEqual(browser.switchToWindow.args.map(([windowHandle]) => windowHandle), [
      'window-a',
      'window-b',
      'window-a',
    ])
    assert.deepStrictEqual(browser.setCookies.args, [
      [{ name: RUM_TEST_EXECUTION_ID_COOKIE_NAME, value: 'retry-execution-id' }],
      [{ name: RUM_TEST_EXECUTION_ID_COOKIE_NAME, value: 'retry-execution-id' }],
    ])
    assert.strictEqual(browser.scriptAddPreloadScript.callCount, 2)
    assert.deepStrictEqual(browser.scriptAddPreloadScript.secondCall.args, [{
      arguments: [{
        type: 'string',
        value: `${RUM_TEST_EXECUTION_ID_COOKIE_NAME}=retry-execution-id; path=/`,
      }],
      functionDeclaration: 'cookie => { globalThis.document.cookie = cookie }',
    }])
    assert.deepStrictEqual(browser.scriptRemovePreloadScript.firstCall.args, [{ script: 'rum-preload' }])
    assert.strictEqual(browser.execute.callCount, 1)
    assert.deepStrictEqual(rumCorrelation, {
      browserName: 'chrome',
      browserVersion: '123',
      isRumActive: false,
    })

    await executeAsyncContext.rumCleanupCallback()
  })

  it('checks RUM before marking a Mocha retry as RUM-active', async () => {
    require('../src/webdriverio')

    const correlationCh = channel('ci:webdriverio:rum:page-navigate')
    const executeAsyncContext = {}
    const rumStates = []
    const browser = {
      capabilities: {},
      deleteCookies: sinon.stub().resolves(),
      execute: sinon.stub().resolves({
        isRumActive: false,
        isRumInstrumented: false,
        rumSamplingRate: null,
      }),
      sendCommand: sinon.stub().resolves(),
      setCookies: sinon.stub().resolves(),
    }
    const correlate = context => {
      rumStates.push(context.isRumActive)
      context.testExecutionId = 'retry-execution-id'
    }
    correlationCh.subscribe(correlate)

    try {
      channel('tracing:orchestrion:@wdio/utils:executeAsync:start').runStores(executeAsyncContext, () => {})
      await executeAsyncContext.rumCorrelationCallback([browser], 'initial-execution-id')
      await executeAsyncContext.retryCallback()

      assert.deepStrictEqual(rumStates, [false])
      assert.strictEqual(browser.execute.callCount, 1)
    } finally {
      correlationCh.unsubscribe(correlate)
      await executeAsyncContext.rumCleanupCallback()
    }
  })

  it('preserves Mocha RUM correlation across a native WebdriverIO retry', async () => {
    require('../src/webdriverio')

    const source = fs.readFileSync(utilsFixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, utilsFixtureModulePath, 'module')
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-webdriverio-utils-rewriter-'))
    const outputPath = path.join(outputDirectory, 'index.mjs')
    const correlationCh = channel('ci:webdriverio:rum:page-navigate')
    const urlCh = tracingChannel('orchestrion:webdriverio:url')
    const testFunctionCh = tracingChannel('orchestrion:@wdio/utils:testFrameworkFnWrapper')
    const calls = []
    let attempts = 0
    const browser = {
      capabilities: {},
      deleteCookies: sinon.stub().callsFake(() => {
        calls.push('delete')
        return Promise.resolve()
      }),
      execute: sinon.stub().callsFake((script) => Promise.resolve(script.name === 'detectRum'
        ? { isRumActive: true, isRumInstrumented: true, rumSamplingRate: 100 }
        : false)),
      sendCommand: sinon.stub().resolves(),
      setCookies: sinon.stub().callsFake(() => {
        calls.push('set')
        return Promise.resolve()
      }),
    }
    const correlate = context => {
      context.testExecutionId = 'mocha-attempt-id'
    }
    correlationCh.subscribe(correlate)

    try {
      const navigationContext = { self: browser }
      urlCh.asyncEnd.publish(navigationContext)
      await runCallback(navigationContext.resolveCallback)

      fs.writeFileSync(outputPath, rewrittenSource)
      const { executeAsync } = await import(pathToFileURL(outputPath))
      const result = await executeAsync(() => {
        attempts++
        calls.push(`attempt:${attempts}`)
        if (attempts === 1) throw new Error('retry me')
        return 'passed'
      }, { attempts: 0, limit: 1 })

      assert.strictEqual(result, 'passed')
      assert.deepStrictEqual(calls, [
        'set',
        'attempt:1',
        'set',
        'attempt:2',
      ])

      const afterEachContext = {
        arguments: [undefined, 'Hook', undefined, undefined, undefined, undefined, undefined, 'afterEach'],
      }
      testFunctionCh.asyncEnd.publish(afterEachContext)
      await runCallback(afterEachContext.resolveCallback)
    } finally {
      correlationCh.unsubscribe(correlate)
      await cleanupRumState()
    }
  })

  it('cleans RUM in every open browser window and restores the original window', async () => {
    require('../src/webdriverio')

    const correlationCh = channel('ci:webdriverio:rum:page-navigate')
    const urlCh = tracingChannel('orchestrion:webdriverio:url')
    const testFunctionCh = tracingChannel('orchestrion:@wdio/utils:testFrameworkFnWrapper')
    const calls = []
    const browser = {
      capabilities: {},
      deleteCookies: sinon.stub().callsFake(() => {
        calls.push('delete')
        return Promise.resolve()
      }),
      execute: sinon.stub()
        .onFirstCall().resolves({
          isRumActive: true,
          isRumInstrumented: true,
          rumSamplingRate: 100,
        })
        .onSecondCall().resolves(false)
        .onThirdCall().resolves(false),
      getWindowHandle: sinon.stub().resolves('window-a'),
      getWindowHandles: sinon.stub().resolves(['window-a', 'window-b']),
      sendCommand: sinon.stub().resolves(),
      setCookies: sinon.stub().resolves(),
      switchToWindow: sinon.stub().callsFake((windowHandle) => {
        calls.push(`switch:${windowHandle}`)
        return Promise.resolve()
      }),
    }
    const correlate = context => {
      context.testExecutionId = '1234'
    }
    correlationCh.subscribe(correlate)

    try {
      const navigationContext = { self: browser }
      urlCh.asyncEnd.publish(navigationContext)
      await runCallback(navigationContext.resolveCallback)

      const testContext = { arguments: [undefined, 'Test'] }
      testFunctionCh.asyncEnd.publish(testContext)
      await runCallback(testContext.resolveCallback)

      const afterEachContext = {
        arguments: [undefined, 'Hook', undefined, undefined, undefined, undefined, undefined, 'afterEach'],
      }
      testFunctionCh.asyncEnd.publish(afterEachContext)
      await runCallback(afterEachContext.resolveCallback)

      assert.deepStrictEqual(calls, [
        'switch:window-a',
        'switch:window-b',
        'switch:window-a',
        'switch:window-a',
        'delete',
        'switch:window-b',
        'delete',
        'switch:window-a',
      ])
    } finally {
      correlationCh.unsubscribe(correlate)
    }
  })

  it('waits for coordinator shutdown before preserving a LocalRunner.shutdown rejection', async () => {
    const source = fs.readFileSync(fixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, fixtureModulePath, 'module')
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-webdriverio-rewriter-'))
    const outputPath = path.join(outputDirectory, 'index.mjs')
    const shutdownCh = tracingChannel('orchestrion:@wdio/local-runner:LocalRunner_shutdown')
    const shutdownError = new Error('shutdown failed')
    const steps = []
    const subscriber = {
      asyncEnd (context) {
        steps.push('asyncEnd')
        context.rejectCallback = onDone => {
          setImmediate(() => {
            steps.push('coordinator')
            onDone()
          })
        }
      },
    }

    fs.writeFileSync(outputPath, rewrittenSource)
    shutdownCh.subscribe(subscriber)

    try {
      const { LocalRunner } = await import(pathToFileURL(outputPath))
      const resultPromise = new LocalRunner().shutdown(shutdownError)

      await Promise.resolve()

      assert.deepStrictEqual(steps, ['asyncEnd'])
      await assert.rejects(resultPromise, error => {
        steps.push('rejected')
        return error === shutdownError
      })
      assert.deepStrictEqual(steps, ['asyncEnd', 'coordinator', 'rejected'])
    } finally {
      shutdownCh.unsubscribe(subscriber)
    }
  })

  it('waits for worker completion before Runner._shutdown emits exit', async () => {
    const source = fs.readFileSync(runnerFixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, runnerFixtureModulePath, 'module')
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-webdriverio-runner-rewriter-'))
    const outputPath = path.join(outputDirectory, 'index.mjs')
    const reporterWaitForSyncCh = tracingChannel('orchestrion:@wdio/runner:BaseReporter_waitForSync')
    const steps = []
    const subscriber = {
      asyncEnd (context) {
        steps.push('asyncEnd')
        context.resolveCallback = onDone => {
          setImmediate(() => {
            steps.push('logs')
            onDone()
          })
        }
      },
    }

    fs.writeFileSync(outputPath, rewrittenSource)
    reporterWaitForSyncCh.subscribe(subscriber)

    try {
      const { Runner } = await import(pathToFileURL(outputPath))
      const runner = new Runner()
      runner.onEvent = (event, code) => steps.push(`${event}:${code}`)
      const resultPromise = runner._shutdown(0)

      await Promise.resolve()

      assert.deepStrictEqual(steps, ['asyncEnd'])
      assert.strictEqual(await resultPromise, 0)
      assert.deepStrictEqual(steps, ['asyncEnd', 'logs', 'exit:0'])
    } finally {
      reporterWaitForSyncCh.unsubscribe(subscriber)
    }
  })

  it('cleans RUM before Runner.run ends the browser session', async () => {
    const source = fs.readFileSync(runnerFixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, runnerFixtureModulePath, 'module')
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-webdriverio-runner-rum-rewriter-'))
    const outputPath = path.join(outputDirectory, 'index.mjs')
    const runCh = tracingChannel('orchestrion:@wdio/runner:Runner_run')
    const steps = []
    const subscriber = {
      start (context) {
        context.rumCleanupCallback = async function () {
          steps.push('cleanup:start')
          await new Promise(resolve => setImmediate(resolve))
          steps.push('cleanup:end')
        }
      },
    }

    fs.writeFileSync(outputPath, rewrittenSource)
    runCh.subscribe(subscriber)

    try {
      const { Runner } = await import(pathToFileURL(outputPath))
      const runner = new Runner()
      runner.onEvent = event => steps.push(event)

      assert.strictEqual(await runner.run({ watch: false }), 0)
      assert.deepStrictEqual(steps, ['cleanup:start', 'cleanup:end', 'session:end'])
    } finally {
      runCh.unsubscribe(subscriber)
    }
  })

  it('waits for coordinator readiness before resolving JasmineAdapter.init', async () => {
    const source = fs.readFileSync(jasmineFixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, jasmineFixtureModulePath, 'module')
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-webdriverio-jasmine-init-rewriter-'))
    const outputPath = path.join(outputDirectory, 'index.mjs')
    const initCh = tracingChannel('orchestrion:@wdio/jasmine-framework:JasmineAdapter_init')
    const steps = []
    const subscriber = {
      asyncEnd (context) {
        steps.push('asyncEnd')
        context.resolveCallback = onDone => {
          setImmediate(() => {
            steps.push('coordinator')
            onDone()
          })
        }
      },
    }

    fs.writeFileSync(outputPath, rewrittenSource)
    initCh.subscribe(subscriber)

    try {
      const { JasmineAdapter } = await import(pathToFileURL(outputPath))
      const adapter = new JasmineAdapter([])
      const resultPromise = adapter.init()

      await Promise.resolve()

      assert.deepStrictEqual(steps, ['asyncEnd'])
      assert.strictEqual(await resultPromise, adapter)
      assert.deepStrictEqual(steps, ['asyncEnd', 'coordinator'])
    } finally {
      initCh.unsubscribe(subscriber)
    }
  })

  it('waits for Jasmine worker reporting before preserving a JasmineAdapter.run rejection', async () => {
    const source = fs.readFileSync(jasmineFixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, jasmineFixtureModulePath, 'module')
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-webdriverio-jasmine-rewriter-'))
    const outputPath = path.join(outputDirectory, 'index.mjs')
    const runCh = tracingChannel('orchestrion:@wdio/jasmine-framework:JasmineAdapter_run')
    const runError = new Error('Jasmine run failed')
    const steps = []
    const subscriber = {
      asyncEnd (context) {
        steps.push('asyncEnd')
        context.rejectCallback = onDone => {
          setImmediate(() => {
            steps.push('worker')
            onDone()
          })
        }
      },
    }

    fs.writeFileSync(outputPath, rewrittenSource)
    runCh.subscribe(subscriber)

    try {
      const { JasmineAdapter } = await import(pathToFileURL(outputPath))
      const resultPromise = new JasmineAdapter([]).run(runError)

      await Promise.resolve()

      assert.deepStrictEqual(steps, ['asyncEnd'])
      await assert.rejects(resultPromise, error => {
        steps.push('rejected')
        return error === runError
      })
      assert.deepStrictEqual(steps, ['asyncEnd', 'worker', 'rejected'])
    } finally {
      runCh.unsubscribe(subscriber)
    }
  })

  it('propagates complete launcher NODE_OPTIONS to worker environments', () => {
    const testFinishCh = channel('ci:mocha:test:finish')
    const originalNodeOptions = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = '--require dd-trace/ci/init'

    function onTestFinish () {}

    testFinishCh.subscribe(onTestFinish)

    try {
      require('../src/webdriverio')

      const cases = [
        {
          runnerEnv: undefined,
          expectedNodeOptions: '--require dd-trace/ci/init',
        },
        {
          runnerEnv: { NODE_OPTIONS: '--require dd-trace/ci/init-custom' },
          expectedNodeOptions: '--require dd-trace/ci/init --require dd-trace/ci/init-custom',
        },
        {
          runnerEnv: { NODE_OPTIONS: '--no-warnings --require dd-trace/ci/init' },
          expectedNodeOptions: '--no-warnings --require dd-trace/ci/init',
        },
      ]

      for (const { runnerEnv, expectedNodeOptions } of cases) {
        const localRunner = {
          config: {
            framework: 'mocha',
            runnerEnv,
          },
        }
        const runContext = {
          self: localRunner,
          arguments: [{ specs: [] }],
        }

        tracingChannel('orchestrion:@wdio/local-runner:LocalRunner_run').start.publish(runContext)

        assert.deepStrictEqual(localRunner.config.runnerEnv, {
          NODE_OPTIONS: expectedNodeOptions,
          MOCHA_WORKER_ID: 'webdriverio',
          [WEBDRIVERIO_WORKER_ENV]: 'true',
        })
      }
    } finally {
      testFinishCh.unsubscribe(onTestFinish)
      if (originalNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS
      } else {
        process.env.NODE_OPTIONS = originalNodeOptions
      }
    }
  })

  it('does not send Mocha worker messages over disconnected IPC', async () => {
    await execFileAsync(process.execPath, [disconnectedWorkerFixturePath])
  })

  it('waits for worker payloads before completing Mocha', async () => {
    await execFileAsync(process.execPath, [delayedWorkerFixturePath])
  })

  it('does not track WebdriverIO hook failures in regular Mocha workers', async () => {
    await execFileAsync(process.execPath, [regularMochaWorkerFixturePath])
  })

  it('configures the Mocha worker plugin with the WebdriverIO framework', () => {
    const plugin = new MochaPlugin({ _exporter: {} }, { testOptimization: {} })
    const logError = sinon.stub(log, 'error')
    plugin.configure({ enabled: true })

    try {
      channel('ci:mocha:worker:configuration').publish({
        libraryConfig: {},
        repositoryRoot: process.cwd(),
        testFramework: 'webdriverio',
        testFrameworkAdapter: 'mocha',
      })

      assert.strictEqual(plugin.testFramework, 'webdriverio')
      assert.strictEqual(plugin.testFrameworkAdapter, 'mocha')

      const correlationContext = {}
      channel('ci:webdriverio:rum:page-navigate').publish(correlationContext)
      assert.strictEqual(correlationContext.isTestOptimizationRunner, true)
      assert.strictEqual(logError.calledWith('ci:webdriverio:rum:page-navigate: test span not found'), false)
    } finally {
      plugin.configure(false)
      logError.restore()
    }
  })

  it('allows the WebdriverIO screenshot IPC response to outlive the exporter upload deadline', () => {
    assert.strictEqual(SCREENSHOT_UPLOAD_TIMEOUT_MS, FINAL_FLUSH_TIMEOUT + 5000)
  })

  it('shares one response dispatcher across concurrent screenshot upload requests', () => {
    const originalConnected = process.connected
    const originalSend = process.send
    const initialDisconnectListeners = process.listenerCount('disconnect')
    const initialMessageListeners = process.listenerCount('message')
    const sentMessages = []
    const uploadCallbacks = Array.from({ length: 11 }, () => sinon.spy())
    process.connected = true
    process.send = (message, onDone) => {
      sentMessages.push(message)
      onDone()
    }

    try {
      for (const uploadCallback of uploadCallbacks) {
        requestWebdriverioScreenshotUpload({ screenshot: PNG_SCREENSHOT }, uploadCallback)
      }

      assert.strictEqual(process.listenerCount('message'), initialMessageListeners + 1)
      assert.strictEqual(process.listenerCount('disconnect'), initialDisconnectListeners + 1)
      assert.strictEqual(sentMessages.length, 11)

      for (const message of sentMessages) {
        process.emit('message', {
          name: SCREENSHOT_UPLOAD_RESPONSE,
          content: { requestId: message.args.content.requestId },
        })
      }

      for (const uploadCallback of uploadCallbacks) {
        sinon.assert.calledOnceWithExactly(uploadCallback, undefined)
      }
      assert.strictEqual(process.listenerCount('message'), initialMessageListeners)
      assert.strictEqual(process.listenerCount('disconnect'), initialDisconnectListeners)
    } finally {
      for (const message of sentMessages) {
        process.emit('message', {
          name: SCREENSHOT_UPLOAD_RESPONSE,
          content: { requestId: message.args.content.requestId },
        })
      }
      if (originalConnected === undefined) {
        delete process.connected
      } else {
        process.connected = originalConnected
      }
      if (originalSend === undefined) {
        delete process.send
      } else {
        process.send = originalSend
      }
    }
  })

  it('rejects malformed coordinator screenshot payloads before upload', () => {
    const exporter = {
      canUploadTestScreenshots: () => true,
      uploadTestScreenshot: sinon.spy(),
    }
    const plugin = new MochaPlugin({ _exporter: exporter }, { testOptimization: {} })
    const errors = []
    plugin.configure({ enabled: true })

    try {
      for (const screenshot of [
        `${PNG_SCREENSHOT}!!!`,
        Buffer.from('not a PNG').toString('base64'),
      ]) {
        channel('ci:webdriverio:screenshot:upload').publish({
          capturedAtMs: Date.now(),
          idempotencyKey: '123:webdriverio-failure-0.png',
          onDone: error => errors.push(error),
          screenshot,
          traceId: '123',
        })
      }

      sinon.assert.notCalled(exporter.uploadTestScreenshot)
      assert.strictEqual(errors.length, 2)
      assert.match(errors[0].message, /invalid Base64 screenshot data/)
      assert.match(errors[1].message, /invalid PNG screenshot data/)
    } finally {
      plugin.configure(false)
    }
  })

  it('releases failed tests and worker shutdown when screenshot capture times out', () => {
    const originalBrowser = globalThis.browser
    const clock = sinon.useFakeTimers()
    const workerFinished = sinon.spy()
    const exporter = {
      canUploadTestScreenshots: () => true,
      flush: sinon.spy(callback => callback()),
      uploadTestScreenshot: sinon.spy(),
    }
    globalThis.browser = {
      takeScreenshot: sinon.stub().returns({ then () {} }),
    }
    const { plugin, spans } = createJasminePlugin({ isTestFailureScreenshotsEnabled: true }, {
      exporter,
      testOptimization: { DD_TEST_FAILURE_SCREENSHOTS_ENABLED: true },
    })
    const file = path.join(process.cwd(), 'failure-screenshot-timeout.spec.js')
    const result = {
      ...createJasmineResult('failure screenshot timeout', file, 'failed'),
      failedExpectations: [{ message: 'expected failure' }],
    }

    try {
      reportJasmineSpecStarted(result, file)
      channel('tracing:orchestrion:jasmine-core:Spec_attemptDone:end').publish({
        result: 'failed',
        self: { id: result.id },
      })
      channel('tracing:orchestrion:@wdio/jasmine-framework:JasmineReporter_specDone:end').publish({
        arguments: [result],
        self: { _specs: [file] },
      })
      channel('ci:mocha:worker:finish').publish({ onDone: workerFinished })

      clock.tick(29_999)
      assert.strictEqual(spans[0].context()._isFinished, false)
      sinon.assert.notCalled(exporter.flush)
      sinon.assert.notCalled(workerFinished)

      clock.tick(1)
      assert.strictEqual(spans[0].context()._isFinished, true)
      assert.strictEqual(spans[0].context().getTags()[TEST_FAILURE_SCREENSHOT_UPLOADED], undefined)
      assert.strictEqual(spans[0].context().getTags()[TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR], 'true')
      sinon.assert.notCalled(exporter.uploadTestScreenshot)
      sinon.assert.calledOnce(exporter.flush)
      sinon.assert.calledOnce(workerFinished)
    } finally {
      plugin.configure(false)
      clock.restore()
      if (originalBrowser === undefined) {
        delete globalThis.browser
      } else {
        globalThis.browser = originalBrowser
      }
    }
  })

  it('waits for every WebdriverIO screenshot upload before finishing a failed Jasmine test', async () => {
    const originalBrowser = globalThis.browser
    const screenshot = PNG_SCREENSHOT
    const uploadCallbacks = []
    const exporter = {
      canUploadTestScreenshots: () => true,
      flush: sinon.spy(callback => callback()),
      uploadTestScreenshot: sinon.spy((options, callback) => uploadCallbacks.push(callback)),
    }
    globalThis.browser = {
      takeScreenshot: sinon.stub().resolves([screenshot, screenshot]),
    }
    const { plugin, spans } = createJasminePlugin({ isTestFailureScreenshotsEnabled: true }, {
      exporter,
      testOptimization: { DD_TEST_FAILURE_SCREENSHOTS_ENABLED: true },
    })
    const file = path.join(process.cwd(), 'failure-screenshot.spec.js')
    const result = {
      ...createJasmineResult('failure screenshot', file, 'failed'),
      failedExpectations: [{ message: 'expected failure' }],
    }

    try {
      reportJasmineSpecStarted(result, file)
      channel('tracing:orchestrion:jasmine-core:Spec_attemptDone:end').publish({
        result: 'failed',
        self: { id: result.id },
      })
      const finishContext = {
        arguments: [result],
        self: { _specs: [file] },
      }
      channel('tracing:orchestrion:@wdio/jasmine-framework:JasmineReporter_specDone:end').publish(finishContext)
      await Promise.resolve()
      await Promise.resolve()

      assert.strictEqual(finishContext.result, undefined)
      sinon.assert.calledOnce(globalThis.browser.takeScreenshot)
      sinon.assert.calledTwice(exporter.uploadTestScreenshot)
      assert.strictEqual(spans[0].context()._isFinished, false)
      for (const call of exporter.uploadTestScreenshot.getCalls()) {
        assert.deepStrictEqual(call.args[0].content, Buffer.from(PNG_SCREENSHOT, 'base64'))
        assert.strictEqual(call.args[0].traceId, spans[0].context().toTraceId())
      }

      const workerFinished = sinon.spy()
      channel('ci:mocha:worker:finish').publish({ onDone: workerFinished })
      sinon.assert.notCalled(exporter.flush)
      sinon.assert.notCalled(workerFinished)

      uploadCallbacks[0](null)
      assert.strictEqual(spans[0].context()._isFinished, false)
      uploadCallbacks[1](null)

      assert.strictEqual(spans[0].context()._isFinished, true)
      assert.strictEqual(spans[0].context().getTags()[TEST_FAILURE_SCREENSHOT_UPLOADED], 'true')
      assert.strictEqual(spans[0].context().getTags()[TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR], undefined)
      sinon.assert.calledOnce(exporter.flush)
      sinon.assert.calledOnce(workerFinished)
    } finally {
      plugin.configure(false)
      if (originalBrowser === undefined) {
        delete globalThis.browser
      } else {
        globalThis.browser = originalBrowser
      }
    }
  })

  it('prefers the registered WebdriverIO browser when global injection is disabled', async () => {
    const originalBrowser = globalThis.browser
    const originalWdioGlobals = globalThis._wdioGlobals
    const screenshot = PNG_SCREENSHOT
    const browser = {
      takeScreenshot: sinon.stub().resolves(screenshot),
    }
    const exporter = {
      canUploadTestScreenshots: () => true,
      uploadTestScreenshot: sinon.spy((_options, callback) => callback()),
    }
    globalThis.browser = {
      takeScreenshot: sinon.stub().rejects(new Error('not the WebdriverIO browser')),
    }
    globalThis._wdioGlobals = new Map([['browser', browser]])
    const { plugin, spans } = createJasminePlugin({ isTestFailureScreenshotsEnabled: true }, {
      exporter,
      testOptimization: { DD_TEST_FAILURE_SCREENSHOTS_ENABLED: true },
    })
    const file = path.join(process.cwd(), 'failure-screenshot-no-globals.spec.js')
    const result = {
      ...createJasmineResult('failure screenshot without globals', file, 'failed'),
      failedExpectations: [{ message: 'expected failure' }],
    }

    try {
      reportJasmineSpecStarted(result, file)
      channel('tracing:orchestrion:jasmine-core:Spec_attemptDone:end').publish({
        result: 'failed',
        self: { id: result.id },
      })
      channel('tracing:orchestrion:@wdio/jasmine-framework:JasmineReporter_specDone:end').publish({
        arguments: [result],
        self: { _specs: [file] },
      })
      await Promise.resolve()
      await Promise.resolve()

      sinon.assert.calledOnce(browser.takeScreenshot)
      sinon.assert.notCalled(globalThis.browser.takeScreenshot)
      sinon.assert.calledOnce(exporter.uploadTestScreenshot)
      assert.strictEqual(spans[0].context()._isFinished, true)
      assert.strictEqual(spans[0].context().getTags()[TEST_FAILURE_SCREENSHOT_UPLOADED], 'true')
    } finally {
      plugin.configure(false)
      globalThis._wdioGlobals = originalWdioGlobals
      if (originalBrowser === undefined) {
        delete globalThis.browser
      } else {
        globalThis.browser = originalBrowser
      }
    }
  })

  it('cleans up Failed Test Replay before a screenshot upload can overlap the next test', async () => {
    const originalBrowser = globalThis.browser
    const uploadCallbacks = []
    globalThis.browser = {
      takeScreenshot: sinon.stub().resolves(PNG_SCREENSHOT),
    }
    const exporter = {
      canUploadTestScreenshots: () => true,
      uploadTestScreenshot: (_options, callback) => uploadCallbacks.push(callback),
    }
    const { plugin } = createJasminePlugin({
      isDiEnabled: true,
      isTestFailureScreenshotsEnabled: true,
    }, {
      exporter,
      testOptimization: { DD_TEST_FAILURE_SCREENSHOTS_ENABLED: true },
    })
    const file = path.join(process.cwd(), 'failure-screenshot-replay-cleanup.spec.js')
    const result = {
      ...createJasmineResult('failure screenshot replay cleanup', file, 'failed'),
      failedExpectations: [{ message: 'expected failure' }],
    }
    const firstProbe = { file, line: 1 }
    const secondProbe = { file, line: 2 }
    plugin.di = {}
    plugin.runningTestProbe = firstProbe
    const cancelDiBreakpointHitWait = sinon.stub(plugin, 'cancelDiBreakpointHitWait')
    const removeDiProbe = sinon.stub(plugin, 'removeDiProbe')

    try {
      reportJasmineSpecStarted(result, file)
      channel('tracing:orchestrion:jasmine-core:Spec_attemptDone:end').publish({
        result: 'failed',
        self: { id: result.id },
      })
      channel('tracing:orchestrion:@wdio/jasmine-framework:JasmineReporter_specDone:end').publish({
        arguments: [result],
        self: { _specs: [file] },
      })

      sinon.assert.calledOnce(cancelDiBreakpointHitWait)
      sinon.assert.calledOnceWithExactly(removeDiProbe, firstProbe)
      assert.strictEqual(plugin.runningTestProbe, null)

      plugin.runningTestProbe = secondProbe
      await Promise.resolve()
      uploadCallbacks[0]()

      sinon.assert.calledOnce(cancelDiBreakpointHitWait)
      sinon.assert.calledOnce(removeDiProbe)
      assert.strictEqual(plugin.runningTestProbe, secondProbe)
    } finally {
      plugin.configure(false)
      if (originalBrowser === undefined) {
        delete globalThis.browser
      } else {
        globalThis.browser = originalBrowser
      }
    }
  })

  it('tags a failed Jasmine test when its WebdriverIO screenshot upload fails', async () => {
    const originalBrowser = globalThis.browser
    const exporter = {
      canUploadTestScreenshots: () => true,
      uploadTestScreenshot: sinon.spy((_options, callback) => callback(new Error('upload failed'))),
    }
    globalThis.browser = {
      takeScreenshot: sinon.stub().resolves(PNG_SCREENSHOT),
    }
    const { plugin, spans } = createJasminePlugin({ isTestFailureScreenshotsEnabled: true }, {
      exporter,
      testOptimization: { DD_TEST_FAILURE_SCREENSHOTS_ENABLED: true },
    })
    const file = path.join(process.cwd(), 'failure-screenshot-error.spec.js')
    const result = {
      ...createJasmineResult('failure screenshot error', file, 'failed'),
      failedExpectations: [{ message: 'expected failure' }],
    }

    try {
      reportJasmineSpecStarted(result, file)
      channel('tracing:orchestrion:jasmine-core:Spec_attemptDone:end').publish({
        result: 'failed',
        self: { id: result.id },
      })
      const finishContext = {
        arguments: [result],
        self: { _specs: [file] },
      }
      channel('tracing:orchestrion:@wdio/jasmine-framework:JasmineReporter_specDone:end').publish(finishContext)
      await finishContext.result

      sinon.assert.calledOnce(exporter.uploadTestScreenshot)
      assert.strictEqual(spans[0].context()._isFinished, true)
      assert.strictEqual(spans[0].context().getTags()[TEST_FAILURE_SCREENSHOT_UPLOADED], undefined)
      assert.strictEqual(spans[0].context().getTags()[TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR], 'true')
    } finally {
      plugin.configure(false)
      if (originalBrowser === undefined) {
        delete globalThis.browser
      } else {
        globalThis.browser = originalBrowser
      }
    }
  })

  it('tags malformed WebdriverIO screenshot data as an upload error', async () => {
    const originalBrowser = globalThis.browser
    const exporter = {
      canUploadTestScreenshots: () => true,
      uploadTestScreenshot: sinon.spy(),
    }
    globalThis.browser = {
      takeScreenshot: sinon.stub().resolves(`${PNG_SCREENSHOT}!!!`),
    }
    const { plugin, spans } = createJasminePlugin({ isTestFailureScreenshotsEnabled: true }, {
      exporter,
      testOptimization: { DD_TEST_FAILURE_SCREENSHOTS_ENABLED: true },
    })
    const file = path.join(process.cwd(), 'failure-screenshot-invalid-data.spec.js')
    const result = {
      ...createJasmineResult('failure screenshot invalid data', file, 'failed'),
      failedExpectations: [{ message: 'expected failure' }],
    }

    try {
      reportJasmineSpecStarted(result, file)
      channel('tracing:orchestrion:jasmine-core:Spec_attemptDone:end').publish({
        result: 'failed',
        self: { id: result.id },
      })
      channel('tracing:orchestrion:@wdio/jasmine-framework:JasmineReporter_specDone:end').publish({
        arguments: [result],
        self: { _specs: [file] },
      })
      await Promise.resolve()
      await Promise.resolve()

      sinon.assert.notCalled(exporter.uploadTestScreenshot)
      assert.strictEqual(spans[0].context()._isFinished, true)
      assert.strictEqual(spans[0].context().getTags()[TEST_FAILURE_SCREENSHOT_UPLOADED], undefined)
      assert.strictEqual(spans[0].context().getTags()[TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR], 'true')
    } finally {
      plugin.configure(false)
      if (originalBrowser === undefined) {
        delete globalThis.browser
      } else {
        globalThis.browser = originalBrowser
      }
    }
  })

  it('falls back to ATR when the Jasmine EFD retry policy has no retries', () => {
    const { plugin } = createJasminePlugin({
      earlyFlakeDetectionRetryPolicy: createEfdRetryPolicy(),
      flakyTestRetriesCount: 1,
      isEarlyFlakeDetectionEnabled: true,
      isFlakyTestRetriesEnabled: true,
      isKnownTestsEnabled: true,
      knownTests: { mocha: {} },
    })
    const file = path.join(process.cwd(), 'zero-efd-retries.spec.js')
    const result = createJasmineResult('zero EFD retries', file, 'failed')

    try {
      reportJasmineSpecStarted(result, file)

      const test = plugin._webdriverioJasmineState.tests.get(result.id)
      assert.strictEqual(test.isEarlyFlakeDetection, false)
      assert.strictEqual(test.isAtr, true)
      assert.strictEqual(test.retryCount, 1)
    } finally {
      plugin.configure(false)
    }
  })

  it('uses repository-relative paths for impacted Jasmine tests', () => {
    const sourceRoot = path.join(process.cwd(), 'packages', 'browser-tests')
    const file = path.join(sourceRoot, 'impacted.spec.js')
    const { plugin } = createJasminePlugin({
      isImpactedTestsEnabled: true,
      modifiedFiles: {
        'packages/browser-tests/impacted.spec.js': [1],
      },
    })
    const result = createJasmineResult('impacted test', file, 'passed')

    try {
      plugin.sourceRoot = sourceRoot
      reportJasmineSpecStarted(result, file)

      const test = plugin._webdriverioJasmineState.tests.get(result.id)
      assert.strictEqual(test.isModified, true)
    } finally {
      plugin.configure(false)
    }
  })

  it('starts managed Jasmine retry spans after retry setup settles', async () => {
    const retryCh = channel('ci:mocha:test:retry')
    const { plugin, spans } = createJasminePlugin({
      flakyTestRetriesCount: 1,
      isFlakyTestRetriesEnabled: true,
    })
    const file = path.join(process.cwd(), 'managed-retry.spec.js')
    const result = createJasmineResult('managed-retry', file, 'failed')
    let finishRetrySetup
    const retrySetup = new Promise(resolve => {
      finishRetrySetup = resolve
    })
    const onRetry = ({ promises }) => {
      promises.setProbePromise = retrySetup
    }
    const onComplete = sinon.spy()
    const spec = {
      execute: sinon.spy(),
      id: result.id,
      queueableFn: { fn () {} },
      reset: sinon.spy(),
    }
    const executeContext = {
      arguments: [() => {}, onComplete, true, {}],
      self: spec,
    }

    retryCh.subscribe(onRetry)
    try {
      reportJasmineSpecStarted(result, file)
      channel('tracing:orchestrion:jasmine-core:Spec_execute:start').runStores(executeContext, () => {})

      const attemptContext = { result: 'failed', self: spec }
      channel('tracing:orchestrion:jasmine-core:Spec_attemptDone:end').publish(attemptContext)
      assert.strictEqual(attemptContext.result, 'passed')

      channel('tracing:orchestrion:@wdio/jasmine-framework:JasmineReporter_specDone:end').publish({
        arguments: [{
          ...result,
          failedExpectations: [{ message: 'managed retry failure' }],
        }],
        self: { _specs: [file] },
      })
      executeContext.arguments[1]()

      assert.strictEqual(spans.length, 1)
      assert.strictEqual(spec.execute.callCount, 0)

      finishRetrySetup()
      await retrySetup
      await Promise.resolve()

      assert.strictEqual(spans.length, 2)
      assert.strictEqual(spec.execute.callCount, 1)
      assert.strictEqual(onComplete.callCount, 0)
    } finally {
      retryCh.unsubscribe(onRetry)
      plugin.configure(false)
    }
  })

  it('starts managed Jasmine retries while screenshot uploads are pending', async () => {
    const originalBrowser = globalThis.browser
    const uploadCallbacks = []
    globalThis.browser = {
      takeScreenshot: sinon.stub().resolves(PNG_SCREENSHOT),
    }
    const exporter = {
      canUploadTestScreenshots: () => true,
      uploadTestScreenshot: (_options, callback) => uploadCallbacks.push(callback),
    }
    const { plugin, spans } = createJasminePlugin({
      flakyTestRetriesCount: 1,
      isFlakyTestRetriesEnabled: true,
      isTestFailureScreenshotsEnabled: true,
    }, {
      exporter,
      testOptimization: { DD_TEST_FAILURE_SCREENSHOTS_ENABLED: true },
    })
    const file = path.join(process.cwd(), 'retry-with-screenshot-upload.spec.js')
    const result = createJasmineResult('retry with screenshot upload', file, 'failed')
    const onComplete = sinon.spy()
    const spec = {
      execute: sinon.spy(),
      id: result.id,
      queueableFn: { fn () {} },
      reset: sinon.spy(),
    }
    const executeContext = {
      arguments: [() => {}, onComplete, true, {}],
      self: spec,
    }

    try {
      reportJasmineSpecStarted(result, file)
      channel('tracing:orchestrion:jasmine-core:Spec_execute:start').runStores(executeContext, () => {})

      const attemptContext = { result: 'failed', self: spec }
      channel('tracing:orchestrion:jasmine-core:Spec_attemptDone:end').publish(attemptContext)
      channel('tracing:orchestrion:@wdio/jasmine-framework:JasmineReporter_specDone:end').publish({
        arguments: [{
          ...result,
          failedExpectations: [{ message: 'managed retry failure' }],
        }],
        self: { _specs: [file] },
      })
      await Promise.resolve()
      executeContext.arguments[1]()

      assert.strictEqual(uploadCallbacks.length, 1)
      assert.strictEqual(spans.length, 2)
      assert.strictEqual(spec.execute.callCount, 1)
      assert.strictEqual(spans[0].context()._isFinished, false)

      uploadCallbacks[0]()

      assert.strictEqual(spans[0].context()._isFinished, true)
      assert.strictEqual(plugin.activeTestSpan, spans[1])
      sinon.assert.notCalled(onComplete)
    } finally {
      plugin.configure(false)
      if (originalBrowser === undefined) {
        delete globalThis.browser
      } else {
        globalThis.browser = originalBrowser
      }
    }
  })

  it('finishes Failed Test Replay before the next Jasmine spec starts', async () => {
    const source = fs.readFileSync(jasmineFixturePath, 'utf8')
    const rewrittenSource = rewriter.rewrite(source, jasmineFixtureModulePath, 'module')
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-webdriverio-jasmine-reporter-'))
    const outputPath = path.join(outputDirectory, 'index.mjs')
    const { plugin, spans } = createJasminePlugin({})
    const file = path.join(process.cwd(), 'failed-test-replay.spec.js')
    const firstResult = createJasmineResult('captures a replay', file, 'failed')
    const secondResult = createJasmineResult('runs after the replay', file, 'passed')
    let finishReplay
    const replayFinished = new Promise(resolve => {
      finishReplay = resolve
    })

    sinon.stub(plugin, 'waitForDiBreakpointHits').returns(replayFinished)
    fs.writeFileSync(outputPath, rewrittenSource)

    try {
      const { JasmineReporter } = await import(pathToFileURL(outputPath))
      const reporter = new JasmineReporter([file])
      reportJasmineSpecStarted(firstResult, file)
      plugin._webdriverioJasmineState.tests.get(firstResult.id)._ddShouldWaitForHitProbe = true

      const reportFirstSpec = Promise.resolve(reporter.specDone(firstResult)).then(() => {
        reportJasmineSpecStarted(secondResult, file)
      })
      await Promise.resolve()

      assert.strictEqual(spans.length, 1)

      finishReplay()
      await reportFirstSpec

      assert.strictEqual(spans.length, 2)
      assert.strictEqual(plugin.activeTestSpan, spans[1])
    } finally {
      plugin.configure(false)
    }
  })

  it('installs Failed Test Replay on the first Jasmine failure after a passing attempt', () => {
    const { plugin } = createJasminePlugin({
      earlyFlakeDetectionRetryPolicy: createEfdRetryPolicy({ '5s': 2 }),
      isDiEnabled: true,
      isEarlyFlakeDetectionEnabled: true,
      isKnownTestsEnabled: true,
      knownTests: { mocha: {} },
    })
    const file = path.join(process.cwd(), 'delayed-failure.spec.js')
    const result = createJasmineResult('delayed failure', file, 'failed')
    result.failedExpectations = [{ message: 'delayed failure' }]
    const addDiProbe = sinon.stub(plugin, 'addDiProbe').returns({
      file,
      line: 1,
      setProbePromise: Promise.resolve(),
      stackIndex: 0,
    })
    sinon.stub(plugin, 'prepareDiBreakpointHitWait')
    plugin.di = {}

    try {
      reportJasmineSpecStarted(result, file)
      const test = plugin._webdriverioJasmineState.tests.get(result.id)
      test.attempt = 1
      test.statuses.push('pass')
      test.willRetry = true

      channel('tracing:orchestrion:@wdio/jasmine-framework:JasmineReporter_specDone:end').publish({
        arguments: [result],
        self: { _specs: [file] },
      })

      assert.strictEqual(addDiProbe.callCount, 1)
      assert.strictEqual(test.hasFailedAttempt, true)
    } finally {
      plugin.configure(false)
    }
  })

  it('starts native WebdriverIO retry spans without stopping the active RUM session', async () => {
    const retryCh = channel('ci:mocha:test:retry')
    const { plugin, spans } = createJasminePlugin({})
    const file = path.join(process.cwd(), 'native-retry.spec.js')
    const result = createJasmineResult('native-retry', file, 'failed')
    const retries = { attempts: 0, limit: 1 }
    const correlations = []
    let finishRetrySetup
    const retrySetup = new Promise(resolve => {
      finishRetrySetup = resolve
    })
    const onRetry = ({ promises }) => {
      promises.setProbePromise = retrySetup
    }

    retryCh.subscribe(onRetry)
    try {
      reportJasmineSpecStarted(result, file)
      const wrapperContext = {
        arguments: [undefined, 'Test', { specFn () {} }, undefined, undefined, undefined, 1],
      }
      const executeAsyncContext = { arguments: [undefined, retries] }
      channel('tracing:orchestrion:@wdio/utils:testFrameworkFnWrapper:start').runStores(wrapperContext, () => {
        channel('tracing:orchestrion:@wdio/utils:executeAsync:start').runStores(executeAsyncContext, () => {})
      })
      executeAsyncContext.rumCleanupCallback = async function () {
        await Promise.resolve()
        assert.fail('active RUM session was stopped before a native retry')
      }
      executeAsyncContext.rumRetryCallback = async function (testExecutionId) {
        correlations.push({ spanCount: spans.length, testExecutionId })
        await Promise.resolve()
        return {
          browserName: 'chrome',
          browserVersion: '123',
          isRumActive: true,
        }
      }

      const retryPromise = executeAsyncContext.retryCallback(new Error('native retry failure'))
      assert.strictEqual(spans.length, 1)

      finishRetrySetup()
      await retryPromise

      assert.strictEqual(spans.length, 2)
      assert.deepStrictEqual(correlations, [{
        spanCount: 2,
        testExecutionId: '2',
      }])
      assert.strictEqual(spans[1].context().getTag(TEST_IS_RUM_ACTIVE), 'true')
      assert.strictEqual(spans[1].context().getTag(TEST_BROWSER_NAME), 'chrome')
      assert.strictEqual(spans[1].context().getTag(TEST_BROWSER_VERSION), '123')

      retryCh.unsubscribe(onRetry)
      await executeAsyncContext.retryCallback(new Error('immediate native retry failure'))
      assert.strictEqual(spans.length, 3)
      assert.deepStrictEqual(correlations[1], {
        spanCount: 3,
        testExecutionId: '3',
      })
      assert.strictEqual(spans[2].context().getTag(TEST_IS_RUM_ACTIVE), 'true')
      assert.strictEqual(spans[2].context().getTag(TEST_BROWSER_NAME), 'chrome')
      assert.strictEqual(spans[2].context().getTag(TEST_BROWSER_VERSION), '123')
    } finally {
      retryCh.unsubscribe(onRetry)
      plugin.configure(false)
    }
  })

  it('does not mark a native WebdriverIO retry RUM-active without an active RUM browser', async () => {
    const { plugin, spans } = createJasminePlugin({})
    const file = path.join(process.cwd(), 'native-retry-without-rum.spec.js')
    const result = createJasmineResult('native-retry-without-rum', file, 'failed')
    const retries = { attempts: 0, limit: 1 }

    try {
      reportJasmineSpecStarted(result, file)
      const wrapperContext = {
        arguments: [undefined, 'Test', { specFn () {} }, undefined, undefined, undefined, 1],
      }
      const executeAsyncContext = { arguments: [undefined, retries] }
      channel('tracing:orchestrion:@wdio/utils:testFrameworkFnWrapper:start').runStores(wrapperContext, () => {
        channel('tracing:orchestrion:@wdio/utils:executeAsync:start').runStores(executeAsyncContext, () => {})
      })
      const retryRumBrowsers = sinon.stub().resolves({ isRumActive: false })
      executeAsyncContext.rumRetryCallback = retryRumBrowsers

      await executeAsyncContext.retryCallback(new Error('native retry without RUM'))

      assert.strictEqual(spans.length, 2)
      assert.deepStrictEqual(retryRumBrowsers.firstCall.args, ['2'])
      assert.strictEqual(spans[1].context().getTag(TEST_IS_RUM_ACTIVE), undefined)
    } finally {
      plugin.configure(false)
    }
  })

  it('does not apply ATR to Jasmine hook failures', () => {
    const { plugin, spans } = createJasminePlugin({
      flakyTestRetriesCount: 1,
      isFlakyTestRetriesEnabled: true,
    })
    const file = path.join(process.cwd(), 'hook-failure.spec.js')
    const result = createJasmineResult('hook-failure', file, 'failed')
    const spec = { id: result.id }

    try {
      reportJasmineSpecStarted(result, file)
      const wrapperContext = {
        arguments: [undefined, 'Hook', { specFn () {} }, undefined, undefined, undefined, 1],
      }
      channel('tracing:orchestrion:@wdio/utils:testFrameworkFnWrapper:start').runStores(wrapperContext, () => {
        channel('tracing:orchestrion:@wdio/utils:executeAsync:error').publish({})
      })

      const attemptContext = { result: 'failed', self: spec }
      channel('tracing:orchestrion:jasmine-core:Spec_attemptDone:end').publish(attemptContext)
      channel('tracing:orchestrion:@wdio/jasmine-framework:JasmineReporter_specDone:end').publish({
        arguments: [result],
        self: { _specs: [file] },
      })

      assert.strictEqual(attemptContext.result, 'failed')
      assert.strictEqual(spans.length, 1)
      assert.strictEqual(plugin._webdriverioJasmineState.tests.size, 0)
    } finally {
      plugin.configure(false)
    }
  })

  it('does not apply ATR to expectation-based Jasmine hook failures', () => {
    const { plugin, spans } = createJasminePlugin({
      flakyTestRetriesCount: 1,
      isFlakyTestRetriesEnabled: true,
    })
    const file = path.join(process.cwd(), 'expectation-hook-failure.spec.js')
    const result = createJasmineResult('expectation-hook-failure', file, 'failed')
    result.failedExpectations = []
    const spec = { id: result.id }

    try {
      reportJasmineSpecStarted(result, file)
      const wrapperContext = {
        arguments: [undefined, 'Hook', { specFn () {} }, undefined, undefined, undefined, 1],
      }
      channel('tracing:orchestrion:@wdio/utils:testFrameworkFnWrapper:start').runStores(wrapperContext, () => {
        channel('tracing:orchestrion:@wdio/utils:executeAsync:start').runStores({
          arguments: [undefined, { attempts: 0, limit: 0 }],
        }, () => {
          result.failedExpectations.push({ message: 'hook expectation failed' })
          channel('tracing:orchestrion:@wdio/utils:executeAsync:asyncEnd').publish({})
        })
      })

      const attemptContext = { result: 'failed', self: spec }
      channel('tracing:orchestrion:jasmine-core:Spec_attemptDone:end').publish(attemptContext)
      channel('tracing:orchestrion:@wdio/jasmine-framework:JasmineReporter_specDone:end').publish({
        arguments: [result],
        self: { _specs: [file] },
      })

      assert.strictEqual(attemptContext.result, 'failed')
      assert.strictEqual(spans.length, 1)
      assert.strictEqual(plugin._webdriverioJasmineState.tests.size, 0)
    } finally {
      plugin.configure(false)
    }
  })

  it('does not mistake test-body expectations for Jasmine hook failures', () => {
    const { plugin } = createJasminePlugin({
      flakyTestRetriesCount: 1,
      isFlakyTestRetriesEnabled: true,
    })
    const file = path.join(process.cwd(), 'test-expectation-failure.spec.js')
    const result = createJasmineResult('test-expectation-failure', file, 'failed')
    result.failedExpectations = []
    const spec = { id: result.id }

    try {
      reportJasmineSpecStarted(result, file)
      result.failedExpectations.push({ message: 'test expectation failed' })
      const wrapperContext = {
        arguments: [undefined, 'Hook', { specFn () {} }, undefined, undefined, undefined, 1],
      }
      channel('tracing:orchestrion:@wdio/utils:testFrameworkFnWrapper:start').runStores(wrapperContext, () => {
        channel('tracing:orchestrion:@wdio/utils:executeAsync:start').runStores({
          arguments: [undefined, { attempts: 0, limit: 0 }],
        }, () => {
          channel('tracing:orchestrion:@wdio/utils:executeAsync:asyncEnd').publish({})
        })
      })

      const attemptContext = { result: 'failed', self: spec }
      channel('tracing:orchestrion:jasmine-core:Spec_attemptDone:end').publish(attemptContext)

      assert.strictEqual(attemptContext.result, 'passed')
      assert.strictEqual(plugin._webdriverioJasmineState.tests.get(result.id).hasFinalHookFailure, false)
    } finally {
      plugin.configure(false)
    }
  })

  it('releases completed Jasmine test records while preserving their terminal status', () => {
    const { plugin, spans } = createJasminePlugin({})
    const file = path.join(process.cwd(), 'completed.spec.js')
    const result = createJasmineResult('completed', file, 'passed')
    const spec = { id: result.id }

    try {
      reportJasmineSpecStarted(result, file)

      const attemptContext = { result: 'passed', self: spec }
      channel('tracing:orchestrion:jasmine-core:Spec_attemptDone:end').publish(attemptContext)
      channel('tracing:orchestrion:@wdio/jasmine-framework:JasmineReporter_specDone:end').publish({
        arguments: [result],
        self: { _specs: [file] },
      })

      assert.strictEqual(plugin._webdriverioJasmineState.tests.size, 0)
      assert.deepStrictEqual([...plugin._webdriverioJasmineState.completedTestStatuses], [[result.id, 'passed']])

      const lateAttemptContext = { result: 'failed', self: spec }
      channel('tracing:orchestrion:jasmine-core:Spec_attemptDone:end').publish(lateAttemptContext)
      reportJasmineSpecStarted(result, file)

      assert.strictEqual(lateAttemptContext.result, 'passed')
      assert.strictEqual(spans.length, 1)
    } finally {
      plugin.configure(false)
    }
  })

  it('keeps skipped Jasmine EFD tests skipped', () => {
    const { plugin, spans } = createJasminePlugin({
      earlyFlakeDetectionRetryPolicy: createEfdRetryPolicy({ '5s': 2 }),
      isEarlyFlakeDetectionEnabled: true,
      isKnownTestsEnabled: true,
      knownTests: { mocha: {} },
    })
    const file = path.join(process.cwd(), 'skipped-efd.spec.js')
    const result = createJasmineResult('skipped-efd', file, 'excluded')
    const spec = { id: result.id }

    try {
      reportJasmineSpecStarted(result, file)

      const attemptContext = { result: 'excluded', self: spec }
      channel('tracing:orchestrion:jasmine-core:Spec_attemptDone:end').publish(attemptContext)
      channel('tracing:orchestrion:@wdio/jasmine-framework:JasmineReporter_specDone:end').publish({
        arguments: [result],
        self: { _specs: [file] },
      })

      assert.strictEqual(attemptContext.result, 'excluded')
      assert.strictEqual(spans.length, 1)
      assert.strictEqual(plugin._webdriverioJasmineState.suiteStatuses.get(file), 'skip')
    } finally {
      plugin.configure(false)
    }
  })

  it('keeps skipped Jasmine attempt-to-fix tests skipped', () => {
    const file = path.join(process.cwd(), 'skipped-attempt-to-fix.spec.js')
    const testName = 'skipped attempt to fix'
    const testFinishes = []
    const testFinishCh = channel('ci:mocha:test:finish')
    const { plugin, spans } = createJasminePlugin({
      isTestManagementTestsEnabled: true,
      testManagementAttemptToFixRetries: 2,
      testManagementTests: {
        mocha: {
          suites: {
            'skipped-attempt-to-fix.spec.js': {
              tests: {
                [testName]: { properties: { attempt_to_fix: true } },
              },
            },
          },
        },
      },
    })
    const result = createJasmineResult(testName, file, 'excluded')
    const spec = { id: result.id }
    const onTestFinish = context => testFinishes.push(context)

    testFinishCh.subscribe(onTestFinish)
    try {
      reportJasmineSpecStarted(result, file)

      const attemptContext = { result: 'excluded', self: spec }
      channel('tracing:orchestrion:jasmine-core:Spec_attemptDone:end').publish(attemptContext)
      channel('tracing:orchestrion:@wdio/jasmine-framework:JasmineReporter_specDone:end').publish({
        arguments: [result],
        self: { _specs: [file] },
      })

      assert.strictEqual(attemptContext.result, 'excluded')
      assert.strictEqual(spans.length, 1)
      assert.strictEqual(plugin._webdriverioJasmineState.suiteStatuses.get(file), 'skip')
      assert.strictEqual(testFinishes.length, 1)
      assert.strictEqual(testFinishes[0].status, 'skip')
      assert.strictEqual(testFinishes[0].finalStatus, 'skip')
      assert.strictEqual(testFinishes[0].attemptToFixPassed, false)
      assert.strictEqual(testFinishes[0].attemptToFixFailed, false)
    } finally {
      testFinishCh.unsubscribe(onTestFinish)
      plugin.configure(false)
    }
  })

  it('marks disabled Jasmine specs pending before their hooks are queued', () => {
    const file = path.join(process.cwd(), 'disabled-hook.spec.js')
    const testName = 'disabled hook'
    const { plugin } = createJasminePlugin({
      isTestManagementTestsEnabled: true,
      testManagementTests: {
        mocha: {
          suites: {
            'disabled-hook.spec.js': {
              tests: {
                [testName]: { properties: { disabled: true } },
              },
            },
          },
        },
      },
    })
    const result = createJasmineResult(testName, file, 'pending')
    const spec = {
      id: result.id,
      pend: sinon.spy(),
      queueableFn: { fn () {} },
      result,
    }
    const executeContext = {
      arguments: [() => {}, () => {}, false, {}],
      self: spec,
    }

    try {
      channel('tracing:orchestrion:jasmine-core:Spec_execute:start').runStores(executeContext, () => {})

      assert.strictEqual(spec.pend.callCount, 1)
      assert.strictEqual(spec.pend.firstCall.args[0], 'Skipped by Datadog Test Management')
    } finally {
      plugin.configure(false)
    }
  })

  it('keeps Jasmine suite results reported before configuration completes', async () => {
    const testFinishCh = channel('ci:mocha:test:finish')
    const knownTestsCh = channel('ci:mocha:known-tests')
    const libraryConfigurationCh = channel('ci:mocha:library-configuration')
    const modifiedFilesCh = channel('ci:mocha:modified-files')
    const testManagementTestsCh = channel('ci:mocha:test-management-tests')
    const testSessionStartCh = channel('ci:mocha:session:start')
    const testSessionFinishCh = channel('ci:mocha:session:finish')
    const testSuiteErrorCh = channel('ci:mocha:test-suite:error')
    const testSuiteStartCh = channel('ci:mocha:test-suite:start')
    const testSuiteFinishCh = channel('ci:mocha:test-suite:finish')
    const sessionStarts = []
    const sessionFinishes = []
    const suiteErrors = []
    const suiteStarts = []
    const suiteFinishes = []
    let advancedFeatureRequests = 0
    let configurationRequests = 0
    let finishConfiguration

    function onTestFinish () {}
    function onAdvancedFeatureRequest () {
      advancedFeatureRequests++
    }
    function onLibraryConfiguration (request) {
      configurationRequests++
      assert.strictEqual(request.basicReportingOnly, undefined)
      assert.strictEqual(request.disableTestImpactAnalysis, true)
      assert.strictEqual(request.testFramework, 'webdriverio')
      finishConfiguration = () => request.onDone({
        libraryConfig: {},
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
    function onSuiteError (event) {
      suiteErrors.push(event.error)
    }
    function onSuiteStart (event) {
      suiteStarts.push(event)
    }
    function onSuiteFinish (event) {
      suiteFinishes.push(event)
    }

    testFinishCh.subscribe(onTestFinish)
    knownTestsCh.subscribe(onAdvancedFeatureRequest)
    libraryConfigurationCh.subscribe(onLibraryConfiguration)
    modifiedFilesCh.subscribe(onAdvancedFeatureRequest)
    testManagementTestsCh.subscribe(onAdvancedFeatureRequest)
    testSessionStartCh.subscribe(onSessionStart)
    testSessionFinishCh.subscribe(onSessionFinish)
    testSuiteErrorCh.subscribe(onSuiteError)
    testSuiteStartCh.subscribe(onSuiteStart)
    testSuiteFinishCh.subscribe(onSuiteFinish)

    try {
      require('../src/webdriverio')

      const localRunner = {
        config: {
          framework: 'jasmine',
          rootDir: process.cwd(),
        },
      }
      const failedFile = path.join(process.cwd(), 'jasmine-failed.spec.js')
      const passedFile = path.join(process.cwd(), 'jasmine-passed.spec.js')
      const worker = createWorker()

      registerWorker(localRunner, worker, [failedFile, passedFile])
      worker.emit('message', {
        name: WORKER_READY,
        content: { testFrameworkAdapter: 'jasmine' },
      })

      reportSuiteFinish(worker, failedFile, 'fail', {
        message: 'expected Jasmine suite failure',
        stack: 'Error: expected Jasmine suite failure',
      })
      reportSuiteFinish(worker, passedFile)
      assert.ok(finishConfiguration)
      finishConfiguration()
      await new Promise(setImmediate)

      worker.emit('exit', { exitCode: 1, retries: 0 })
      await finishLocalRunner(localRunner)

      assert.strictEqual(configurationRequests, 1)
      assert.strictEqual(advancedFeatureRequests, 0)
      assert.strictEqual(sessionStarts.length, 1)
      assert.strictEqual(sessionStarts[0].testFramework, 'webdriverio')
      assert.strictEqual(sessionStarts[0].testFrameworkAdapter, 'jasmine')
      assert.strictEqual(sessionFinishes.length, 1)
      assert.strictEqual(sessionFinishes[0].status, 'fail')
      assert.strictEqual(suiteErrors.length, 1)
      assert.strictEqual(suiteErrors[0].message, 'expected Jasmine suite failure')
      assert.strictEqual(suiteErrors[0].stack, 'Error: expected Jasmine suite failure')
      assert.deepStrictEqual(suiteStarts.map(event => event.testSuiteAbsolutePath), [failedFile, passedFile])
      assert.deepStrictEqual(suiteFinishes.map(event => event.status), ['fail', 'pass'])
    } finally {
      testFinishCh.unsubscribe(onTestFinish)
      knownTestsCh.unsubscribe(onAdvancedFeatureRequest)
      libraryConfigurationCh.unsubscribe(onLibraryConfiguration)
      modifiedFilesCh.unsubscribe(onAdvancedFeatureRequest)
      testManagementTestsCh.unsubscribe(onAdvancedFeatureRequest)
      testSessionStartCh.unsubscribe(onSessionStart)
      testSessionFinishCh.unsubscribe(onSessionFinish)
      testSuiteErrorCh.unsubscribe(onSuiteError)
      testSuiteStartCh.unsubscribe(onSuiteStart)
      testSuiteFinishCh.unsubscribe(onSuiteFinish)
    }
  })

  it('keeps failures when all executed EFD attempts fail and unused attempts are pending', () => {
    const testName = 'mocha.test-suite.test-name'
    const firstFailure = new MochaTest('first failure', () => {})
    const secondFailure = new MochaTest('second failure', () => {})
    const unusedRetry = new MochaTest('unused retry', () => {})
    firstFailure.state = 'failed'
    secondFailure.state = 'failed'
    unusedRetry.pending = true
    unusedRetry.state = 'pending'
    efdTests[testName] = [firstFailure, secondFailure, unusedRetry]
    const runner = {
      failures: 2,
      stats: { failures: 2 },
    }

    try {
      adjustRunnerFailuresForTestOptimization(runner, { isEarlyFlakeDetectionEnabled: true })
    } finally {
      delete efdTests[testName]
    }

    assert.strictEqual(runner.failures, 2)
    assert.strictEqual(runner.stats.failures, 2)
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
    const workerReportLogsCh = channel('ci:mocha:worker-report:logs')
    const workerReportTelemetryCh = channel('ci:mocha:worker-report:telemetry')
    const workerReportTraceCh = channel('ci:mocha:worker-report:trace')

    const sessionStarts = []
    const sessionFinishes = []
    const suiteStarts = []
    const suiteFinishes = []
    const workerLogPayloads = []
    const workerTelemetryPayloads = []
    const workerTracePayloads = []
    let advancedFeatureRequests = 0
    let configurationRequests = 0
    let skippableSuiteRequests = 0
    const consoleWarn = sinon.stub(console, 'warn')
    const originalNodeOptions = process.env.NODE_OPTIONS
    process.env.NODE_OPTIONS = '--require dd-trace/ci/init'

    function onTestFinish () {}
    function onKnownTestsRequest (request) {
      advancedFeatureRequests++
      request.onDone({
        knownTests: {
          webdriverio: {
            'first.spec.js': ['first test'],
          },
        },
      })
    }
    function onModifiedFilesRequest (request) {
      advancedFeatureRequests++
      request.onDone({
        modifiedFiles: {
          'first.spec.js': [1],
        },
      })
    }
    function onSkippableSuitesRequest (request) {
      skippableSuiteRequests++
      request.onDone({})
    }
    function onTestManagementTestsRequest (request) {
      advancedFeatureRequests++
      request.onDone({
        testManagementTests: {
          webdriverio: {
            suites: {
              'second.spec.js': {
                tests: {},
              },
            },
          },
        },
      })
    }
    function onLibraryConfiguration (request) {
      configurationRequests++
      assert.strictEqual(request.testFramework, 'webdriverio')
      assert.strictEqual(request.disableTestImpactAnalysis, true)
      request.onDone({
        isTestDynamicInstrumentationEnabled: true,
        libraryConfig: {
          earlyFlakeDetectionRetryPolicy: createEfdRetryPolicy({ '5s': 5 }),
          earlyFlakeDetectionFaultyThreshold: 30,
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
    function onWorkerLogs (event) {
      workerLogPayloads.push(event)
    }
    function onWorkerTelemetry (event) {
      workerTelemetryPayloads.push(event)
    }

    testFinishCh.subscribe(onTestFinish)
    knownTestsCh.subscribe(onKnownTestsRequest)
    libraryConfigurationCh.subscribe(onLibraryConfiguration)
    modifiedFilesCh.subscribe(onModifiedFilesRequest)
    skippableSuitesCh.subscribe(onSkippableSuitesRequest)
    testSessionStartCh.subscribe(onSessionStart)
    testSessionFinishCh.subscribe(onSessionFinish)
    testSuiteStartCh.subscribe(onSuiteStart)
    testSuiteFinishCh.subscribe(onSuiteFinish)
    testManagementTestsCh.subscribe(onTestManagementTestsRequest)
    workerReportLogsCh.subscribe(onWorkerLogs)
    workerReportTelemetryCh.subscribe(onWorkerTelemetry)
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
        origin: 'datadog',
        name: 'workerEvent',
        args: {
          name: WORKER_READY,
          content: { frameworkVersion: '10.8.2' },
        },
      })
      secondWorker.emit('message', {
        origin: 'datadog',
        name: 'workerEvent',
        args: {
          name: WORKER_READY,
          content: { frameworkVersion: '10.8.2' },
        },
      })
      await new Promise(setImmediate)

      requestConfiguration(firstWorker, firstFile, 'first-request')
      requestConfiguration(secondWorker, secondFile, 'second-request')
      await new Promise(setImmediate)

      const firstTrace = JSON.stringify([[{
        meta: {
          [TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX]: 'true',
          [TEST_NAME]: 'first test',
          [TEST_STATUS]: 'fail',
          [TEST_SUITE]: 'first.spec.js',
        },
      }]])
      const secondTrace = JSON.stringify([[{
        meta: {
          [TEST_HAS_DYNAMIC_NAME]: 'true',
          [TEST_NAME]: 'dynamic 12345678',
          [TEST_SUITE]: 'second.spec.js',
        },
      }]])
      firstWorker.emit('message', {
        origin: 'datadog',
        name: 'workerEvent',
        args: [MOCHA_WORKER_TRACE_PAYLOAD_CODE, firstTrace],
      })
      secondWorker.emit('message', {
        origin: 'datadog',
        name: 'workerEvent',
        args: [MOCHA_WORKER_TRACE_PAYLOAD_CODE, secondTrace],
      })
      firstWorker.emit('message', {
        origin: 'datadog',
        name: 'workerEvent',
        args: [MOCHA_WORKER_LOGS_PAYLOAD_CODE, 'first-logs'],
      })
      firstWorker.emit('message', {
        origin: 'datadog',
        name: 'workerEvent',
        args: [MOCHA_WORKER_TELEMETRY_PAYLOAD_CODE, 'first-telemetry'],
      })

      assert.strictEqual(firstWorker.sentMessages[0].name, CONFIGURATION_RESPONSE)
      assert.strictEqual(firstWorker.sentMessages[0].content.requestId, 'first-request')
      assert.strictEqual(secondWorker.sentMessages[0].name, CONFIGURATION_RESPONSE)
      assert.strictEqual(secondWorker.sentMessages[0].content.requestId, 'second-request')
      assert.deepStrictEqual(firstWorker.sentMessages[0].content.configuration, {
        earlyFlakeDetectionFaultyThreshold: 30,
        earlyFlakeDetectionRetryPolicy: createEfdRetryPolicy({ '5s': 5 }),
        flakyTestRetriesCount: 5,
        isCodeCoverageEnabled: false,
        isCoverageReportUploadEnabled: false,
        isDiEnabled: true,
        isEarlyFlakeDetectionEnabled: true,
        isFlakyTestRetriesEnabled: true,
        isImpactedTestsEnabled: true,
        isItrEnabled: false,
        isKnownTestsEnabled: true,
        isSuitesSkippingEnabled: false,
        isTestDynamicInstrumentationEnabled: true,
        isTestFailureScreenshotsEnabled: false,
        isTestManagementTestsEnabled: true,
        knownTests: {
          mocha: {
            'first.spec.js': ['first test'],
          },
        },
        modifiedFiles: {
          'first.spec.js': [1],
        },
        repositoryRoot: process.cwd(),
        testFramework: 'webdriverio',
        testManagementAttemptToFixRetries: 5,
        testManagementTests: {
          mocha: {
            suites: {
              'second.spec.js': {
                tests: {},
              },
            },
          },
        },
      })

      reportSuiteFinish(firstWorker, firstFile, 'fail')
      reportSuiteFinish(secondWorker, secondFile)
      firstWorker.emit('exit', { exitCode: 1, retries: 1 })
      secondWorker.emit('exit', { exitCode: 0, retries: 0 })

      await finishLocalRunner(localRunner)

      assert.strictEqual(configurationRequests, 1)
      assert.strictEqual(advancedFeatureRequests, 3)
      assert.strictEqual(skippableSuiteRequests, 0)
      assert.strictEqual(sessionStarts.length, 1)
      assert.strictEqual(sessionStarts[0].testFramework, 'webdriverio')
      assert.strictEqual(sessionStarts[0].testFrameworkAdapter, 'mocha')
      assert.strictEqual(sessionFinishes.length, 1)
      assert.strictEqual(sessionFinishes[0].status, 'pass')
      assert.strictEqual(sessionFinishes[0].isParallel, true)
      assert.strictEqual(sessionFinishes[0].isEarlyFlakeDetectionEnabled, true)
      assert.strictEqual(sessionFinishes[0].isTestManagementEnabled, true)
      assert.strictEqual(sessionFinishes[0].isSuitesSkipped, false)
      assert.deepStrictEqual(suiteStarts.map(({ testSuiteAbsolutePath }) => testSuiteAbsolutePath), [
        firstFile,
        secondFile,
      ])
      assert.strictEqual(new Set(suiteStarts.map(({ testSuiteExecutionId }) => testSuiteExecutionId)).size, 2)
      assert.deepStrictEqual(workerTracePayloads, [
        {
          traces: firstTrace,
          [TEST_SUITE_EXECUTION_ID]: suiteStarts[0].testSuiteExecutionId,
        },
        {
          traces: secondTrace,
          [TEST_SUITE_EXECUTION_ID]: suiteStarts[1].testSuiteExecutionId,
        },
      ])
      assert.deepStrictEqual(workerLogPayloads, ['first-logs'])
      assert.deepStrictEqual(workerTelemetryPayloads, ['first-telemetry'])
      assert.deepStrictEqual(suiteFinishes.map(({ status }) => status), ['fail', 'pass'])
      assert.strictEqual(consoleWarn.callCount, 1)
      assert.match(consoleWarn.firstCall.args[0], /Attempt to fix failed/)
      assert.match(consoleWarn.firstCall.args[0], /second\.spec\.js › dynamic 12345678/)
    } finally {
      testFinishCh.unsubscribe(onTestFinish)
      knownTestsCh.unsubscribe(onKnownTestsRequest)
      libraryConfigurationCh.unsubscribe(onLibraryConfiguration)
      modifiedFilesCh.unsubscribe(onModifiedFilesRequest)
      skippableSuitesCh.unsubscribe(onSkippableSuitesRequest)
      testSessionStartCh.unsubscribe(onSessionStart)
      testSessionFinishCh.unsubscribe(onSessionFinish)
      testSuiteStartCh.unsubscribe(onSuiteStart)
      testSuiteFinishCh.unsubscribe(onSuiteFinish)
      testManagementTestsCh.unsubscribe(onTestManagementTestsRequest)
      workerReportLogsCh.unsubscribe(onWorkerLogs)
      workerReportTelemetryCh.unsubscribe(onWorkerTelemetry)
      workerReportTraceCh.unsubscribe(onWorkerTrace)
      consoleWarn.restore()
      if (originalNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS
      } else {
        process.env.NODE_OPTIONS = originalNodeOptions
      }
    }
  })

  it('scopes test management summaries to each coordinator', async () => {
    const testFinishCh = channel('ci:mocha:test:finish')
    const consoleWarn = sinon.stub(console, 'warn')
    const runs = [
      {
        file: path.join(process.cwd(), 'first.spec.js'),
        localRunner: { config: { framework: 'mocha', rootDir: process.cwd() } },
        testName: 'first test',
        worker: createWorker(),
      },
      {
        file: path.join(process.cwd(), 'second.spec.js'),
        localRunner: { config: { framework: 'mocha', rootDir: process.cwd() } },
        testName: 'second test',
        worker: createWorker(),
      },
    ]

    function onTestFinish () {}

    testFinishCh.subscribe(onTestFinish)

    try {
      require('../src/webdriverio')

      for (let index = 0; index < runs.length; index++) {
        const { file, localRunner, worker } = runs[index]
        registerWorker(localRunner, worker, file)
        requestConfiguration(worker, file, `request-${index}`)
      }
      await new Promise(setImmediate)

      for (const { file, testName, worker } of runs) {
        worker.emit('message', [
          MOCHA_WORKER_TRACE_PAYLOAD_CODE,
          JSON.stringify([[{
            meta: {
              [TEST_MANAGEMENT_IS_QUARANTINED]: 'true',
              [TEST_NAME]: testName,
              [TEST_STATUS]: 'fail',
              [TEST_SUITE]: path.basename(file),
            },
          }]]),
        ])
        worker.emit('exit', { exitCode: 0, retries: 0 })
      }

      await finishLocalRunner(runs[0].localRunner)

      assert.strictEqual(consoleWarn.callCount, 1)
      assert.match(consoleWarn.firstCall.args[0], /first\.spec\.js › first test/)
      assert.doesNotMatch(consoleWarn.firstCall.args[0], /second\.spec\.js › second test/)

      await finishLocalRunner(runs[1].localRunner)

      assert.strictEqual(consoleWarn.callCount, 2)
      assert.match(consoleWarn.secondCall.args[0], /second\.spec\.js › second test/)
      assert.doesNotMatch(consoleWarn.secondCall.args[0], /first\.spec\.js › first test/)
    } finally {
      testFinishCh.unsubscribe(onTestFinish)
      consoleWarn.restore()
    }
  })

  it('uses the resolved launcher schedule before configuring the first lazy worker', async () => {
    const testFinishCh = channel('ci:mocha:test:finish')
    const knownTestsCh = channel('ci:mocha:known-tests')
    const libraryConfigurationCh = channel('ci:mocha:library-configuration')
    const testSessionFinishCh = channel('ci:mocha:session:finish')
    const knownFile = path.join(process.cwd(), 'root-known.spec.js')
    const currentNewFile = path.join(process.cwd(), 'current-new.spec.js')
    const futureNewFile = path.join(process.cwd(), 'future-new.spec.js')

    function onTestFinish () {}
    function onKnownTestsRequest (request) {
      request.onDone({
        knownTests: {
          webdriverio: {
            'root-known.spec.js': ['known test'],
          },
        },
      })
    }
    function onLibraryConfiguration (request) {
      request.onDone({
        libraryConfig: {
          earlyFlakeDetectionFaultyThreshold: 1,
          isEarlyFlakeDetectionEnabled: true,
          isKnownTestsEnabled: true,
        },
        repositoryRoot: process.cwd(),
      })
    }
    function onSessionFinish (event) {
      event.onDone()
    }

    testFinishCh.subscribe(onTestFinish)
    knownTestsCh.subscribe(onKnownTestsRequest)
    libraryConfigurationCh.subscribe(onLibraryConfiguration)
    testSessionFinishCh.subscribe(onSessionFinish)

    try {
      require('../src/webdriverio')

      const localRunner = {
        config: {
          framework: 'mocha',
          rootDir: process.cwd(),
        },
      }
      const launcher = {
        runner: localRunner,
        _schedule: [{
          specs: [{ files: [futureNewFile] }],
        }],
      }
      tracingChannel('orchestrion:@wdio/cli:Launcher_startInstance').start.publish({
        self: launcher,
        arguments: [[knownFile, currentNewFile]],
      })

      const worker = createWorker()
      registerWorker(localRunner, worker, [knownFile, currentNewFile])
      requestConfiguration(worker, [knownFile, currentNewFile], 'first-request')
      await new Promise(setImmediate)

      const { configuration } = worker.sentMessages[0].content
      assert.strictEqual(configuration.isEarlyFlakeDetectionEnabled, false)
      assert.strictEqual(configuration.isEarlyFlakeDetectionFaulty, true)
      assert.strictEqual(configuration.isKnownTestsEnabled, false)

      worker.emit('exit', { exitCode: 0, retries: 0 })
      await finishLocalRunner(localRunner)
    } finally {
      testFinishCh.unsubscribe(onTestFinish)
      knownTestsCh.unsubscribe(onKnownTestsRequest)
      libraryConfigurationCh.unsubscribe(onLibraryConfiguration)
      testSessionFinishCh.unsubscribe(onSessionFinish)
    }
  })

  it('marks missing framework known-tests data as faulty independently of the threshold', async () => {
    const testFinishCh = channel('ci:mocha:test:finish')
    const knownTestsCh = channel('ci:mocha:known-tests')
    const libraryConfigurationCh = channel('ci:mocha:library-configuration')
    const testSessionFinishCh = channel('ci:mocha:session:finish')

    function onTestFinish () {}
    function onKnownTestsRequest (request) {
      request.onDone({ knownTests: { 'not-webdriverio': {} } })
    }
    function onLibraryConfiguration (request) {
      request.onDone({
        libraryConfig: {
          earlyFlakeDetectionFaultyThreshold: 100,
          isEarlyFlakeDetectionEnabled: true,
          isKnownTestsEnabled: true,
        },
        repositoryRoot: process.cwd(),
      })
    }
    function onSessionFinish (event) {
      event.onDone()
    }

    testFinishCh.subscribe(onTestFinish)
    knownTestsCh.subscribe(onKnownTestsRequest)
    libraryConfigurationCh.subscribe(onLibraryConfiguration)
    testSessionFinishCh.subscribe(onSessionFinish)

    try {
      require('../src/webdriverio')

      const localRunner = {
        config: {
          framework: 'jasmine',
          rootDir: process.cwd(),
        },
      }
      const worker = createWorker()
      const file = path.join(process.cwd(), 'new.spec.js')

      registerWorker(localRunner, worker, file)
      requestConfiguration(worker, file, 'missing-framework')
      await new Promise(setImmediate)

      const { configuration } = worker.sentMessages[0].content
      assert.strictEqual(configuration.isEarlyFlakeDetectionEnabled, false)
      assert.strictEqual(configuration.isEarlyFlakeDetectionFaulty, true)
      assert.strictEqual(configuration.isKnownTestsEnabled, false)

      worker.emit('exit', { exitCode: 0, retries: 0 })
      await finishLocalRunner(localRunner)
    } finally {
      testFinishCh.unsubscribe(onTestFinish)
      knownTestsCh.unsubscribe(onKnownTestsRequest)
      libraryConfigurationCh.unsubscribe(onLibraryConfiguration)
      testSessionFinishCh.unsubscribe(onSessionFinish)
    }
  })

  it('uses the worker suite-name root when evaluating EFD faultiness', async () => {
    const testFinishCh = channel('ci:mocha:test:finish')
    const knownTestsCh = channel('ci:mocha:known-tests')
    const libraryConfigurationCh = channel('ci:mocha:library-configuration')
    const testSessionFinishCh = channel('ci:mocha:session:finish')
    const knownFile = path.join(process.cwd(), 'known.spec.js')

    function onTestFinish () {}
    function onKnownTestsRequest (request) {
      request.onDone({
        knownTests: {
          webdriverio: {
            'known.spec.js': ['known test'],
          },
        },
      })
    }
    function onLibraryConfiguration (request) {
      request.onDone({
        libraryConfig: {
          earlyFlakeDetectionFaultyThreshold: 0,
          isEarlyFlakeDetectionEnabled: true,
          isKnownTestsEnabled: true,
        },
        repositoryRoot: path.dirname(process.cwd()),
      })
    }
    function onSessionFinish (event) {
      event.onDone()
    }

    testFinishCh.subscribe(onTestFinish)
    knownTestsCh.subscribe(onKnownTestsRequest)
    libraryConfigurationCh.subscribe(onLibraryConfiguration)
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

      registerWorker(localRunner, worker, knownFile)
      requestConfiguration(worker, knownFile, 'first-request')
      await new Promise(setImmediate)

      const { configuration } = worker.sentMessages[0].content
      assert.strictEqual(configuration.isEarlyFlakeDetectionEnabled, true)
      assert.strictEqual(configuration.isEarlyFlakeDetectionFaulty, undefined)
      assert.strictEqual(configuration.isKnownTestsEnabled, true)

      worker.emit('exit', { exitCode: 0, retries: 0 })
      await finishLocalRunner(localRunner)
    } finally {
      testFinishCh.unsubscribe(onTestFinish)
      knownTestsCh.unsubscribe(onKnownTestsRequest)
      libraryConfigurationCh.unsubscribe(onLibraryConfiguration)
      testSessionFinishCh.unsubscribe(onSessionFinish)
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

      await finishLocalRunner(localRunner)

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

      await finishLocalRunner(localRunner)

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

  it('reports a suite that fails after Mocha loads but before requesting configuration', async () => {
    const testFinishCh = channel('ci:mocha:test:finish')
    const testSessionFinishCh = channel('ci:mocha:session:finish')
    const testSuiteStartCh = channel('ci:mocha:test-suite:start')
    const testSuiteFinishCh = channel('ci:mocha:test-suite:finish')
    const sessionFinishes = []
    const suiteStarts = []
    const suiteFinishes = []

    function onTestFinish () {}
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
    testSessionFinishCh.subscribe(onSessionFinish)
    testSuiteStartCh.subscribe(onSuiteStart)
    testSuiteFinishCh.subscribe(onSuiteFinish)

    try {
      require('../src/webdriverio')

      const localRunner = {
        config: {
          framework: 'mocha',
          rootDir: process.cwd(),
        },
      }
      const file = path.join(process.cwd(), 'load-fail.spec.js')
      const worker = createWorker()

      registerWorker(localRunner, worker, file)
      worker.emit('message', {
        name: WORKER_READY,
        content: { frameworkVersion: '10.8.2' },
      })
      worker.emit('exit', { exitCode: 1, retries: 0 })

      await finishLocalRunner(localRunner)

      assert.strictEqual(sessionFinishes.length, 1)
      assert.strictEqual(sessionFinishes[0].status, 'fail')
      assert.deepStrictEqual(suiteStarts.map(event => event.testSuiteAbsolutePath), [file])
      assert.deepStrictEqual(suiteFinishes.map(event => event.status), ['fail'])
    } finally {
      testFinishCh.unsubscribe(onTestFinish)
      testSessionFinishCh.unsubscribe(onSessionFinish)
      testSuiteStartCh.unsubscribe(onSuiteStart)
      testSuiteFinishCh.unsubscribe(onSuiteFinish)
    }
  })

  it('reports LocalRunner.run rejections before a worker exists', async () => {
    const testFinishCh = channel('ci:mocha:test:finish')
    const testSessionFinishCh = channel('ci:mocha:session:finish')
    const sessionFinishes = []
    const runError = new Error('worker spawn failed')

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
      const runContext = {
        self: localRunner,
        arguments: [{ specs: [path.join(process.cwd(), 'first.spec.js')] }],
      }
      const runCh = tracingChannel('orchestrion:@wdio/local-runner:LocalRunner_run')

      runCh.start.publish(runContext)
      runContext.error = runError
      runCh.asyncEnd.publish(runContext)

      await finishLocalRunner(localRunner)

      assert.strictEqual(sessionFinishes.length, 1)
      assert.strictEqual(sessionFinishes[0].status, 'fail')
      assert.strictEqual(sessionFinishes[0].error, runError)
      assert.strictEqual(sessionFinishes[0].isParallel, false)
    } finally {
      testFinishCh.unsubscribe(onTestFinish)
      testSessionFinishCh.unsubscribe(onSessionFinish)
    }
  })

  it('reports LocalRunner.shutdown rejections after coordinator completion', async () => {
    const testFinishCh = channel('ci:mocha:test:finish')
    const testSessionFinishCh = channel('ci:mocha:session:finish')
    const sessionFinishes = []
    const shutdownError = new Error('shutdown failed')

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
      const runContext = {
        self: localRunner,
        arguments: [{ specs: [] }],
      }

      tracingChannel('orchestrion:@wdio/local-runner:LocalRunner_run').start.publish(runContext)
      await finishLocalRunner(localRunner, shutdownError)

      assert.strictEqual(sessionFinishes.length, 1)
      assert.strictEqual(sessionFinishes[0].status, 'fail')
      assert.strictEqual(sessionFinishes[0].error, shutdownError)
      assert.strictEqual(sessionFinishes[0].isParallel, false)
    } finally {
      testFinishCh.unsubscribe(onTestFinish)
      testSessionFinishCh.unsubscribe(onSessionFinish)
    }
  })

  it('waits for in-flight coordinator initialization during shutdown', async () => {
    const testFinishCh = channel('ci:mocha:test:finish')
    const libraryConfigurationCh = channel('ci:mocha:library-configuration')
    const testSessionFinishCh = channel('ci:mocha:session:finish')
    const sessionFinishes = []
    let completeConfiguration

    function onTestFinish () {}
    function onLibraryConfiguration (request) {
      completeConfiguration = request.onDone
    }
    function onSessionFinish (event) {
      sessionFinishes.push(event)
      event.onDone()
    }

    testFinishCh.subscribe(onTestFinish)
    libraryConfigurationCh.subscribe(onLibraryConfiguration)
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
      worker.emit('message', { name: WORKER_READY })

      const shutdownPromise = finishLocalRunner(localRunner)

      assert.strictEqual(sessionFinishes.length, 0)
      completeConfiguration({ repositoryRoot: process.cwd() })
      await shutdownPromise

      assert.strictEqual(sessionFinishes.length, 1)
      assert.strictEqual(sessionFinishes[0].status, 'skip')
    } finally {
      testFinishCh.unsubscribe(onTestFinish)
      libraryConfigurationCh.unsubscribe(onLibraryConfiguration)
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
 * Creates a configured Jasmine worker plugin with observable test spans.
 *
 * @param {object} libraryConfig
 * @param {object} [options]
 * @param {object} [options.exporter]
 * @param {object} [options.testOptimization]
 * @returns {{plugin: MochaPlugin, spans: object[]}}
 */
function createJasminePlugin (libraryConfig, options = {}) {
  const { exporter = {}, testOptimization = {} } = options
  const plugin = new MochaPlugin({ _exporter: exporter }, { testOptimization })
  const spans = []
  sinon.stub(plugin, 'startTestSpan').callsFake(() => {
    const tags = { 'span.type': 'test' }
    const traceId = String(spans.length + 1)
    const context = {
      _isFinished: false,
      _trace: { started: [] },
      getTag: name => tags[name],
      getTags: () => tags,
      toTraceId: () => traceId,
    }
    const span = {
      context: () => context,
      _getTime: () => Date.now(),
      finish: () => {
        context._isFinished = true
      },
      setTag: (name, value) => {
        tags[name] = value
      },
    }
    context._trace.started.push(span)
    spans.push(span)
    return span
  })
  plugin.configure({ enabled: true })
  channel('ci:mocha:worker:configuration').publish({
    libraryConfig,
    repositoryRoot: process.cwd(),
    specs: [],
    testFramework: 'webdriverio',
    testFrameworkAdapter: 'jasmine',
  })
  return { plugin, spans }
}

/**
 * Creates a Jasmine reporter result.
 *
 * @param {string} id
 * @param {string} file
 * @param {string} status
 * @returns {object}
 */
function createJasmineResult (id, file, status) {
  return {
    description: id,
    file,
    fullName: id,
    id,
    status,
  }
}

/**
 * Reports the start of a Jasmine spec.
 *
 * @param {object} result
 * @param {string} file
 * @returns {void}
 */
function reportJasmineSpecStarted (result, file) {
  channel('tracing:orchestrion:@wdio/jasmine-framework:JasmineReporter_specStarted:end').publish({
    arguments: [result],
    self: { _specs: [file] },
  })
}

/**
 * Publishes the LocalRunner.run lifecycle for one worker.
 *
 * @param {object} localRunner
 * @param {object} worker
 * @param {string|string[]} file
 * @returns {void}
 */
function registerWorker (localRunner, worker, file) {
  const specs = Array.isArray(file) ? file : [file]
  const context = {
    self: localRunner,
    arguments: [{ specs }],
  }
  const runCh = tracingChannel('orchestrion:@wdio/local-runner:LocalRunner_run')
  runCh.start.publish(context)
  context.result = worker
  runCh.asyncEnd.publish(context)
}

/**
 * Publishes LocalRunner.shutdown completion and waits for the coordinator callback.
 *
 * @param {object} localRunner
 * @param {unknown} [error]
 * @returns {Promise<void>}
 */
function finishLocalRunner (localRunner, error) {
  const context = { self: localRunner, error }
  tracingChannel('orchestrion:@wdio/local-runner:LocalRunner_shutdown').asyncEnd.publish(context)
  const callback = error ? context.rejectCallback : context.resolveCallback
  return new Promise(callback)
}

/**
 * Requests execution configuration from the coordinator.
 *
 * @param {EventEmitter} worker
 * @param {string|string[]} file
 * @param {string} requestId
 * @returns {void}
 */
function requestConfiguration (worker, file, requestId) {
  const files = Array.isArray(file) ? file : [file]
  worker.emit('message', {
    origin: 'datadog',
    name: 'workerEvent',
    args: {
      name: CONFIGURATION_REQUEST,
      content: {
        files,
        frameworkVersion: '10.8.2',
        requestId,
      },
    },
  })
}

/**
 * Reports a suite result to the coordinator.
 *
 * @param {EventEmitter} worker
 * @param {string} file
 * @param {string} [status]
 * @param {{message?: string, stack?: string}} [error]
 * @returns {void}
 */
function reportSuiteFinish (worker, file, status = 'pass', error) {
  worker.emit('message', {
    origin: 'datadog',
    name: 'workerEvent',
    args: {
      name: SUITE_FINISH,
      content: {
        results: [{ error, file, status }],
      },
    },
  })
}
