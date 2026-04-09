'use strict'

const { channel } = require('dc-polyfill')
const {
  getTestEnvironmentMetadata,
  getTestSuitePath,
  getPullRequestDiff,
  getModifiedFilesFromDiff,
  getPullRequestBaseBranch,
  DD_CI_LIBRARY_CONFIGURATION_ERROR,
} = require('../../dd-trace/src/plugins/util/test')
const { isMarkedAsUnskippable } = require('../../datadog-plugin-jest/src/util')
const { getValueFromEnvSources } = require('../../dd-trace/src/config/helper')
const log = require('../../dd-trace/src/log')

const {
  TELEMETRY_ITR_SKIPPED,
  incrementCountMetric,
} = require('../../dd-trace/src/ci-visibility/telemetry')

const {
  GIT_REPOSITORY_URL,
  GIT_COMMIT_SHA,
  GIT_BRANCH,
  CI_PROVIDER_NAME,
  CI_WORKSPACE_PATH,
  GIT_COMMIT_MESSAGE,
  GIT_TAG,
  GIT_PULL_REQUEST_BASE_BRANCH_SHA,
  GIT_COMMIT_HEAD_SHA,
  GIT_PULL_REQUEST_BASE_BRANCH,
  GIT_COMMIT_HEAD_MESSAGE,
} = require('../../dd-trace/src/plugins/util/tags')
const {
  OS_VERSION,
  OS_PLATFORM,
  OS_ARCHITECTURE,
  RUNTIME_NAME,
  RUNTIME_VERSION,
} = require('../../dd-trace/src/plugins/util/env')
const TEST_FRAMEWORK_NAME = 'cypress'

const libraryConfigurationCh = channel(`ci:${TEST_FRAMEWORK_NAME}:library-configuration`)
const knownTestsCh = channel(`ci:${TEST_FRAMEWORK_NAME}:known-tests`)
const skippableSuitesCh = channel(`ci:${TEST_FRAMEWORK_NAME}:test-suite:skippable`)
const testManagementTestsCh = channel(`ci:${TEST_FRAMEWORK_NAME}:test-management-tests`)
const sessionStartCh = channel(`ci:${TEST_FRAMEWORK_NAME}:session:start`)
const testSuiteStartCh = channel(`ci:${TEST_FRAMEWORK_NAME}:test-suite:start`)
const testStartCh = channel(`ci:${TEST_FRAMEWORK_NAME}:test:start`)
const coverageCh = channel(`ci:${TEST_FRAMEWORK_NAME}:coverage`)
const testFinishCh = channel(`ci:${TEST_FRAMEWORK_NAME}:test:finish`)
const afterSpecCh = channel(`ci:${TEST_FRAMEWORK_NAME}:after-spec`)
const sessionFinishCh = channel(`ci:${TEST_FRAMEWORK_NAME}:session:finish`)

function getCypressVersion (details) {
  if (details?.cypressVersion) {
    return details.cypressVersion
  }
  if (details?.config?.version) {
    return details.config.version
  }
  return ''
}

function getRootDir (details) {
  if (details?.config) {
    return details.config.projectRoot || details.config.repoRoot || process.cwd()
  }
  return process.cwd()
}

function getCypressCommand (details) {
  if (!details) {
    return TEST_FRAMEWORK_NAME
  }
  return `${TEST_FRAMEWORK_NAME} ${details.specPattern || ''}`
}

function getIsTestIsolationEnabled (cypressConfig) {
  if (!cypressConfig) {
    return true
  }
  return cypressConfig.testIsolation === undefined ? true : cypressConfig.testIsolation
}

function getModifiedFiles (testEnvironmentMetadata) {
  const {
    [GIT_PULL_REQUEST_BASE_BRANCH]: pullRequestBaseBranch,
    [GIT_PULL_REQUEST_BASE_BRANCH_SHA]: pullRequestBaseBranchSha,
    [GIT_COMMIT_HEAD_SHA]: commitHeadSha,
  } = testEnvironmentMetadata

  const baseBranchSha = pullRequestBaseBranchSha || getPullRequestBaseBranch(pullRequestBaseBranch)

  if (baseBranchSha) {
    const diff = getPullRequestDiff(baseBranchSha, commitHeadSha)
    const modifiedFiles = getModifiedFilesFromDiff(diff)
    if (modifiedFiles) {
      return modifiedFiles
    }
  }

  throw new Error('Modified tests could not be retrieved')
}

