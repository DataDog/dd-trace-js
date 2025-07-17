'use strict'

const path = require('path')
const fs = require('fs')
const { URL } = require('url')
const log = require('../../log')
const { getEnvironmentVariable } = require('../../config-helper')
const satisfies = require('semifies')

const istanbul = require('istanbul-lib-coverage')
const ignore = require('ignore')

const {
  getGitMetadata,
  getGitInformationDiscrepancy,
  getGitDiff,
  getGitRemoteName,
  getSourceBranch,
  checkAndFetchBranch,
  getLocalBranches,
  getMergeBase,
  getCounts
} = require('./git')
const { getUserProviderGitMetadata, validateGitRepositoryUrl, validateGitCommitSha } = require('./user-provided-git')
const { getCIMetadata } = require('./ci')
const { getRuntimeAndOSMetadata } = require('./env')
const {
  GIT_BRANCH,
  GIT_COMMIT_SHA,
  GIT_REPOSITORY_URL,
  GIT_TAG,
  GIT_COMMIT_AUTHOR_EMAIL,
  GIT_COMMIT_AUTHOR_NAME,
  GIT_COMMIT_MESSAGE,
  CI_WORKSPACE_PATH,
  CI_PIPELINE_URL,
  CI_JOB_NAME,
  GIT_COMMIT_HEAD_SHA
} = require('./tags')
const id = require('../../id')
const {
  incrementCountMetric,
  TELEMETRY_GIT_COMMIT_SHA_DISCREPANCY,
  TELEMETRY_GIT_SHA_MATCH
} = require('../../ci-visibility/telemetry')

const { SPAN_TYPE, RESOURCE_NAME, SAMPLING_PRIORITY } = require('../../../../../ext/tags')
const { SAMPLING_RULE_DECISION } = require('../../constants')
const { AUTO_KEEP } = require('../../../../../ext/priority')
const { version: ddTraceVersion } = require('../../../../../package.json')

// session tags
const TEST_SESSION_NAME = 'test_session.name'

const TEST_FRAMEWORK = 'test.framework'
const TEST_FRAMEWORK_VERSION = 'test.framework_version'
const TEST_TYPE = 'test.type'
const TEST_NAME = 'test.name'
const TEST_SUITE = 'test.suite'
const TEST_STATUS = 'test.status'
const TEST_PARAMETERS = 'test.parameters'
const TEST_SKIP_REASON = 'test.skip_reason'
const TEST_IS_RUM_ACTIVE = 'test.is_rum_active'
const TEST_CODE_OWNERS = 'test.codeowners'
const TEST_SOURCE_FILE = 'test.source.file'
const TEST_SOURCE_START = 'test.source.start'
const LIBRARY_VERSION = 'library_version'
const TEST_COMMAND = 'test.command'
const TEST_MODULE = 'test.module'
const TEST_SESSION_ID = 'test_session_id'
const TEST_MODULE_ID = 'test_module_id'
const TEST_SUITE_ID = 'test_suite_id'
const TEST_TOOLCHAIN = 'test.toolchain'
const TEST_SKIPPED_BY_ITR = 'test.skipped_by_itr'
// Early flake detection
const TEST_IS_NEW = 'test.is_new'
const TEST_IS_RETRY = 'test.is_retry'
const TEST_EARLY_FLAKE_ENABLED = 'test.early_flake.enabled'
const TEST_EARLY_FLAKE_ABORT_REASON = 'test.early_flake.abort_reason'
const TEST_RETRY_REASON = 'test.retry_reason'
const TEST_HAS_FAILED_ALL_RETRIES = 'test.has_failed_all_retries'
const TEST_IS_MODIFIED = 'test.is_modified'
const CI_APP_ORIGIN = 'ciapp-test'

const JEST_TEST_RUNNER = 'test.jest.test_runner'
const JEST_DISPLAY_NAME = 'test.jest.display_name'

const CUCUMBER_IS_PARALLEL = 'test.cucumber.is_parallel'
const MOCHA_IS_PARALLEL = 'test.mocha.is_parallel'

const TEST_ITR_TESTS_SKIPPED = '_dd.ci.itr.tests_skipped'
const TEST_ITR_SKIPPING_ENABLED = 'test.itr.tests_skipping.enabled'
const TEST_ITR_SKIPPING_TYPE = 'test.itr.tests_skipping.type'
const TEST_ITR_SKIPPING_COUNT = 'test.itr.tests_skipping.count'
const TEST_CODE_COVERAGE_ENABLED = 'test.code_coverage.enabled'
const TEST_ITR_UNSKIPPABLE = 'test.itr.unskippable'
const TEST_ITR_FORCED_RUN = 'test.itr.forced_run'
const ITR_CORRELATION_ID = 'itr_correlation_id'

const TEST_CODE_COVERAGE_LINES_PCT = 'test.code_coverage.lines_pct'

// selenium tags
const TEST_BROWSER_DRIVER = 'test.browser.driver'
const TEST_BROWSER_DRIVER_VERSION = 'test.browser.driver_version'
const TEST_BROWSER_NAME = 'test.browser.name'
const TEST_BROWSER_VERSION = 'test.browser.version'

// jest worker variables
const JEST_WORKER_TRACE_PAYLOAD_CODE = 60
const JEST_WORKER_COVERAGE_PAYLOAD_CODE = 61
const JEST_WORKER_LOGS_PAYLOAD_CODE = 62

// cucumber worker variables
const CUCUMBER_WORKER_TRACE_PAYLOAD_CODE = 70

