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
const { channel, tracingChannel } = require('../src/helpers/instrument')
const rewriter = require('../src/helpers/rewriter')
const { createEfdRetryPolicy } = require('../../dd-trace/src/ci-visibility/efd-retry-policy')
const { RUM_TEST_EXECUTION_ID_COOKIE_NAME } = require('../../dd-trace/src/ci-visibility/rum')
const {
  adjustRunnerFailuresForTestOptimization,
  efdTests,
} = require('../src/mocha/utils')
const {
  MOCHA_WORKER_LOGS_PAYLOAD_CODE,
  MOCHA_WORKER_TELEMETRY_PAYLOAD_CODE,
  MOCHA_WORKER_TRACE_PAYLOAD_CODE,
  TEST_HAS_DYNAMIC_NAME,
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
  SUITE_FINISH,
  WEBDRIVERIO_WORKER_ENV,
  WORKER_READY,
} = require('../src/mocha/webdriverio-protocol')

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

/** @typedef {{done: boolean, value?: unknown}} RumGeneratorStep */
/**
 * @typedef {object} RumGenerator
 * @property {(value?: unknown) => RumGeneratorStep} next
 * @property {(error: unknown) => RumGeneratorStep} throw
 */

/**
 * Runs a production instrumentation generator in unit tests.
 *
 * @param {RumGenerator} generator
 * @returns {Promise<unknown>}
 */
async function runGenerator (generator) {
  let step = generator.next()
  while (!step.done) {
    try {
      const operation = step.value
      const value = typeof operation === 'function' ? await new Promise(operation) : await operation
      step = generator.next(value)
    } catch (error) {
      step = generator.throw(error)
    }
  }
  return step.value
}

