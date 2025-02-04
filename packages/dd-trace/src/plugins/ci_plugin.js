const {
  getTestEnvironmentMetadata,
  getTestSessionName,
  getCodeOwnersFileEntries,
  getTestParentSpan,
  getTestCommonTags,
  getCodeOwnersForFilename,
  TEST_CODE_OWNERS,
  CI_APP_ORIGIN,
  getTestSessionCommonTags,
  getTestModuleCommonTags,
  TEST_SUITE_ID,
  TEST_MODULE_ID,
  TEST_SESSION_ID,
  TEST_COMMAND,
  TEST_MODULE,
  TEST_SESSION_NAME,
  getTestSuiteCommonTags,
  TEST_STATUS,
  TEST_SKIPPED_BY_ITR,
  ITR_CORRELATION_ID,
  TEST_SOURCE_FILE,
  TEST_LEVEL_EVENT_TYPES,
  TEST_SUITE,
  getFileAndLineNumberFromError,
  DI_ERROR_DEBUG_INFO_CAPTURED,
  DI_DEBUG_ERROR_PREFIX,
  DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX,
  DI_DEBUG_ERROR_FILE_SUFFIX,
  DI_DEBUG_ERROR_LINE_SUFFIX
} = require('./util/test')
const Plugin = require('./plugin')
const { COMPONENT } = require('../constants')
const log = require('../log')
const {
  incrementCountMetric,
  distributionMetric,
  TELEMETRY_EVENT_CREATED,
  TELEMETRY_ITR_SKIPPED
} = require('../ci-visibility/telemetry')
const { CI_PROVIDER_NAME, GIT_REPOSITORY_URL, GIT_COMMIT_SHA, GIT_BRANCH, CI_WORKSPACE_PATH } = require('./util/tags')
const { OS_VERSION, OS_PLATFORM, OS_ARCHITECTURE, RUNTIME_NAME, RUNTIME_VERSION } = require('./util/env')