// mocha worker variables
const MOCHA_WORKER_TRACE_PAYLOAD_CODE = 80

// playwright worker variables
const PLAYWRIGHT_WORKER_TRACE_PAYLOAD_CODE = 90

// Early flake detection util strings
const EFD_STRING = "Retried by Datadog's Early Flake Detection"
const EFD_TEST_NAME_REGEX = new RegExp(EFD_STRING + String.raw` \(#\d+\): `, 'g')

// Library Capabilities Tagging
const DD_CAPABILITIES_TEST_IMPACT_ANALYSIS = '_dd.library_capabilities.test_impact_analysis'
const DD_CAPABILITIES_EARLY_FLAKE_DETECTION = '_dd.library_capabilities.early_flake_detection'
const DD_CAPABILITIES_AUTO_TEST_RETRIES = '_dd.library_capabilities.auto_test_retries'
const DD_CAPABILITIES_IMPACTED_TESTS = '_dd.library_capabilities.impacted_tests'
const DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE = '_dd.library_capabilities.test_management.quarantine'
const DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE = '_dd.library_capabilities.test_management.disable'
const DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX = '_dd.library_capabilities.test_management.attempt_to_fix'
const DD_CAPABILITIES_FAILED_TEST_REPLAY = '_dd.library_capabilities.failed_test_replay'
const UNSUPPORTED_TIA_FRAMEWORKS = new Set(['playwright', 'vitest'])
const UNSUPPORTED_TIA_FRAMEWORKS_PARALLEL_MODE = new Set(['cucumber', 'mocha'])
const MINIMUM_FRAMEWORK_VERSION_FOR_EFD = {
  playwright: '>=1.38.0'
}
const MINIMUM_FRAMEWORK_VERSION_FOR_IMPACTED_TESTS = {
  playwright: '>=1.38.0'
}
const MINIMUM_FRAMEWORK_VERSION_FOR_QUARANTINE = {
  playwright: '>=1.38.0'
}
const MINIMUM_FRAMEWORK_VERSION_FOR_DISABLE = {
  playwright: '>=1.38.0'
}
const MINIMUM_FRAMEWORK_VERSION_FOR_ATTEMPT_TO_FIX = {
  playwright: '>=1.38.0'
}
const MINIMUM_FRAMEWORK_VERSION_FOR_FAILED_TEST_REPLAY = {
  playwright: '>=1.38.0'
}

const UNSUPPORTED_ATTEMPT_TO_FIX_FRAMEWORKS_PARALLEL_MODE = new Set(['mocha'])
const NOT_SUPPORTED_GRANULARITY_IMPACTED_TESTS_FRAMEWORKS = new Set(['mocha', 'playwright', 'vitest'])

const TEST_LEVEL_EVENT_TYPES = [
  'test',
  'test_suite_end',
  'test_module_end',
  'test_session_end'
]
const TEST_RETRY_REASON_TYPES = {
  efd: 'early_flake_detection',
  atr: 'auto_test_retry',
  atf: 'attempt_to_fix',
  ext: 'external'
}

const DD_TEST_IS_USER_PROVIDED_SERVICE = '_dd.test.is_user_provided_service'

// Dynamic instrumentation - Test optimization integration tags
const DI_ERROR_DEBUG_INFO_CAPTURED = 'error.debug_info_captured'
const DI_DEBUG_ERROR_PREFIX = '_dd.debug.error'
const DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX = 'snapshot_id'
const DI_DEBUG_ERROR_FILE_SUFFIX = 'file'
const DI_DEBUG_ERROR_LINE_SUFFIX = 'line'

// Test Management tags
const TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX = 'test.test_management.is_attempt_to_fix'
const TEST_MANAGEMENT_IS_DISABLED = 'test.test_management.is_test_disabled'
const TEST_MANAGEMENT_IS_QUARANTINED = 'test.test_management.is_quarantined'
const TEST_MANAGEMENT_ENABLED = 'test.test_management.enabled'
const TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED = 'test.test_management.attempt_to_fix_passed'

// Test Management utils strings
const ATTEMPT_TO_FIX_STRING = "Retried by Datadog's Test Management"
const ATTEMPT_TEST_NAME_REGEX = new RegExp(ATTEMPT_TO_FIX_STRING + String.raw` \(#\d+\): `, 'g')

// Impacted tests
const POSSIBLE_BASE_BRANCHES = ['main', 'master', 'preprod', 'prod', 'dev', 'development', 'trunk']
const BASE_LIKE_BRANCH_FILTER = /^(main|master|preprod|prod|dev|development|trunk|release\/.*|hotfix\/.*)$/