describe('webdriverio instrumentation', () => {
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
    assert.match(rewrittenSource, /__apm\$ctx\.resolveGenerator/)
    assert.match(rewrittenSource, /__apm\$ctx\.rejectGenerator/)
    assert.match(rewrittenSource, /__apm\$ctx\.retryGenerator/)
  })

  it('rewrites WebdriverIO URL navigation and waits for RUM correlation', () => {
    const source = fs.readFileSync(browserFixturePath, 'utf8')
    for (const modulePath of browserFixtureModulePaths) {
      const rewrittenSource = rewriter.rewrite(source, modulePath, 'module')

      assert.notStrictEqual(rewrittenSource, source)
      assert.match(rewrittenSource, /orchestrion:webdriverio:url/)
      assert.match(rewrittenSource, /__apm\$ctx\.rumPreloadGenerator/)
      assert.match(rewrittenSource, /__apm\$ctx\.resolveCallback/)
      assert.match(rewrittenSource, /__apm\$ctx\.resolveGenerator/)
      assert.match(rewrittenSource, /__apm\$ctx\.rejectGenerator/)
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
    const browser = {
      addInitScript: sinon.stub().callsFake(() => {
        calls.push('add-preload')
        return Promise.resolve({
          remove: () => {
            calls.push('remove-preload')
            return Promise.resolve()
          },
        })
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
      fs.writeFileSync(outputPath, rewrittenSource)
      const { url3 } = await import(pathToFileURL(outputPath))
      await url3.call(browser, 'https://example.test', { wait: 'none' })

      assert.deepStrictEqual(calls, [
        'handle',
        'add-preload',
        'handle',
        'navigate:none',
        'detect',
      ])

      const testContext = { arguments: [undefined, 'Test'] }
      testFunctionCh.asyncEnd.publish(testContext)
      await runGenerator(testContext.resolveGenerator(testContext))

      assert.deepStrictEqual(calls.slice(5), [
        'remove-preload',
        'handle',
        'handles',
        'switch:window-a',
        'cleanup',
        'delete',
      ])
    } finally {
      correlationCh.unsubscribe(correlate)
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
        .onSecondCall().resolves(false),
      navigateTo: sinon.stub().callsFake(() => {
        calls.push('navigate')
        return Promise.reject(navigationError)
      }),
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
      await runGenerator(testContext.resolveGenerator(testContext))

      assert.deepStrictEqual(calls, [
        'navigate',
        'set',
        `delete:${RUM_TEST_EXECUTION_ID_COOKIE_NAME}`,
      ])
      assert.strictEqual(browser.execute.callCount, 2)
    } finally {
      correlationCh.unsubscribe(correlate)
    }
  })

  it('does not retain a standalone RUM browser when no test correlation is available', async () => {
    require('../src/webdriverio')

    const correlationCh = channel('ci:webdriverio:rum:page-navigate')
    const urlCh = tracingChannel('orchestrion:webdriverio:url')
    const testFunctionCh = tracingChannel('orchestrion:@wdio/utils:testFrameworkFnWrapper')
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
    const skipCorrelation = () => {}
    correlationCh.subscribe(skipCorrelation)

    try {
      const navigationContext = { self: browser }
      urlCh.asyncEnd.publish(navigationContext)
      await runGenerator(navigationContext.resolveGenerator(navigationContext))

      const testContext = { arguments: [undefined, 'Test'] }
      testFunctionCh.asyncEnd.publish(testContext)

      assert.strictEqual(testContext.resolveGenerator, undefined)
      assert.strictEqual(browser.execute.callCount, 1)
      assert.strictEqual(browser.setCookies.callCount, 0)
      assert.strictEqual(browser.deleteCookies.callCount, 0)
    } finally {
      correlationCh.unsubscribe(skipCorrelation)
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
        ctx.retryGenerator = function * (error) {
          callbacks.push(error.message)
          yield undefined
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
        ctx.retryGenerator = function * () {
          failedRetries.limit = 0
          yield undefined
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
        ctx.retryGenerator = function * () {
          yield Promise.reject(new Error('observability callback failed'))
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

  it('cleans RUM before preserving a failed beforeEach hook rejection', async () => {
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
      await runGenerator(navigationContext.resolveGenerator(navigationContext))

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
        `delete:${RUM_TEST_EXECUTION_ID_COOKIE_NAME}`,
      ])
      assert.strictEqual(browser.execute.callCount, 2)
    } finally {
      correlationCh.unsubscribe(correlate)
    }
  })

  it('cleans RUM after test and afterEach hook navigations', async () => {
    require('../src/webdriverio')

    const correlationCh = channel('ci:webdriverio:rum:page-navigate')
    const urlCh = tracingChannel('orchestrion:webdriverio:url')
    const testFunctionCh = tracingChannel('orchestrion:@wdio/utils:testFrameworkFnWrapper')
    const calls = []
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
          isRumActive: true,
          isRumInstrumented: true,
          rumSamplingRate: 100,
        })
        .onSecondCall().resolves(false)
        .onThirdCall().resolves({
          isRumActive: true,
          isRumInstrumented: true,
          rumSamplingRate: 100,
        })
        .onCall(3).resolves(false),
      setCookies: sinon.stub().callsFake((cookie) => {
        calls.push(`set:${cookie.value}`)
        return Promise.resolve()
      }),
    }
    const correlate = context => {
      assert.strictEqual(context.browserName, 'chrome')
      assert.strictEqual(context.browserVersion, '123')
      context.testExecutionId = '1234'
    }
    correlationCh.subscribe(correlate)

    try {
      const navigationContext = { self: browser }
      urlCh.asyncEnd.publish(navigationContext)
      await runGenerator(navigationContext.resolveGenerator(navigationContext))

      assert.strictEqual(browser.execute.callCount, 1)
      assert.strictEqual(browser.execute.firstCall.args.length, 1)
      assert.deepStrictEqual(calls, [
        'set:1234',
      ])

      calls.push('user-after-test')
      const testContext = { arguments: [undefined, 'Test'] }
      testFunctionCh.asyncEnd.publish(testContext)
      await runGenerator(testContext.resolveGenerator(testContext))

      assert.deepStrictEqual(calls, [
        'set:1234',
        'user-after-test',
        `delete:${RUM_TEST_EXECUTION_ID_COOKIE_NAME}`,
      ])
      assert.strictEqual(browser.execute.callCount, 2)

      const beforeEachContext = {
        arguments: [undefined, 'Hook', undefined, undefined, undefined, undefined, undefined, 'beforeEach'],
      }
      testFunctionCh.asyncEnd.publish(beforeEachContext)
      assert.strictEqual(beforeEachContext.resolveGenerator, undefined)

      const afterEachNavigationContext = { self: browser }
      urlCh.asyncEnd.publish(afterEachNavigationContext)
      await runGenerator(afterEachNavigationContext.resolveGenerator(afterEachNavigationContext))
      calls.push('user-after-each')

      const afterEachContext = {
        arguments: [undefined, 'Hook', undefined, undefined, undefined, undefined, undefined, 'afterEach'],
      }
      testFunctionCh.asyncEnd.publish(afterEachContext)
      await runGenerator(afterEachContext.resolveGenerator(afterEachContext))

      assert.deepStrictEqual(calls, [
        'set:1234',
        'user-after-test',
        `delete:${RUM_TEST_EXECUTION_ID_COOKIE_NAME}`,
        'set:1234',
        'user-after-each',
        `delete:${RUM_TEST_EXECUTION_ID_COOKIE_NAME}`,
      ])
      assert.strictEqual(browser.execute.callCount, 4)
    } finally {
      correlationCh.unsubscribe(correlate)
    }
  })

  it('preloads and clears cross-origin RUM correlation without loading application pages', async () => {
    require('../src/webdriverio')

    const correlationCh = channel('ci:webdriverio:rum:page-navigate')
    const urlCh = tracingChannel('orchestrion:webdriverio:url')
    const testFunctionCh = tracingChannel('orchestrion:@wdio/utils:testFrameworkFnWrapper')
    const calls = []
    let preloadScript
    const browser = {
      addInitScript: sinon.stub().callsFake((script, ...args) => {
        calls.push('add-preload')
        preloadScript = { args, script }
        return Promise.resolve({
          remove: () => {
            calls.push('remove-preload')
            return Promise.resolve()
          },
        })
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
      await runGenerator(firstNavigationContext.resolveGenerator(firstNavigationContext))

      assert.ok(preloadScript)
      const originalDocument = globalThis.document
      try {
        globalThis.document = { cookie: '' }
        preloadScript.script(...preloadScript.args)
        assert.strictEqual(
          globalThis.document.cookie,
          `${RUM_TEST_EXECUTION_ID_COOKIE_NAME}=1234; path=/`
        )
      } finally {
        if (originalDocument === undefined) {
          delete globalThis.document
        } else {
          globalThis.document = originalDocument
        }
      }

      const testContext = { arguments: [undefined, 'Test'] }
      testFunctionCh.asyncEnd.publish(testContext)
      await runGenerator(testContext.resolveGenerator(testContext))

      assert.deepStrictEqual(calls, [
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
      assert.strictEqual(browser.execute.callCount, 2)
    } finally {
      correlationCh.unsubscribe(correlate)
    }
  })

  it('re-correlates every browser window with a retry execution ID', async () => {
    require('../src/webdriverio')

    const executeAsyncContext = {}
    let currentWindowHandle = 'window-a'
    const browser = {
      addInitScript: sinon.stub().resolves({ remove: sinon.stub().resolves() }),
      capabilities: {},
      deleteCookies: sinon.stub().resolves(),
      execute: sinon.stub().resolves(false),
      getWindowHandle: sinon.stub().callsFake(() => Promise.resolve(currentWindowHandle)),
      getWindowHandles: sinon.stub().resolves(['window-a', 'window-b']),
      isBidi: true,
      setCookies: sinon.stub().resolves(),
      storageDeleteCookies: sinon.stub().resolves(),
      switchToWindow: sinon.stub().callsFake((windowHandle) => {
        currentWindowHandle = windowHandle
        return Promise.resolve()
      }),
    }

    channel('tracing:orchestrion:@wdio/utils:executeAsync:start').runStores(executeAsyncContext, () => {})
    await runGenerator(executeAsyncContext.rumCorrelationGenerator([browser], 'retry-execution-id'))

    assert.deepStrictEqual(browser.switchToWindow.args.map(([windowHandle]) => windowHandle), [
      'window-a',
      'window-b',
      'window-a',
    ])
    assert.deepStrictEqual(browser.setCookies.args, [
      [{ name: RUM_TEST_EXECUTION_ID_COOKIE_NAME, value: 'retry-execution-id' }],
      [{ name: RUM_TEST_EXECUTION_ID_COOKIE_NAME, value: 'retry-execution-id' }],
    ])
    assert.strictEqual(browser.addInitScript.callCount, 2)

    await runGenerator(executeAsyncContext.rumCleanupGenerator())
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
      await runGenerator(navigationContext.resolveGenerator(navigationContext))

      const testContext = { arguments: [undefined, 'Test'] }
      testFunctionCh.asyncEnd.publish(testContext)
      await runGenerator(testContext.resolveGenerator(testContext))

      assert.deepStrictEqual(calls, [
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
    } finally {
      plugin.configure(false)
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

  it('starts native WebdriverIO retry spans after retry setup settles', async () => {
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
      executeAsyncContext.rumCleanupGenerator = function * () {
        yield undefined
        return ['browser']
      }
      executeAsyncContext.rumCorrelationGenerator = function * (browsers, testExecutionId) {
        correlations.push({ browsers, spanCount: spans.length, testExecutionId })
        yield undefined
      }

      const retryPromise = runGenerator(executeAsyncContext.retryGenerator(new Error('native retry failure')))
      assert.strictEqual(spans.length, 1)

      finishRetrySetup()
      await retryPromise

      assert.strictEqual(spans.length, 2)
      assert.deepStrictEqual(correlations, [{
        browsers: ['browser'],
        spanCount: 2,
        testExecutionId: '2',
      }])

      retryCh.unsubscribe(onRetry)
      await runGenerator(executeAsyncContext.retryGenerator(new Error('immediate native retry failure')))
      assert.strictEqual(spans.length, 3)
      assert.deepStrictEqual(correlations[1], {
        browsers: ['browser'],
        spanCount: 3,
        testExecutionId: '3',
      })
    } finally {
      retryCh.unsubscribe(onRetry)
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
 * @returns {{plugin: MochaPlugin, spans: object[]}}
 */
function createJasminePlugin (libraryConfig) {
  const plugin = new MochaPlugin({ _exporter: {} }, { testOptimization: {} })
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