class CypressPlugin {
  _isInit = false
  testEnvironmentMetadata = getTestEnvironmentMetadata(TEST_FRAMEWORK_NAME)

  isTestsSkipped = false
  isSuitesSkippingEnabled = false
  isCodeCoverageEnabled = false
  isFlakyTestRetriesEnabled = false
  flakyTestRetriesCount = 0
  isEarlyFlakeDetectionEnabled = false
  isKnownTestsEnabled = false
  earlyFlakeDetectionNumRetries = 0
  testsToSkip = []
  skippedTests = []
  unskippableSuites = []
  knownTests = []
  isTestManagementTestsEnabled = false
  testManagementAttemptToFixRetries = 0
  isImpactedTestsEnabled = false
  modifiedFiles = []

  constructor () {
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
      [CI_WORKSPACE_PATH]: repositoryRoot,
      [GIT_COMMIT_MESSAGE]: commitMessage,
      [GIT_TAG]: tag,
      [GIT_PULL_REQUEST_BASE_BRANCH_SHA]: pullRequestBaseSha,
      [GIT_COMMIT_HEAD_SHA]: commitHeadSha,
      [GIT_COMMIT_HEAD_MESSAGE]: commitHeadMessage,
    } = this.testEnvironmentMetadata

    this.repositoryRoot = repositoryRoot || process.cwd()
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
      testLevel: 'test',
      commitMessage,
      tag,
      pullRequestBaseSha,
      commitHeadSha,
      commitHeadMessage,
    }
  }

  /**
   * Resets state that is scoped to a single Cypress run so the singleton plugin
   * can be reused safely across multiple programmatic cypress.run() calls.
   *
   * @returns {void}
   */
  resetRunState () {
    this._isInit = false
    this.isTestsSkipped = false
    this.isSuitesSkippingEnabled = false
    this.isCodeCoverageEnabled = false
    this.isFlakyTestRetriesEnabled = false
    this.flakyTestRetriesCount = 0
    this.isEarlyFlakeDetectionEnabled = false
    this.isKnownTestsEnabled = false
    this.earlyFlakeDetectionNumRetries = 0
    this.testsToSkip = []
    this.skippedTests = []
    this.unskippableSuites = []
    this.knownTests = []
    this.knownTestsByTestSuite = undefined
    this.isTestManagementTestsEnabled = false
    this.testManagementAttemptToFixRetries = 0
    this.testManagementTests = undefined
    this.isImpactedTestsEnabled = false
    this.modifiedFiles = []
    this.command = undefined
    this.frameworkVersion = undefined
    this.rootDir = undefined
    this.itrCorrelationId = undefined
    this.isTestIsolationEnabled = undefined
    this.rumFlushWaitMillis = undefined
    this._pendingRequestErrorTags = []
    this.libraryConfigurationPromise = undefined
  }

  // Init function returns a promise that resolves with the Cypress configuration.
  // Depending on the received configuration, the Cypress configuration can be modified:
  // for example, to enable retries for failed tests.
  init (cypressConfig) {
    this.resetRunState()
    this._isInit = true
    this.cypressConfig = cypressConfig

    this.isTestIsolationEnabled = getIsTestIsolationEnabled(cypressConfig)

    const envFlushWait = Number(getValueFromEnvSources('DD_CIVISIBILITY_RUM_FLUSH_WAIT_MILLIS'))
    this.rumFlushWaitMillis = Number.isFinite(envFlushWait) ? envFlushWait : undefined

    if (!this.isTestIsolationEnabled) {
      log.warn('Test isolation is disabled, retries will not be enabled')
    }

    this._pendingRequestErrorTags = []
    this.libraryConfigurationPromise = new Promise((resolve) => {
      if (!libraryConfigurationCh.hasSubscribers) {
        return resolve({ err: new Error('Test Optimization was not initialized correctly') })
      }
      libraryConfigurationCh.publish({ onDone: resolve, frameworkVersion: undefined })
    }).then((libraryConfigurationResponse) => {
      if (libraryConfigurationResponse.err) {
        log.error('Cypress plugin library config response error', libraryConfigurationResponse.err)
        this._pendingRequestErrorTags.push({
          tag: DD_CI_LIBRARY_CONFIGURATION_ERROR,
          value: 'true',
        })
      } else {
        const {
          libraryConfig: {
            isSuitesSkippingEnabled,
            isCodeCoverageEnabled,
            isEarlyFlakeDetectionEnabled,
            earlyFlakeDetectionNumRetries,
            isFlakyTestRetriesEnabled,
            flakyTestRetriesCount,
            isKnownTestsEnabled,
            isTestManagementEnabled,
            testManagementAttemptToFixRetries,
            isImpactedTestsEnabled,
          },
        } = libraryConfigurationResponse
        this.isSuitesSkippingEnabled = isSuitesSkippingEnabled
        this.isCodeCoverageEnabled = isCodeCoverageEnabled
        this.isEarlyFlakeDetectionEnabled = isEarlyFlakeDetectionEnabled
        this.earlyFlakeDetectionNumRetries = earlyFlakeDetectionNumRetries
        this.isKnownTestsEnabled = isKnownTestsEnabled
        if (isFlakyTestRetriesEnabled && this.isTestIsolationEnabled) {
          this.isFlakyTestRetriesEnabled = true
          this.flakyTestRetriesCount = flakyTestRetriesCount ?? 0
          this.cypressConfig.retries.runMode = this.flakyTestRetriesCount
        } else {
          this.flakyTestRetriesCount = 0
        }
        this.isTestManagementTestsEnabled = isTestManagementEnabled
        this.testManagementAttemptToFixRetries = testManagementAttemptToFixRetries
        this.isImpactedTestsEnabled = isImpactedTestsEnabled
      }
      return this.cypressConfig
    })
    return this.libraryConfigurationPromise
  }

  getIsTestModified (testSuiteAbsolutePath) {
    const relativeTestSuitePath = getTestSuitePath(testSuiteAbsolutePath, this.repositoryRoot)
    if (!this.modifiedFiles) {
      return false
    }
    const lines = this.modifiedFiles[relativeTestSuitePath]
    if (!lines) {
      return false
    }
    return lines.length > 0
  }

  getTestSuiteProperties (testSuite) {
    return this.testManagementTests?.cypress?.suites?.[testSuite]?.tests || {}
  }

  getTestProperties (testSuite, testName) {
    const { attempt_to_fix: isAttemptToFix, disabled: isDisabled, quarantined: isQuarantined } =
      this.getTestSuiteProperties(testSuite)?.[testName]?.properties || {}

    return { isAttemptToFix, isDisabled, isQuarantined }
  }

  ciVisEvent (name, testLevel, tags = {}) {
    incrementCountMetric(name, {
      testLevel,
      testFramework: TEST_FRAMEWORK_NAME,
      isUnsupportedCIProvider: !this.ciProviderName,
      ...tags,
    })
  }

  async beforeRun (details) {
    // We need to make sure that the plugin is initialized before running the tests.
    // This is for the case where the user has not returned the promise from the init function.
    await this.libraryConfigurationPromise

    this.command = getCypressCommand(details)
    this.frameworkVersion = getCypressVersion(details)
    this.rootDir = getRootDir(details)

    if (this.isKnownTestsEnabled) {
      const knownTestsResponse = await new Promise((resolve) => {
        if (!knownTestsCh.hasSubscribers) {
          return resolve({ err: new Error('Test Optimization was not initialized correctly') })
        }
        knownTestsCh.publish({ onDone: resolve })
      })
      if (knownTestsResponse.err) {
        log.error('Cypress known tests response error', knownTestsResponse.err)
        this.isEarlyFlakeDetectionEnabled = false
        this.isKnownTestsEnabled = false
      } else {
        if (knownTestsResponse.knownTests[TEST_FRAMEWORK_NAME]) {
          this.knownTestsByTestSuite = knownTestsResponse.knownTests[TEST_FRAMEWORK_NAME]
        } else {
          this.isEarlyFlakeDetectionEnabled = false
          this.isKnownTestsEnabled = false
        }
      }
    }

    if (this.isSuitesSkippingEnabled) {
      const skippableTestsResponse = await new Promise((resolve) => {
        if (!skippableSuitesCh.hasSubscribers) {
          return resolve({ err: new Error('Test Optimization was not initialized correctly') })
        }
        skippableSuitesCh.publish({ onDone: resolve })
      })
      if (skippableTestsResponse.err) {
        log.error('Cypress skippable tests response error', skippableTestsResponse.err)
      } else {
        const { skippableSuites, itrCorrelationId } = skippableTestsResponse
        this.testsToSkip = skippableSuites || []
        this.itrCorrelationId = itrCorrelationId
        incrementCountMetric(TELEMETRY_ITR_SKIPPED, { testLevel: 'test' }, this.testsToSkip.length)
      }
    }

    if (this.isTestManagementTestsEnabled) {
      const testManagementTestsResponse = await new Promise((resolve) => {
        if (!testManagementTestsCh.hasSubscribers) {
          return resolve({ err: new Error('Test Optimization was not initialized correctly') })
        }
        testManagementTestsCh.publish({ onDone: resolve })
      })
      if (testManagementTestsResponse.err) {
        log.error('Cypress test management tests response error', testManagementTestsResponse.err)
        this.isTestManagementTestsEnabled = false
      } else {
        this.testManagementTests = testManagementTestsResponse.testManagementTests
      }
    }

    if (this.isImpactedTestsEnabled) {
      try {
        this.modifiedFiles = getModifiedFiles(this.testEnvironmentMetadata)
      } catch (error) {
        log.error(error)
        this.isImpactedTestsEnabled = false
      }
    }

    // `details.specs` are test files
    if (details.specs) {
      for (const { absolute, relative } of details.specs) {
        const isUnskippableSuite = isMarkedAsUnskippable({ path: absolute })
        if (isUnskippableSuite) {
          this.unskippableSuites.push(relative)
        }
      }
    }

    if (sessionStartCh.hasSubscribers) {
      sessionStartCh.publish({
        command: this.command,
        frameworkVersion: this.frameworkVersion,
        rootDir: this.rootDir,
        isEarlyFlakeDetectionEnabled: this.isEarlyFlakeDetectionEnabled,
      })
    }

    return details
  }

  afterRun (suiteStats) {
    if (!this._isInit) {
      log.warn('Attemping to call afterRun without initializating the plugin first')
      return
    }

    return new Promise((resolve) => {
      if (!sessionFinishCh.hasSubscribers) {
        this._isInit = false
        resolve(null)
        return
      }
      sessionFinishCh.publish({
        suiteStats,
        isSuitesSkipped: this.isTestsSkipped,
        isSuitesSkippingEnabled: this.isSuitesSkippingEnabled,
        isCodeCoverageEnabled: this.isCodeCoverageEnabled,
        skippedTestsCount: this.skippedTests.length,
        isTestManagementTestsEnabled: this.isTestManagementTestsEnabled,
        onDone: () => {
          this._isInit = false
          resolve(null)
        },
      })
    })
  }

  afterSpec (spec, results) {
    if (afterSpecCh.hasSubscribers) {
      afterSpecCh.publish({
        spec,
        results,
        itrCorrelationId: this.itrCorrelationId,
        testsToSkip: this.testsToSkip,
        testManagementTests: this.testManagementTests,
      })
    }
  }

  getTasks () {
    return {
      'dd:testSuiteStart': ({ testSuite, testSuiteAbsolutePath }) => {
        const suitePayload = {
          isEarlyFlakeDetectionEnabled: this.isEarlyFlakeDetectionEnabled,
          knownTestsForSuite: this.knownTestsByTestSuite?.[testSuite] || [],
          earlyFlakeDetectionNumRetries: this.earlyFlakeDetectionNumRetries,
          isKnownTestsEnabled: this.isKnownTestsEnabled,
          isTestManagementEnabled: this.isTestManagementTestsEnabled,
          testManagementAttemptToFixRetries: this.testManagementAttemptToFixRetries,
          testManagementTests: this.getTestSuiteProperties(testSuite),
          isImpactedTestsEnabled: this.isImpactedTestsEnabled,
          isModifiedTest: this.getIsTestModified(testSuiteAbsolutePath),
          repositoryRoot: this.repositoryRoot,
          isTestIsolationEnabled: this.isTestIsolationEnabled,
          rumFlushWaitMillis: this.rumFlushWaitMillis,
        }

        if (testSuiteStartCh.hasSubscribers) {
          testSuiteStartCh.publish({ testSuite, testSuiteAbsolutePath })
        }

        return suitePayload
      },
      'dd:beforeEach': (test) => {
        const { testName, testSuite } = test
        const shouldSkip = this.testsToSkip.some(test => {
          return testName === test.name && testSuite === test.suite
        })
        const isUnskippable = this.unskippableSuites.includes(testSuite)
        const isForcedToRun = shouldSkip && isUnskippable
        const { isAttemptToFix, isDisabled, isQuarantined } = this.getTestProperties(testSuite, testName)

        // skip test
        if (shouldSkip && !isUnskippable) {
          this.skippedTests.push(test)
          this.isTestsSkipped = true
          return { shouldSkip: true }
        }

        // For disabled tests (not attemptToFix), skip them
        if (!isAttemptToFix && isDisabled) {
          return { shouldSkip: true }
        }
        // Quarantined tests (not attemptToFix) run normally but their failures are caught
        // by Cypress.on('fail') in support.js and suppressed, so Cypress sees them as passed

        if (!testStartCh.hasSubscribers) {
          return {}
        }

        const testSourceFile = test.testSuiteAbsolutePath && this.repositoryRoot
          ? getTestSuitePath(test.testSuiteAbsolutePath, this.repositoryRoot)
          : testSuite

        const ctx = {
          testName,
          testSuite,
          isUnskippable,
          isForcedToRun,
          isDisabled,
          isQuarantined,
          testSourceFile,
        }
        testStartCh.publish(ctx)

        return ctx.traceId ? { traceId: ctx.traceId } : {}
      },
      'dd:afterEach': ({ test, coverage }) => {
        const { testSuiteAbsolutePath } = test

        if (coverage && this.isCodeCoverageEnabled && coverageCh.hasSubscribers) {
          coverageCh.publish({
            coverage,
            testSuiteAbsolutePath,
            repositoryRoot: this.repositoryRoot,
            rootDir: this.rootDir,
          })
        }

        if (testFinishCh.hasSubscribers) {
          testFinishCh.publish({
            test,
            itrCorrelationId: this.itrCorrelationId,
            earlyFlakeDetectionNumRetries: this.earlyFlakeDetectionNumRetries,
            isFlakyTestRetriesEnabled: this.isFlakyTestRetriesEnabled,
            flakyTestRetriesCount: this.flakyTestRetriesCount,
            testManagementAttemptToFixRetries: this.testManagementAttemptToFixRetries,
          })
        }

        return null
      },
      'dd:addTags': (tags) => {
        // Tags are forwarded to the active test span via the support file channel;
        // CypressCiPlugin handles the actual span tag setting.
        // We publish a dedicated channel for this so the plugin can handle it.
        // For now, if no subscribers exist this is a no-op (backward compatible).
        const addTagsCh = channel(`ci:${TEST_FRAMEWORK_NAME}:test:add-tags`)
        if (addTagsCh.hasSubscribers) {
          addTagsCh.publish(tags)
        }
        return null
      },
      'dd:log': (message) => {
        // eslint-disable-next-line no-console
        console.log(`[datadog] ${message}`)
        return null
      },
    }
  }
}

module.exports = new CypressPlugin()