module.exports = {
  TEST_CODE_OWNERS,
  TEST_SESSION_NAME,
  TEST_FRAMEWORK,
  TEST_FRAMEWORK_VERSION,
  JEST_TEST_RUNNER,
  JEST_DISPLAY_NAME,
  CUCUMBER_IS_PARALLEL,
  MOCHA_IS_PARALLEL,
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_STATUS,
  TEST_PARAMETERS,
  TEST_SKIP_REASON,
  TEST_IS_RUM_ACTIVE,
  TEST_SOURCE_FILE,
  CI_APP_ORIGIN,
  LIBRARY_VERSION,
  JEST_WORKER_TRACE_PAYLOAD_CODE,
  JEST_WORKER_COVERAGE_PAYLOAD_CODE,
  JEST_WORKER_LOGS_PAYLOAD_CODE,
  CUCUMBER_WORKER_TRACE_PAYLOAD_CODE,
  MOCHA_WORKER_TRACE_PAYLOAD_CODE,
  PLAYWRIGHT_WORKER_TRACE_PAYLOAD_CODE,
  TEST_SOURCE_START,
  TEST_SKIPPED_BY_ITR,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_EARLY_FLAKE_ABORT_REASON,
  TEST_RETRY_REASON,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_IS_MODIFIED,
  getTestEnvironmentMetadata,
  getTestParametersString,
  finishAllTraceSpans,
  getTestParentSpan,
  getTestSuitePath,
  getCodeOwnersFileEntries,
  getCodeOwnersForFilename,
  getTestCommonTags,
  getTestSessionCommonTags,
  getTestModuleCommonTags,
  getTestSuiteCommonTags,
  TEST_COMMAND,
  TEST_TOOLCHAIN,
  TEST_SESSION_ID,
  TEST_MODULE_ID,
  TEST_SUITE_ID,
  TEST_ITR_TESTS_SKIPPED,
  TEST_MODULE,
  TEST_ITR_SKIPPING_ENABLED,
  TEST_ITR_SKIPPING_TYPE,
  TEST_ITR_SKIPPING_COUNT,
  TEST_CODE_COVERAGE_ENABLED,
  TEST_CODE_COVERAGE_LINES_PCT,
  TEST_ITR_UNSKIPPABLE,
  TEST_ITR_FORCED_RUN,
  ITR_CORRELATION_ID,
  addIntelligentTestRunnerSpanTags,
  getCoveredFilenamesFromCoverage,
  resetCoverage,
  mergeCoverage,
  fromCoverageMapToCoverage,
  getTestLineStart,
  getTestEndLine,
  removeInvalidMetadata,
  parseAnnotations,
  EFD_STRING,
  EFD_TEST_NAME_REGEX,
  removeEfdStringFromTestName,
  removeAttemptToFixStringFromTestName,
  addEfdStringToTestName,
  addAttemptToFixStringToTestName,
  getIsFaultyEarlyFlakeDetection,
  TEST_BROWSER_DRIVER,
  TEST_BROWSER_DRIVER_VERSION,
  TEST_BROWSER_NAME,
  TEST_BROWSER_VERSION,
  getTestSessionName,
  DD_CAPABILITIES_TEST_IMPACT_ANALYSIS,
  DD_CAPABILITIES_EARLY_FLAKE_DETECTION,
  DD_CAPABILITIES_AUTO_TEST_RETRIES,
  DD_CAPABILITIES_IMPACTED_TESTS,
  DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE,
  DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE,
  DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX,
  DD_CAPABILITIES_FAILED_TEST_REPLAY,
  TEST_LEVEL_EVENT_TYPES,
  TEST_RETRY_REASON_TYPES,
  getNumFromKnownTests,
  getFileAndLineNumberFromError,
  DI_ERROR_DEBUG_INFO_CAPTURED,
  DI_DEBUG_ERROR_PREFIX,
  DI_DEBUG_ERROR_SNAPSHOT_ID_SUFFIX,
  DI_DEBUG_ERROR_FILE_SUFFIX,
  DI_DEBUG_ERROR_LINE_SUFFIX,
  getFormattedError,
  DD_TEST_IS_USER_PROVIDED_SERVICE,
  TEST_MANAGEMENT_IS_ATTEMPT_TO_FIX,
  TEST_MANAGEMENT_IS_DISABLED,
  TEST_MANAGEMENT_IS_QUARANTINED,
  TEST_MANAGEMENT_ENABLED,
  TEST_MANAGEMENT_ATTEMPT_TO_FIX_PASSED,
  getLibraryCapabilitiesTags,
  checkShaDiscrepancies,
  getPullRequestDiff,
  getPullRequestBaseBranch,
  getModifiedTestsFromDiff,
  isModifiedTest,
  POSSIBLE_BASE_BRANCHES
}

// Returns pkg manager and its version, separated by '-', e.g. npm-8.15.0 or yarn-1.22.19
function getPkgManager () {
  try {
    return getEnvironmentVariable('npm_config_user_agent').split(' ')[0].replace('/', '-')
  } catch {
    return ''
  }
}

function validateUrl (url) {
  try {
    const urlObject = new URL(url)
    return (urlObject.protocol === 'https:' || urlObject.protocol === 'http:')
  } catch {
    return false
  }
}

function removeInvalidMetadata (metadata) {
  return Object.keys(metadata).reduce((filteredTags, tag) => {
    if (tag === GIT_REPOSITORY_URL && !validateGitRepositoryUrl(metadata[GIT_REPOSITORY_URL])) {
      log.error('Repository URL is not a valid repository URL: %s.', metadata[GIT_REPOSITORY_URL])
      return filteredTags
    }
    if (tag === GIT_COMMIT_SHA && !validateGitCommitSha(metadata[GIT_COMMIT_SHA])) {
      log.error('Git commit SHA must be a full-length git SHA: %s.', metadata[GIT_COMMIT_SHA])
      return filteredTags
    }
    if (tag === CI_PIPELINE_URL && !validateUrl(metadata[CI_PIPELINE_URL])) {
      return filteredTags
    }
    filteredTags[tag] = metadata[tag]
    return filteredTags
  }, {})
}

