'use strict'

const CiPlugin = require('../../plugins/ci_plugin')
const { COMPONENT } = require('../../constants')
const {
  TEST_CODE_OWNERS,
  TEST_COMMAND,
  TEST_LEVELS_METADATA,
  TEST_SESSION_NAME,
  TEST_STATUS,
  finishAllTraceSpans,
  getTestLevelsMetadataTags,
  getTestModuleCommonTags,
  getTestParentSpan,
  getTestSessionCommonTags,
  getTestSessionName,
  getTestSuiteCommonTags,
  getTestSuitePath,
} = require('../../plugins/util/test')
const { storage } = require('../../../../datadog-core')
const {
  TELEMETRY_EVENT_CREATED,
  TELEMETRY_EVENT_FINISHED,
  TELEMETRY_TEST_SESSION,
} = require('../telemetry')

const legacyStorage = storage('legacy')
const DEFAULT_COMMAND = process.argv.join(' ')

class TestApiManualPlugin extends CiPlugin {
  static id = 'test-api-manual'

  constructor (...args) {
    super(...args)
    this._isEnvDataCalcualted = false
    this.sourceRoot = process.cwd()

    this.unconfiguredAddBind('dd-trace:ci:manual:test-session:start', (ctx) => {
      const store = legacyStorage.getStore()
      const testModuleSpan = this.startTestSession(ctx)

      ctx.parentStore = store
      ctx.currentStore = { ...store, span: testModuleSpan, testSessionSpan: this.testSessionSpan, testModuleSpan }

      return ctx.currentStore
    })
    this.unconfiguredAddSub('dd-trace:ci:manual:test-session:start', (ctx) => {
      if (ctx.currentStore?.testModuleSpan) return

      const store = legacyStorage.getStore()
      const testModuleSpan = this.startTestSession(ctx)
      this.enter(testModuleSpan, { ...store, testSessionSpan: this.testSessionSpan, testModuleSpan })
    })
    this.unconfiguredAddSub('dd-trace:ci:manual:test-session:finish', ({ status, error, onDone }) => {
      this.finishTestSession(status, error, onDone)
    })
    this.unconfiguredAddSub('dd-trace:ci:manual:test-session:addTags', (tags) => {
      const store = legacyStorage.getStore()
      const testModuleSpan = store?.testModuleSpan || this.testModuleSpan
      if (testModuleSpan) {
        testModuleSpan.addTags(tags)
      }
    })

    this.unconfiguredAddBind('dd-trace:ci:manual:test-suite:start', (ctx) => {
      const store = legacyStorage.getStore()
      const testSuiteSpan = this.startTestSuite(ctx, store)

      ctx.parentStore = store
      ctx.currentStore = { ...store, span: testSuiteSpan, testSuiteSpan }

      return ctx.currentStore
    })
    this.unconfiguredAddSub('dd-trace:ci:manual:test-suite:start', (ctx) => {
      if (ctx.currentStore?.testSuiteSpan) return

      const store = legacyStorage.getStore()
      const testSuiteSpan = this.startTestSuite(ctx, store)
      this.enter(testSuiteSpan, { ...store, testSuiteSpan })
    })
    this.unconfiguredAddSub('dd-trace:ci:manual:test-suite:finish', (ctx) => {
      const store = legacyStorage.getStore()
      const testSuiteSpan = this.getTestSuiteSpan(ctx, store)
      this.finishTestSuite(testSuiteSpan, ctx.status, ctx.error)
    })
    this.unconfiguredAddSub('dd-trace:ci:manual:test-suite:addTags', (ctx) => {
      const store = legacyStorage.getStore()
      const testSuiteSpan = this.getTestSuiteSpan(ctx, store)
      if (testSuiteSpan) {
        testSuiteSpan.addTags(ctx.tags || ctx)
      }
    })

    this.unconfiguredAddBind('dd-trace:ci:manual:test:start', (ctx) => {
      const store = legacyStorage.getStore()
      const testSpan = this.startManualTest(ctx, store)

      ctx.parentStore = store
      ctx.currentStore = { ...store, span: testSpan, testSpan }

      this.activeTestSpan = testSpan

      return ctx.currentStore
    })
    this.unconfiguredAddSub('dd-trace:ci:manual:test:start', (ctx) => {
      const store = legacyStorage.getStore()
      if (store?.testSpan) return

      const testSpan = this.startManualTest(ctx, store)
      this.enter(testSpan, { ...store, testSpan })
      this.activeTestSpan = testSpan
    })
    this.unconfiguredAddSub('dd-trace:ci:manual:test:finish', ({ status, error }) => {
      const store = legacyStorage.getStore()
      const testSpan = this.getTestSpan(store)
      if (testSpan) {
        testSpan.setTag(TEST_STATUS, status)
        if (error) {
          testSpan.setTag('error', error)
        }
        testSpan.finish()
        finishAllTraceSpans(testSpan)
        this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'test', this.getTestTelemetryTags(testSpan))
        this.activeTestSpan = null
      }
    })
    this.unconfiguredAddSub('dd-trace:ci:manual:test:addTags', (tags) => {
      const store = legacyStorage.getStore()
      const testSpan = this.getTestSpan(store)
      if (testSpan) {
        testSpan.addTags(tags)
      }
    })
  }

  /**
   * Lazily calculates environment data before handling the first manual API event.
   *
   * @returns {void}
   */
  ensureEnvironmentData () {
    if (!this._isEnvDataCalcualted) {
      this._isEnvDataCalcualted = true
      this.configure(this._config, true)
    }
  }

  /**
   * Subscribes to a diagnostic channel after wrapping the handler in lazy configuration.
   *
   * @param {string} channelName Diagnostic channel name.
   * @param {(message: object) => unknown} handler Channel handler.
   * @returns {void}
   */
  unconfiguredAddSub (channelName, handler) {
    this.addSub(channelName, (...args) => {
      this.ensureEnvironmentData()
      return handler(...args)
    })
  }

  /**
   * Binds a diagnostic channel store after wrapping the transform in lazy configuration.
   *
   * @param {string} channelName Diagnostic channel name.
   * @param {(message: object) => object|undefined} handler Store transform.
   * @returns {void}
   */
  unconfiguredAddBind (channelName, handler) {
    this.addBind(channelName, (...args) => {
      this.ensureEnvironmentData()
      return handler(...args)
    })
  }

  /**
   * Starts the root test session span and the user-level test module span.
   *
   * @param {{
   *   command?: string,
   *   frameworkVersion?: string,
   *   testSessionName?: string,
   *   tags?: Record<string, unknown>
   * }} ctx Manual test session start payload.
   * @returns {object|undefined} The active user-level test module span.
   */
  startTestSession (ctx = {}) {
    if (this.testModuleSpan && !this.testModuleSpan.context()._isFinished) {
      return this.testModuleSpan
    }

    const command = ctx.command || DEFAULT_COMMAND
    const frameworkVersion = ctx.frameworkVersion
    const childOf = getTestParentSpan(this.tracer)
    const testSessionName = ctx.testSessionName ||
      getTestSessionName(this.config, command, this.testEnvironmentMetadata)
    const metadataTags = {
      [TEST_LEVELS_METADATA]: {
        [TEST_COMMAND]: command,
        [TEST_SESSION_NAME]: testSessionName,
        ...getTestLevelsMetadataTags(this.testEnvironmentMetadata),
      },
    }

    this.command = command
    this.frameworkVersion = frameworkVersion

    if (this.tracer._exporter.addMetadataTags) {
      this.tracer._exporter.addMetadataTags(metadataTags)
    }

    this.testSessionSpan = this.tracer.startSpan(`${this.constructor.id}.test_session`, {
      childOf,
      tags: {
        [COMPONENT]: this.constructor.id,
        ...this.testEnvironmentMetadata,
        ...getTestSessionCommonTags(command, frameworkVersion, this.constructor.id),
        ...ctx.tags,
      },
      integrationName: this.constructor.id,
    })
    this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'session')

    this.testModuleSpan = this.tracer.startSpan(`${this.constructor.id}.test_module`, {
      childOf: this.testSessionSpan,
      tags: {
        [COMPONENT]: this.constructor.id,
        ...this.testEnvironmentMetadata,
        ...getTestModuleCommonTags(command, frameworkVersion, this.constructor.id),
        ...ctx.tags,
      },
      integrationName: this.constructor.id,
    })
    this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'module')

    return this.testModuleSpan
  }

  /**
   * Finishes the user-level test module span and its root test session span.
   *
   * @param {string|undefined} status Test session status.
   * @param {Error|undefined} error Test session error.
   * @param {Function|undefined} onDone Optional callback to call after flushing.
   * @returns {void}
   */
  finishTestSession (status, error, onDone) {
    const testSessionSpan = this.testSessionSpan
    const testModuleSpan = this.testModuleSpan

    if (!testSessionSpan || !testModuleSpan) {
      if (onDone) onDone()
      return
    }

    const testStatus = status || (error ? 'fail' : 'pass')

    testSessionSpan.setTag(TEST_STATUS, testStatus)
    testModuleSpan.setTag(TEST_STATUS, testStatus)

    if (error) {
      testSessionSpan.setTag('error', error)
      testModuleSpan.setTag('error', error)
    }

    testModuleSpan.finish()
    this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'module')
    testSessionSpan.finish()
    this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'session')
    finishAllTraceSpans(testSessionSpan)

    this.telemetry.count(TELEMETRY_TEST_SESSION, {
      provider: this.ciProviderName,
      autoInjected: !!this._tracerConfig.testOptimization.DD_CIVISIBILITY_AUTO_INSTRUMENTATION_PROVIDER,
    })

    this.testSessionSpan = null
    this.testModuleSpan = null
    this._testSuiteSpansByTestSuite.clear()

    if (onDone) {
      this.tracer._exporter.flush(onDone)
    }
  }

  /**
   * Starts a test suite span under the active manual test session.
   *
   * @param {{ testSuite?: string, testSuiteAbsolutePath?: string, tags?: Record<string, unknown> }} ctx
   * Manual test suite start payload.
   * @param {object|undefined} store Current tracer store.
   * @returns {object|undefined} The test suite span.
   */
  startTestSuite (ctx, store) {
    if (!this.testModuleSpan) return

    const testSuite = this.getTestSuite(ctx)
    const testSuiteMetadata = {
      ...getTestSuiteCommonTags(
        this.command,
        this.frameworkVersion,
        testSuite,
        this.constructor.id
      ),
      ...this.getSessionRequestErrorTags(),
      ...this.getSessionItrSkippingEnabledTags(),
    }

    const codeOwners = this.getCodeOwners(testSuiteMetadata)
    if (codeOwners) {
      testSuiteMetadata[TEST_CODE_OWNERS] = codeOwners
    }

    const testSuiteSpan = this.tracer.startSpan(`${this.constructor.id}.test_suite`, {
      childOf: store?.testModuleSpan || this.testModuleSpan,
      tags: {
        [COMPONENT]: this.constructor.id,
        ...this.testEnvironmentMetadata,
        ...testSuiteMetadata,
        ...ctx.tags,
      },
      integrationName: this.constructor.id,
    })

    this._testSuiteSpansByTestSuite.set(testSuite, testSuiteSpan)
    this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'suite')

    return testSuiteSpan
  }

  /**
   * Finishes a test suite span.
   *
   * @param {object|undefined} testSuiteSpan The suite span to finish.
   * @param {string|undefined} status Test suite status.
   * @param {Error|undefined} error Test suite error.
   * @returns {void}
   */
  finishTestSuite (testSuiteSpan, status, error) {
    if (!testSuiteSpan) return

    testSuiteSpan.setTag(TEST_STATUS, status || (error ? 'fail' : 'pass'))
    if (error) {
      testSuiteSpan.setTag('error', error)
    }
    testSuiteSpan.finish()
    this.telemetry.ciVisEvent(TELEMETRY_EVENT_FINISHED, 'suite')
  }

  /**
   * Starts a test span, linking it to the active suite span when present.
   *
   * @param {{
   *   testName: string,
   *   testSuite?: string,
   *   testSuiteAbsolutePath?: string,
   *   tags?: Record<string, unknown>
   * }} ctx Manual test start payload.
   * @param {object|undefined} store Current tracer store.
   * @returns {object} The test span.
   */
  startManualTest (ctx, store) {
    const testSuite = this.getTestSuite(ctx)
    const testSuiteSpan = store?.testSuiteSpan || this._testSuiteSpansByTestSuite.get(testSuite)

    return this.startTestSpan(ctx.testName, testSuite, testSuiteSpan, ctx.tags)
  }

  /**
   * Gets the normalized test suite path from a manual API payload.
   *
   * @param {{ testSuite?: string, testSuiteAbsolutePath?: string }} ctx Manual API payload.
   * @returns {string} Normalized test suite path.
   */
  getTestSuite (ctx) {
    return getTestSuitePath(ctx.testSuite || ctx.testSuiteAbsolutePath, this.sourceRoot)
  }

  /**
   * Gets a test suite span from the current store or a manual API payload.
   *
   * @param {{ testSuite?: string, testSuiteAbsolutePath?: string }|undefined} ctx Manual API payload.
   * @param {object|undefined} store Current tracer store.
   * @returns {object|undefined} The test suite span.
   */
  getTestSuiteSpan (ctx, store) {
    if (store?.testSuiteSpan) return store.testSuiteSpan
    if (!ctx) return
    return this._testSuiteSpansByTestSuite.get(this.getTestSuite(ctx))
  }

  /**
   * Gets the active manual test span from a tracer store.
   *
   * @param {object|undefined} store Current tracer store.
   * @returns {object|undefined} The active test span.
   */
  getTestSpan (store) {
    const span = store?.testSpan || store?.span
    if (span?._name === `${this.constructor.id}.test`) {
      return span
    }
  }

  /**
   * @param {import('../../config/config-base')} config - Tracer configuration
   * @param {boolean} shouldGetEnvironmentData - Whether to get environment data
   */
  configure (config, shouldGetEnvironmentData) {
    this._config = config
    super.configure(config, shouldGetEnvironmentData)
  }
}

module.exports = TestApiManualPlugin