module.exports = class CiPlugin extends Plugin {
  constructor (...args) {
    super(...args)

    this.fileLineToProbeId = new Map()
    this.rootDir = process.cwd() // fallback in case :session:start events are not emitted

    this.addSub(`ci:${this.constructor.id}:library-configuration`, ({ onDone }) => {
      if (!this.tracer._exporter || !this.tracer._exporter.getLibraryConfiguration) {
        return onDone({ err: new Error('CI Visibility was not initialized correctly') })
      }
      this.tracer._exporter.getLibraryConfiguration(this.testConfiguration, (err, libraryConfig) => {
        if (err) {
          log.error('Library configuration could not be fetched. %s', err.message)
        } else {
          this.libraryConfig = libraryConfig
        }
        onDone({ err, libraryConfig })
      })
    })

    this.addSub(`ci:${this.constructor.id}:test-suite:skippable`, ({ onDone }) => {
      if (!this.tracer._exporter?.getSkippableSuites) {
        return onDone({ err: new Error('CI Visibility was not initialized correctly') })
      }
      this.tracer._exporter.getSkippableSuites(this.testConfiguration, (err, skippableSuites, itrCorrelationId) => {
        if (err) {
          log.error('Skippable suites could not be fetched. %s', err.message)
        } else {
          this.itrCorrelationId = itrCorrelationId
        }
        onDone({ err, skippableSuites, itrCorrelationId })
      })
    })

    this.addSub(`ci:${this.constructor.id}:session:start`, ({ command, frameworkVersion, rootDir }) => {
      const childOf = getTestParentSpan(this.tracer)
      const testSessionSpanMetadata = getTestSessionCommonTags(command, frameworkVersion, this.constructor.id)
      const testModuleSpanMetadata = getTestModuleCommonTags(command, frameworkVersion, this.constructor.id)

      this.command = command
      this.frameworkVersion = frameworkVersion
      // only for playwright
      this.rootDir = rootDir

      const testSessionName = getTestSessionName(this.config, this.command, this.testEnvironmentMetadata)

      const metadataTags = {}
      for (const testLevel of TEST_LEVEL_EVENT_TYPES) {
        metadataTags[testLevel] = {
          [TEST_SESSION_NAME]: testSessionName
        }
      }
      // tracer might not be initialized correctly
      if (this.tracer._exporter.setMetadataTags) {
        this.tracer._exporter.setMetadataTags(metadataTags)
      }

      this.testSessionSpan = this.tracer.startSpan(`${this.constructor.id}.test_session`, {
        childOf,
        tags: {
          [COMPONENT]: this.constructor.id,
          ...this.testEnvironmentMetadata,
          ...testSessionSpanMetadata
        }
      })
      // TODO: add telemetry tag when we can add `is_agentless_log_submission_enabled` for agentless log submission
      this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'session')

      this.testModuleSpan = this.tracer.startSpan(`${this.constructor.id}.test_module`, {
        childOf: this.testSessionSpan,
        tags: {
          [COMPONENT]: this.constructor.id,
          ...this.testEnvironmentMetadata,
          ...testModuleSpanMetadata
        }
      })
      // only for vitest
      // These are added for the worker threads to use
      if (this.constructor.id === 'vitest') {
        process.env.DD_CIVISIBILITY_TEST_SESSION_ID = this.testSessionSpan.context().toTraceId()
        process.env.DD_CIVISIBILITY_TEST_MODULE_ID = this.testModuleSpan.context().toSpanId()
        process.env.DD_CIVISIBILITY_TEST_COMMAND = this.command
      }

      this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'module')
    })

    this.addSub(`ci:${this.constructor.id}:itr:skipped-suites`, ({ skippedSuites, frameworkVersion }) => {
      const testCommand = this.testSessionSpan.context()._tags[TEST_COMMAND]
      skippedSuites.forEach((testSuite) => {
        const testSuiteMetadata = getTestSuiteCommonTags(testCommand, frameworkVersion, testSuite, this.constructor.id)
        if (this.itrCorrelationId) {
          testSuiteMetadata[ITR_CORRELATION_ID] = this.itrCorrelationId
        }

        this.tracer.startSpan(`${this.constructor.id}.test_suite`, {
          childOf: this.testModuleSpan,
          tags: {
            [COMPONENT]: this.constructor.id,
            ...this.testEnvironmentMetadata,
            ...testSuiteMetadata,
            [TEST_STATUS]: 'skip',
            [TEST_SKIPPED_BY_ITR]: 'true'
          }
        }).finish()
      })
      this.telemetry.count(TELEMETRY_ITR_SKIPPED, { testLevel: 'suite' }, skippedSuites.length)
    })

    this.addSub(`ci:${this.constructor.id}:known-tests`, ({ onDone }) => {
      if (!this.tracer._exporter?.getKnownTests) {
        return onDone({ err: new Error('CI Visibility was not initialized correctly') })
      }
      this.tracer._exporter.getKnownTests(this.testConfiguration, (err, knownTests) => {
        if (err) {
          log.error('Known tests could not be fetched. %s', err.message)
          this.libraryConfig.isEarlyFlakeDetectionEnabled = false
          this.libraryConfig.isKnownTestsEnabled = false
        }
        onDone({ err, knownTests })
      })
    })
  }

  get telemetry () {
    const testFramework = this.constructor.id
    return {
      ciVisEvent: function (name, testLevel, tags = {}) {
        incrementCountMetric(name, {
          testLevel,
          testFramework,
          isUnsupportedCIProvider: !this.ciProviderName,
          ...tags
        })
      },
      count: function (name, tags, value = 1) {
        incrementCountMetric(name, tags, value)
      },
      distribution: function (name, tags, measure) {
        distributionMetric(name, tags, measure)
      }
    }
  }

  configure (config, shouldGetEnvironmentData = true) {
    super.configure(config)

    if (config.isTestDynamicInstrumentationEnabled && !this.di) {
      const testVisibilityDynamicInstrumentation = require('../ci-visibility/dynamic-instrumentation')
      this.di = testVisibilityDynamicInstrumentation
    }

    if (!shouldGetEnvironmentData) {
      return
    }

    this.testEnvironmentMetadata = getTestEnvironmentMetadata(this.constructor.id, this.config)

    const {
      [GIT_REPOSITORY_URL]: repositoryUrl,
      [GIT_COMMIT_SHA]: sha,
      [OS_VERSION]: osVersion,
      [OS_PLATFORM]: osPlatform,
      [OS_ARCHITECTURE]: osArchitecture,
      [RUNTIME_NAME]: runtimeName,
      [RUNTIME_VERSION]: runtimeVersion,
      [GIT_BRANCH]: branch,
      [CI_PROVIDER_NAME]: ciProviderName,
      [CI_WORKSPACE_PATH]: repositoryRoot
    } = this.testEnvironmentMetadata

    this.repositoryRoot = repositoryRoot || process.cwd()

    this.codeOwnersEntries = getCodeOwnersFileEntries(repositoryRoot)

    this.ciProviderName = ciProviderName

    this.testConfiguration = {
      repositoryUrl,
      sha,
      osVersion,
      osPlatform,
      osArchitecture,
      runtimeName,
      runtimeVersion,
      branch,
      testLevel: 'suite'
    }
  }

  getCodeOwners (tags) {
    const {
      [TEST_SOURCE_FILE]: testSourceFile,
      [TEST_SUITE]: testSuite
    } = tags
    // We'll try with the test source file if available (it could be different from the test suite)
    let codeOwners = getCodeOwnersForFilename(testSourceFile, this.codeOwnersEntries)
    if (!codeOwners) {
      codeOwners = getCodeOwnersForFilename(testSuite, this.codeOwnersEntries)
    }
    return codeOwners
  }

  startTestSpan (testName, testSuite, testSuiteSpan, extraTags = {}) {
    const childOf = getTestParentSpan(this.tracer)

    let testTags = {
      ...getTestCommonTags(
        testName,
        testSuite,
        this.frameworkVersion,
        this.constructor.id
      ),
      [COMPONENT]: this.constructor.id,
      ...extraTags
    }

    const codeOwners = this.getCodeOwners(testTags)
    if (codeOwners) {
      testTags[TEST_CODE_OWNERS] = codeOwners
    }

    if (testSuiteSpan) {
      // This is a hack to get good time resolution on test events, while keeping
      // the test event as the root span of its trace.
      childOf._trace.startTime = testSuiteSpan.context()._trace.startTime
      childOf._trace.ticks = testSuiteSpan.context()._trace.ticks

      const suiteTags = {
        [TEST_SUITE_ID]: testSuiteSpan.context().toSpanId(),
        [TEST_SESSION_ID]: testSuiteSpan.context().toTraceId(),
        [TEST_COMMAND]: testSuiteSpan.context()._tags[TEST_COMMAND],
        [TEST_MODULE]: this.constructor.id
      }
      if (testSuiteSpan.context()._parentId) {
        suiteTags[TEST_MODULE_ID] = testSuiteSpan.context()._parentId.toString(10)
      }

      testTags = {
        ...testTags,
        ...suiteTags
      }
    }

    this.telemetry.ciVisEvent(TELEMETRY_EVENT_CREATED, 'test', { hasCodeOwners: !!codeOwners })

    const testSpan = this.tracer
      .startSpan(`${this.constructor.id}.test`, {
        childOf,
        tags: {
          ...this.testEnvironmentMetadata,
          ...testTags
        }
      })

    testSpan.context()._trace.origin = CI_APP_ORIGIN

    return testSpan
  }

  onDiBreakpointHit ({ snapshot }) {
    if (!this.activeTestSpan || this.activeTestSpan.context()._isFinished) {
      // This is unexpected and is caused by a race condition.
      log.warn('Breakpoint snapshot could not be attached to the active test span')
      return
    }

    const stackIndex = this.testErrorStackIndex

    this.activeTestSpan.setTag(DI_ERROR_DEBUG_INFO_CAPTURED, 'true')
    this.activeTestSpan.setTag(
      `${DI_DEBUG_ERROR_PREFIX}.${stackIndex}.${DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX}`,
      snapshot.id
    )
    this.activeTestSpan.setTag(
      `${DI_DEBUG_ERROR_PREFIX}.${stackIndex}.${DI_DEBUG_ERROR_FILE_SUFFIX}`,
      snapshot.probe.location.file
    )
    this.activeTestSpan.setTag(
      `${DI_DEBUG_ERROR_PREFIX}.${stackIndex}.${DI_DEBUG_ERROR_LINE_SUFFIX}`,
      Number(snapshot.probe.location.lines[0])
    )

    const activeTestSpanContext = this.activeTestSpan.context()

    this.tracer._exporter.exportDiLogs(this.testEnvironmentMetadata, {
      debugger: { snapshot },
      dd: {
        trace_id: activeTestSpanContext.toTraceId(),
        span_id: activeTestSpanContext.toSpanId()
      }
    })
  }

  removeAllDiProbes () {
    if (this.fileLineToProbeId.size === 0) {
      return Promise.resolve()
    }
    log.debug('Removing all Dynamic Instrumentation probes')
    return Promise.all(Array.from(this.fileLineToProbeId.keys())
      .map((fileLine) => {
        const [file, line] = fileLine.split(':')
        return this.removeDiProbe({ file, line })
      }))
  }

  removeDiProbe ({ file, line }) {
    const probeId = this.fileLineToProbeId.get(`${file}:${line}`)
    log.warn(`Removing probe from ${file}:${line}, with id: ${probeId}`)
    this.fileLineToProbeId.delete(probeId)
    return this.di.removeProbe(probeId)
  }

  addDiProbe (err) {
    const [file, line, stackIndex] = getFileAndLineNumberFromError(err, this.repositoryRoot)

    if (!file || !Number.isInteger(line)) {
      log.warn('Could not add breakpoint for dynamic instrumentation')
      return
    }
    log.debug('Adding breakpoint for Dynamic Instrumentation')

    this.testErrorStackIndex = stackIndex
    const activeProbeKey = `${file}:${line}`

    if (this.fileLineToProbeId.has(activeProbeKey)) {
      log.warn('Probe already set for this line')
      const oldProbeId = this.fileLineToProbeId.get(activeProbeKey)
      return {
        probeId: oldProbeId,
        setProbePromise: Promise.resolve(),
        stackIndex,
        file,
        line
      }
    }

    const [probeId, setProbePromise] = this.di.addLineProbe({ file, line }, this.onDiBreakpointHit.bind(this))

    this.fileLineToProbeId.set(activeProbeKey, probeId)

    return {
      probeId,
      setProbePromise,
      stackIndex,
      file,
      line
    }
  }
}