function checkShaDiscrepancies (ciMetadata, userProvidedGitMetadata) {
  const {
    [GIT_COMMIT_SHA]: ciCommitSHA,
    [GIT_REPOSITORY_URL]: ciRepositoryUrl
  } = ciMetadata
  const {
    [GIT_COMMIT_SHA]: userProvidedCommitSHA,
    [GIT_REPOSITORY_URL]: userProvidedRepositoryUrl
  } = userProvidedGitMetadata
  const { gitRepositoryUrl, gitCommitSHA } = getGitInformationDiscrepancy()

  const checkDiscrepancyAndSendMetrics = (
    valueExpected,
    valueDiscrepant,
    discrepancyType,
    expectedProvider,
    discrepantProvider
  ) => {
    if (valueExpected && valueDiscrepant && valueExpected !== valueDiscrepant) {
      incrementCountMetric(
        TELEMETRY_GIT_COMMIT_SHA_DISCREPANCY,
        {
          type: discrepancyType,
          expected_provider: expectedProvider,
          discrepant_provider: discrepantProvider
        }
      )
      return true
    }
    return false
  }

  const checkConfigs = [
    // User provided vs Git metadata
    {
      v1: userProvidedRepositoryUrl,
      v2: gitRepositoryUrl,
      type: 'repository_discrepancy',
      expected: 'user_supplied',
      discrepant: 'git_client'
    },
    {
      v1: userProvidedCommitSHA,
      v2: gitCommitSHA,
      type: 'commit_discrepancy',
      expected: 'user_supplied',
      discrepant: 'git_client'
    },
    // User provided vs CI metadata
    {
      v1: userProvidedRepositoryUrl,
      v2: ciRepositoryUrl,
      type: 'repository_discrepancy',
      expected: 'user_supplied',
      discrepant: 'ci_provider'
    },
    {
      v1: userProvidedCommitSHA,
      v2: ciCommitSHA,
      type: 'commit_discrepancy',
      expected: 'user_supplied',
      discrepant: 'ci_provider'
    },
    // CI metadata vs Git metadata
    {
      v1: ciRepositoryUrl,
      v2: gitRepositoryUrl,
      type: 'repository_discrepancy',
      expected: 'ci_provider',
      discrepant: 'git_client'
    },
    {
      v1: ciCommitSHA,
      v2: gitCommitSHA,
      type: 'commit_discrepancy',
      expected: 'ci_provider',
      discrepant: 'git_client'
    }
  ]

  let gitCommitShaMatch = true
  for (const checkConfig of checkConfigs) {
    const { v1, v2, type, expected, discrepant } = checkConfig
    const discrepancy = checkDiscrepancyAndSendMetrics(v1, v2, type, expected, discrepant)
    if (discrepancy) {
      gitCommitShaMatch = false
    }
  }

  incrementCountMetric(
    TELEMETRY_GIT_SHA_MATCH,
    { matched: gitCommitShaMatch }
  )
}

function getTestEnvironmentMetadata (testFramework, config) {
  // TODO: eventually these will come from the tracer (generally available)
  const ciMetadata = getCIMetadata()
  const {
    [GIT_COMMIT_SHA]: commitSHA,
    [GIT_BRANCH]: branch,
    [GIT_REPOSITORY_URL]: repositoryUrl,
    [GIT_TAG]: tag,
    [GIT_COMMIT_AUTHOR_NAME]: authorName,
    [GIT_COMMIT_AUTHOR_EMAIL]: authorEmail,
    [GIT_COMMIT_MESSAGE]: commitMessage,
    [CI_WORKSPACE_PATH]: ciWorkspacePath,
    [GIT_COMMIT_HEAD_SHA]: headCommitSha
  } = ciMetadata

  const gitMetadata = getGitMetadata({
    commitSHA,
    branch,
    repositoryUrl,
    tag,
    authorName,
    authorEmail,
    commitMessage,
    ciWorkspacePath,
    headCommitSha
  })

  const userProvidedGitMetadata = getUserProviderGitMetadata()

  checkShaDiscrepancies(ciMetadata, userProvidedGitMetadata)

  const runtimeAndOSMetadata = getRuntimeAndOSMetadata()

  const metadata = {
    [TEST_FRAMEWORK]: testFramework,
    [DD_TEST_IS_USER_PROVIDED_SERVICE]: (config && config.isServiceUserProvided) ? 'true' : 'false',
    ...gitMetadata,
    ...ciMetadata,
    ...userProvidedGitMetadata,
    ...runtimeAndOSMetadata
  }
  if (config && config.service) {
    metadata['service.name'] = config.service
  }
  return removeInvalidMetadata(metadata)
}

function getTestParametersString (parametersByTestName, testName) {
  if (!parametersByTestName[testName]) {
    return ''
  }
  try {
    // test is invoked with each parameter set sequencially
    const testParameters = parametersByTestName[testName].shift()
    return JSON.stringify({ arguments: testParameters, metadata: {} })
  } catch {
    // We can't afford to interrupt the test if `testParameters` is not serializable to JSON,
    // so we ignore the test parameters and move on
    return ''
  }
}

function getTestTypeFromFramework (testFramework) {
  if (testFramework === 'playwright' || testFramework === 'cypress') {
    return 'browser'
  }
  return 'test'
}

function finishAllTraceSpans (span) {
  span.context()._trace.started.forEach(traceSpan => {
    if (traceSpan !== span) {
      traceSpan.finish()
    }
  })
}

function getTestParentSpan (tracer) {
  return tracer.extract('text_map', {
    'x-datadog-trace-id': id().toString(10),
    'x-datadog-parent-id': '0000000000000000'
  })
}

function getTestCommonTags (name, suite, version, testFramework) {
  return {
    [SPAN_TYPE]: 'test',
    [TEST_TYPE]: getTestTypeFromFramework(testFramework),
    [SAMPLING_RULE_DECISION]: 1,
    [SAMPLING_PRIORITY]: AUTO_KEEP,
    [TEST_NAME]: name,
    [TEST_SUITE]: suite,
    [RESOURCE_NAME]: `${suite}.${name}`,
    [TEST_FRAMEWORK_VERSION]: version,
    [LIBRARY_VERSION]: ddTraceVersion
  }
}

/**
 * We want to make sure that test suites are reported the same way for
 * every OS, so we replace `path.sep` by `/`
 */
function getTestSuitePath (testSuiteAbsolutePath, sourceRoot) {
  if (!testSuiteAbsolutePath) {
    return sourceRoot
  }
  const testSuitePath = testSuiteAbsolutePath === sourceRoot
    ? testSuiteAbsolutePath
    : path.relative(sourceRoot, testSuiteAbsolutePath)

  return testSuitePath.replace(path.sep, '/')
}

const POSSIBLE_CODEOWNERS_LOCATIONS = [
  'CODEOWNERS',
  '.github/CODEOWNERS',
  'docs/CODEOWNERS',
  '.gitlab/CODEOWNERS'
]

function readCodeOwners (rootDir) {
  for (const location of POSSIBLE_CODEOWNERS_LOCATIONS) {
    try {
      return fs.readFileSync(path.join(rootDir, location)).toString()
    } catch {
      // retry with next path
    }
  }
  return ''
}

function getCodeOwnersFileEntries (rootDir) {
  let codeOwnersContent
  let usedRootDir = rootDir
  let isTriedCwd = false

  const processCwd = process.cwd()

  if (!usedRootDir || usedRootDir === processCwd) {
    usedRootDir = processCwd
    isTriedCwd = true
  }

  codeOwnersContent = readCodeOwners(usedRootDir)

  // If we haven't found CODEOWNERS in the provided root dir, we try with process.cwd()
  if (!codeOwnersContent && !isTriedCwd) {
    codeOwnersContent = readCodeOwners(processCwd)
  }

  if (!codeOwnersContent) {
    return null
  }

  const entries = []
  const lines = codeOwnersContent.split('\n')

  for (const line of lines) {
    const [content] = line.split('#')
    const trimmed = content.trim()
    if (trimmed === '') continue
    const [pattern, ...owners] = trimmed.split(/\s+/)
    entries.push({ pattern, owners })
  }
  // Reverse because rules defined last take precedence
  return entries.reverse()
}

function getCodeOwnersForFilename (filename, entries) {
  if (!entries) {
    return null
  }
  for (const entry of entries) {
    try {
      const isResponsible = ignore().add(entry.pattern).ignores(filename)
      if (isResponsible) {
        return JSON.stringify(entry.owners)
      }
    } catch {
      return null
    }
  }
  return null
}

function getTestLevelCommonTags (command, testFrameworkVersion, testFramework) {
  return {
    [TEST_FRAMEWORK_VERSION]: testFrameworkVersion,
    [LIBRARY_VERSION]: ddTraceVersion,
    [TEST_COMMAND]: command,
    [TEST_TYPE]: getTestTypeFromFramework(testFramework)
  }
}

function getTestSessionCommonTags (command, testFrameworkVersion, testFramework) {
  return {
    [SPAN_TYPE]: 'test_session_end',
    [RESOURCE_NAME]: `test_session.${command}`,
    [TEST_MODULE]: testFramework,
    [TEST_TOOLCHAIN]: getPkgManager(),
    ...getTestLevelCommonTags(command, testFrameworkVersion, testFramework)
  }
}

function getTestModuleCommonTags (command, testFrameworkVersion, testFramework) {
  return {
    [SPAN_TYPE]: 'test_module_end',
    [RESOURCE_NAME]: `test_module.${command}`,
    [TEST_MODULE]: testFramework,
    ...getTestLevelCommonTags(command, testFrameworkVersion, testFramework)
  }
}

function getTestSuiteCommonTags (command, testFrameworkVersion, testSuite, testFramework) {
  return {
    [SPAN_TYPE]: 'test_suite_end',
    [RESOURCE_NAME]: `test_suite.${testSuite}`,
    [TEST_MODULE]: testFramework,
    [TEST_SUITE]: testSuite,
    ...getTestLevelCommonTags(command, testFrameworkVersion, testFramework)
  }
}

function addIntelligentTestRunnerSpanTags (
  testSessionSpan,
  testModuleSpan,
  {
    isSuitesSkipped,
    isSuitesSkippingEnabled,
    isCodeCoverageEnabled,
    testCodeCoverageLinesTotal,
    skippingCount,
    skippingType = 'suite',
    hasUnskippableSuites,
    hasForcedToRunSuites
  }
) {
  testSessionSpan.setTag(TEST_ITR_TESTS_SKIPPED, isSuitesSkipped ? 'true' : 'false')
  testSessionSpan.setTag(TEST_ITR_SKIPPING_ENABLED, isSuitesSkippingEnabled ? 'true' : 'false')
  testSessionSpan.setTag(TEST_ITR_SKIPPING_TYPE, skippingType)
  testSessionSpan.setTag(TEST_ITR_SKIPPING_COUNT, skippingCount)
  testSessionSpan.setTag(TEST_CODE_COVERAGE_ENABLED, isCodeCoverageEnabled ? 'true' : 'false')

  testModuleSpan.setTag(TEST_ITR_TESTS_SKIPPED, isSuitesSkipped ? 'true' : 'false')
  testModuleSpan.setTag(TEST_ITR_SKIPPING_ENABLED, isSuitesSkippingEnabled ? 'true' : 'false')
  testModuleSpan.setTag(TEST_ITR_SKIPPING_TYPE, skippingType)
  testModuleSpan.setTag(TEST_ITR_SKIPPING_COUNT, skippingCount)
  testModuleSpan.setTag(TEST_CODE_COVERAGE_ENABLED, isCodeCoverageEnabled ? 'true' : 'false')

  if (hasUnskippableSuites) {
    testSessionSpan.setTag(TEST_ITR_UNSKIPPABLE, 'true')
    testModuleSpan.setTag(TEST_ITR_UNSKIPPABLE, 'true')
  }
  if (hasForcedToRunSuites) {
    testSessionSpan.setTag(TEST_ITR_FORCED_RUN, 'true')
    testModuleSpan.setTag(TEST_ITR_FORCED_RUN, 'true')
  }

  // This will not be reported unless the user has manually added code coverage.
  // This is always the case for Mocha and Cucumber, but not for Jest.
  if (testCodeCoverageLinesTotal !== undefined) {
    testSessionSpan.setTag(TEST_CODE_COVERAGE_LINES_PCT, testCodeCoverageLinesTotal)
    testModuleSpan.setTag(TEST_CODE_COVERAGE_LINES_PCT, testCodeCoverageLinesTotal)
  }
}

function getCoveredFilenamesFromCoverage (coverage) {
  const coverageMap = istanbul.createCoverageMap(coverage)

  return coverageMap
    .files()
    .filter(filename => {
      const fileCoverage = coverageMap.fileCoverageFor(filename)
      const lineCoverage = fileCoverage.getLineCoverage()
      const isAnyLineExecuted = Object.entries(lineCoverage).some(([, numExecutions]) => !!numExecutions)

      return isAnyLineExecuted
    })
}

function resetCoverage (coverage) {
  const coverageMap = istanbul.createCoverageMap(coverage)

  return coverageMap
    .files()
    .forEach(filename => {
      const fileCoverage = coverageMap.fileCoverageFor(filename)
      fileCoverage.resetHits()
    })
}

function mergeCoverage (coverage, targetCoverage) {
  const coverageMap = istanbul.createCoverageMap(coverage)
  return coverageMap
    .files()
    .forEach(filename => {
      const fileCoverage = coverageMap.fileCoverageFor(filename)

      // If the fileCoverage is not there for this filename,
      // we create it to force a merge between the fileCoverages
      // instead of a reference assignment (which would not work if the coverage is reset later on)
      if (!targetCoverage.data[filename]) {
        targetCoverage.addFileCoverage(istanbul.createFileCoverage(filename))
      }
      targetCoverage.addFileCoverage(fileCoverage)
      const targetFileCoverage = targetCoverage.fileCoverageFor(filename)

      // branches (.b) are copied by reference, so `resetHits` affects the copy, so we need to copy it manually
      Object.entries(targetFileCoverage.data.b).forEach(([key, value]) => {
        targetFileCoverage.data.b[key] = [...value]
      })
    })
}

function fromCoverageMapToCoverage (coverageMap) {
  return Object.entries(coverageMap.data).reduce((acc, [filename, fileCoverage]) => {
    acc[filename] = fileCoverage.data
    return acc
  }, {})
}

// Get the start line of a test by inspecting a given error's stack trace
function getTestLineStart (err, testSuitePath) {
  if (!err.stack) {
    return null
  }
  // From https://github.com/felixge/node-stack-trace/blob/ba06dcdb50d465cd440d84a563836e293b360427/index.js#L40
  const testFileLine = err.stack.split('\n').find(line => line.includes(testSuitePath))
  try {
    const testFileLineMatch = testFileLine.match(/at (?:(.+?)\s+\()?(?:(.+?):(\d+)(?::(\d+))?|([^)]+))\)?/)
    return Number.parseInt(testFileLineMatch[3], 10) || null
  } catch {
    return null
  }
}

// Get the end line of a test by inspecting a given function's source code
function getTestEndLine (testFn, startLine = 0) {
  const source = testFn.toString()
  const lineCount = source.split('\n').length
  return startLine + lineCount - 1
}

/**
 * Gets an object of test tags from an Playwright annotations array.
 * @param {Object[]} annotations - Annotations from a Playwright test.
 * @param {string} annotations[].type - Type of annotation. A string of the shape DD_TAGS[$tag_name].
 * @param {string} annotations[].description - Value of the tag.
 */
function parseAnnotations (annotations) {
  return annotations.reduce((tags, annotation) => {
    if (!annotation?.type) {
      return tags
    }
    const { type, description } = annotation
    if (type.startsWith('DD_TAGS')) {
      const regex = /\[(.*?)\]/
      const match = regex.exec(type)
      let tagValue = ''
      if (match) {
        tagValue = match[1]
      }
      if (tagValue) {
        tags[tagValue] = description
      }
    }
    return tags
  }, {})
}

function addEfdStringToTestName (testName, numAttempt) {
  return `${EFD_STRING} (#${numAttempt}): ${testName}`
}

function addAttemptToFixStringToTestName (testName, numAttempt) {
  return `${ATTEMPT_TO_FIX_STRING} (#${numAttempt}): ${testName}`
}

function removeEfdStringFromTestName (testName) {
  return testName.replaceAll(EFD_TEST_NAME_REGEX, '')
}

function removeAttemptToFixStringFromTestName (testName) {
  return testName.replaceAll(ATTEMPT_TEST_NAME_REGEX, '')
}

function getIsFaultyEarlyFlakeDetection (projectSuites, testsBySuiteName, faultyThresholdPercentage) {
  let newSuites = 0
  for (const suite of projectSuites) {
    if (!testsBySuiteName[suite]) {
      newSuites++
    }
  }
  const newSuitesPercentage = (newSuites / projectSuites.length) * 100

  // The faulty threshold represents a percentage, but we also want to consider
  // smaller projects, where big variations in the % are more likely.
  // This is why we also check the absolute number of new suites.
  return (
    newSuites > faultyThresholdPercentage &&
    newSuitesPercentage > faultyThresholdPercentage
  )
}

function getTestSessionName (config, trimmedCommand, envTags) {
  if (config.ciVisibilityTestSessionName) {
    return config.ciVisibilityTestSessionName
  }
  if (envTags[CI_JOB_NAME]) {
    return `${envTags[CI_JOB_NAME]}-${trimmedCommand}`
  }
  return trimmedCommand
}

// Calculate the number of a tests from the known tests response, which has a shape like:
// { testModule1: { testSuite1: [test1, test2, test3] }, testModule2: { testSuite2: [test4, test5] } }
function getNumFromKnownTests (knownTests) {
  if (!knownTests) {
    return 0
  }

  let totalNumTests = 0

  for (const testModule of Object.values(knownTests)) {
    for (const testSuite of Object.values(testModule)) {
      totalNumTests += testSuite.length
    }
  }

  return totalNumTests
}

const DEPENDENCY_FOLDERS = [
  'node_modules',
  'node:',
  '.pnpm',
  '.yarn',
  '.pnp'
]

function getFileAndLineNumberFromError (error, repositoryRoot) {
  // Split the stack trace into individual lines
  const stackLines = error.stack.split('\n')

  // Remove potential messages on top of the stack that are not frames
  const frames = stackLines.filter(line => line.includes('at ') && line.includes(repositoryRoot))

  const topRelevantFrameIndex = frames.findIndex(line =>
    line.includes(repositoryRoot) && !DEPENDENCY_FOLDERS.some(pattern => line.includes(pattern))
  )

  if (topRelevantFrameIndex === -1) {
    return []
  }

  const topFrame = frames[topRelevantFrameIndex]
  // Regular expression to match the file path, line number, and column number
  const regex = /\s*at\s+(?:.*\()?(.+):(\d+):(\d+)\)?/
  const match = topFrame.match(regex)

  if (match) {
    const filePath = match[1]
    const lineNumber = Number(match[2])

    return [filePath, lineNumber, topRelevantFrameIndex]
  }
  return []
}

function getFormattedError (error, repositoryRoot) {
  const newError = new Error(error.message)
  if (error.stack) {
    newError.stack = error.stack.split('\n').filter(line => line.includes(repositoryRoot)).join('\n')
  }
  newError.name = error.name

  return newError
}

function isTiaSupported (testFramework, isParallel) {
  return !(UNSUPPORTED_TIA_FRAMEWORKS.has(testFramework) ||
           (isParallel && UNSUPPORTED_TIA_FRAMEWORKS_PARALLEL_MODE.has(testFramework)))
}

function isEarlyFlakeDetectionSupported (testFramework, frameworkVersion) {
  return testFramework === 'playwright'
    ? satisfies(frameworkVersion, MINIMUM_FRAMEWORK_VERSION_FOR_EFD[testFramework])
    : true
}

function isImpactedTestsSupported (testFramework, frameworkVersion) {
  return testFramework === 'playwright'
    ? satisfies(frameworkVersion, MINIMUM_FRAMEWORK_VERSION_FOR_IMPACTED_TESTS[testFramework])
    : true
}

function isQuarantineSupported (testFramework, frameworkVersion) {
  return testFramework === 'playwright'
    ? satisfies(frameworkVersion, MINIMUM_FRAMEWORK_VERSION_FOR_QUARANTINE[testFramework])
    : true
}

function isDisableSupported (testFramework, frameworkVersion) {
  return testFramework === 'playwright'
    ? satisfies(frameworkVersion, MINIMUM_FRAMEWORK_VERSION_FOR_DISABLE[testFramework])
    : true
}

function isAttemptToFixSupported (testFramework, isParallel, frameworkVersion) {
  if (testFramework === 'playwright') {
    return satisfies(frameworkVersion, MINIMUM_FRAMEWORK_VERSION_FOR_ATTEMPT_TO_FIX[testFramework])
  }

  return !(isParallel && UNSUPPORTED_ATTEMPT_TO_FIX_FRAMEWORKS_PARALLEL_MODE.has(testFramework))
}

function isFailedTestReplaySupported (testFramework, frameworkVersion) {
  return testFramework === 'playwright'
    ? satisfies(frameworkVersion, MINIMUM_FRAMEWORK_VERSION_FOR_FAILED_TEST_REPLAY[testFramework])
    : true
}

function getLibraryCapabilitiesTags (testFramework, isParallel, frameworkVersion) {
  return {
    [DD_CAPABILITIES_TEST_IMPACT_ANALYSIS]: isTiaSupported(testFramework, isParallel)
      ? '1'
      : undefined,
    [DD_CAPABILITIES_EARLY_FLAKE_DETECTION]: isEarlyFlakeDetectionSupported(testFramework, frameworkVersion)
      ? '1'
      : undefined,
    [DD_CAPABILITIES_AUTO_TEST_RETRIES]: '1',
    [DD_CAPABILITIES_IMPACTED_TESTS]: isImpactedTestsSupported(testFramework, frameworkVersion)
      ? '1'
      : undefined,
    [DD_CAPABILITIES_TEST_MANAGEMENT_QUARANTINE]: isQuarantineSupported(testFramework, frameworkVersion)
      ? '1'
      : undefined,
    [DD_CAPABILITIES_TEST_MANAGEMENT_DISABLE]: isDisableSupported(testFramework, frameworkVersion)
      ? '1'
      : undefined,
    [DD_CAPABILITIES_TEST_MANAGEMENT_ATTEMPT_TO_FIX]:
      isAttemptToFixSupported(testFramework, isParallel, frameworkVersion)
        ? '5'
        : undefined,
    [DD_CAPABILITIES_FAILED_TEST_REPLAY]: isFailedTestReplaySupported(testFramework, frameworkVersion)
      ? '1'
      : undefined
  }
}

function getPullRequestBaseBranch (pullRequestBaseBranch) {
  const remoteName = getGitRemoteName()

  const sourceBranch = getSourceBranch()
  // TODO: We will get the default branch name from the backend in the future.
  const POSSIBLE_DEFAULT_BRANCHES = ['main', 'master']

  const candidateBranches = []
  if (pullRequestBaseBranch) {
    checkAndFetchBranch(pullRequestBaseBranch, remoteName)
    candidateBranches.push(pullRequestBaseBranch)
  } else {
    for (const branch of POSSIBLE_BASE_BRANCHES) {
      checkAndFetchBranch(branch, remoteName)
    }

    const localBranches = getLocalBranches(remoteName)
    for (const branch of localBranches) {
      const shortBranchName = branch.replace(new RegExp(`^${remoteName}/`), '')
      if (branch !== sourceBranch && BASE_LIKE_BRANCH_FILTER.test(shortBranchName)) {
        candidateBranches.push(branch)
      }
    }
  }

  if (candidateBranches.length === 1) {
    return getMergeBase(candidateBranches[0], sourceBranch)
  }

  const metrics = {}
  for (const candidate of candidateBranches) {
    // Find common ancestor
    const baseSha = getMergeBase(candidate, sourceBranch)
    if (!baseSha) {
      continue
    }
    // Count commits ahead/behind
    const counts = getCounts(candidate, sourceBranch)
    if (!counts) {
      continue
    }
    const behind = counts.behind
    const ahead = counts.ahead
    metrics[candidate] = {
      behind,
      ahead,
      baseSha
    }
  }

  function isDefaultBranch (branch) {
    return POSSIBLE_DEFAULT_BRANCHES.some(defaultBranch =>
      branch === defaultBranch || branch === `${remoteName}/${defaultBranch}`
    )
  }

  if (Object.keys(metrics).length === 0) {
    return null
  }
  // Find branch with smallest "ahead" value, preferring default branch on tie
  let bestBranch = null
  let bestScore = Infinity
  for (const branch of Object.keys(metrics)) {
    const score = metrics[branch].ahead
    if (score < bestScore) {
      bestScore = score
      bestBranch = branch
    } else if (score === bestScore && isDefaultBranch(branch)) {
      bestScore = score
      bestBranch = branch
    }
  }
  return bestBranch ? metrics[bestBranch].baseSha : null
}

function getPullRequestDiff (baseCommit, targetCommit) {
  if (!baseCommit) {
    return
  }
  return getGitDiff(baseCommit, targetCommit)
}

function getModifiedTestsFromDiff (diff) {
  if (!diff) return null
  const result = {}

  const filesRegex = /^diff --git a\/(?<file>.+) b\/(?<file2>.+)$/g
  const linesRegex = /^@@ -\d+(,\d+)? \+(?<start>\d+)(,(?<count>\d+))? @@/g

  let currentFile = null

  // Go line by line
  const lines = diff.split('\n')
  for (const line of lines) {
    // Check for new file
    const fileMatch = filesRegex.exec(line)
    if (fileMatch && fileMatch.groups.file) {
      currentFile = fileMatch.groups.file
      result[currentFile] = []
      continue
    }

    // Check for changed lines
    const lineMatch = linesRegex.exec(line)
    if (lineMatch && currentFile) {
      const start = Number(lineMatch.groups.start)
      const count = lineMatch.groups.count ? Number(lineMatch.groups.count) : 1
      for (let j = 0; j < count; j++) {
        result[currentFile].push(start + j)
      }
    }

    // Reset regexes to allow re-use
    filesRegex.lastIndex = 0
    linesRegex.lastIndex = 0
  }

  if (Object.keys(result).length === 0) {
    return null
  }
  return result
}

function isModifiedTest (testPath, testStartLine, testEndLine, modifiedTests, testFramework) {
  if (modifiedTests === undefined) {
    return false
  }

  const lines = modifiedTests[testPath]
  if (!lines) {
    return false
  }

  // For unsupported frameworks, consider the test modified if any lines were changed
  if (NOT_SUPPORTED_GRANULARITY_IMPACTED_TESTS_FRAMEWORKS.has(testFramework)) {
    return lines.length > 0
  }

  // For supported frameworks, check if the test's line range overlaps with modified lines
  return lines.some(line => line >= testStartLine && line <= testEndLine)
}
