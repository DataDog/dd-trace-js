const path = require('path')
const fs = require('fs')
const { URL } = require('url')
const log = require('../../log')

const istanbul = require('istanbul-lib-coverage')
const ignore = require('ignore')

const { getGitMetadata } = require('./git')
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
  CI_PIPELINE_URL
} = require('./tags')
const id = require('../../id')

const { SPAN_TYPE, RESOURCE_NAME, SAMPLING_PRIORITY } = require('../../../../../ext/tags')
const { SAMPLING_RULE_DECISION } = require('../../constants')
const { AUTO_KEEP } = require('../../../../../ext/priority')
const { version: ddTraceVersion } = require('../../../../../package.json')

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
// Browser used in browser test. Namespaced by test.configuration because it affects the fingerprint
const TEST_CONFIGURATION_BROWSER_NAME = 'test.configuration.browser_name'
// Early flake detection
const TEST_IS_NEW = 'test.is_new'
const TEST_IS_RETRY = 'test.is_retry'
const TEST_EARLY_FLAKE_ENABLED = 'test.early_flake.enabled'
const TEST_EARLY_FLAKE_ABORT_REASON = 'test.early_flake.abort_reason'

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

// cucumber worker variables
const CUCUMBER_WORKER_TRACE_PAYLOAD_CODE = 70

// mocha worker variables
const MOCHA_WORKER_TRACE_PAYLOAD_CODE = 80

// Early flake detection util strings
const EFD_STRING = "Retried by Datadog's Early Flake Detection"
const EFD_TEST_NAME_REGEX = new RegExp(EFD_STRING + ' \\(#\\d+\\): ', 'g')

module.exports = {
  TEST_CODE_OWNERS,
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
  CUCUMBER_WORKER_TRACE_PAYLOAD_CODE,
  MOCHA_WORKER_TRACE_PAYLOAD_CODE,
  TEST_SOURCE_START,
  TEST_SKIPPED_BY_ITR,
  TEST_CONFIGURATION_BROWSER_NAME,
  TEST_IS_NEW,
  TEST_IS_RETRY,
  TEST_EARLY_FLAKE_ENABLED,
  TEST_EARLY_FLAKE_ABORT_REASON,
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
  getCallSites,
  removeInvalidMetadata,
  parseAnnotations,
  EFD_STRING,
  EFD_TEST_NAME_REGEX,
  removeEfdStringFromTestName,
  addEfdStringToTestName,
  getIsFaultyEarlyFlakeDetection,
  TEST_BROWSER_DRIVER,
  TEST_BROWSER_DRIVER_VERSION,
  TEST_BROWSER_NAME,
  TEST_BROWSER_VERSION
}

// Returns pkg manager and its version, separated by '-', e.g. npm-8.15.0 or yarn-1.22.19
function getPkgManager () {
  try {
    return process.env.npm_config_user_agent.split(' ')[0].replace('/', '-')
  } catch (e) {
    return ''
  }
}

function validateUrl (url) {
  try {
    const urlObject = new URL(url)
    return (urlObject.protocol === 'https:' || urlObject.protocol === 'http:')
  } catch (e) {
    return false
  }
}

function removeInvalidMetadata (metadata) {
  return Object.keys(metadata).reduce((filteredTags, tag) => {
    if (tag === GIT_REPOSITORY_URL) {
      if (!validateGitRepositoryUrl(metadata[GIT_REPOSITORY_URL])) {
        log.error(`Repository URL is not a valid repository URL: ${metadata[GIT_REPOSITORY_URL]}.`)
        return filteredTags
      }
    }
    if (tag === GIT_COMMIT_SHA) {
      if (!validateGitCommitSha(metadata[GIT_COMMIT_SHA])) {
        log.error(`Git commit SHA must be a full-length git SHA: ${metadata[GIT_COMMIT_SHA]}.`)
        return filteredTags
      }
    }
    if (tag === CI_PIPELINE_URL) {
      if (!validateUrl(metadata[CI_PIPELINE_URL])) {
        return filteredTags
      }
    }
    filteredTags[tag] = metadata[tag]
    return filteredTags
  }, {})
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
    [CI_WORKSPACE_PATH]: ciWorkspacePath
  } = ciMetadata

  const gitMetadata = getGitMetadata({
    commitSHA,
    branch,
    repositoryUrl,
    tag,
    authorName,
    authorEmail,
    commitMessage,
    ciWorkspacePath
  })

  const userProvidedGitMetadata = getUserProviderGitMetadata()

  const runtimeAndOSMetadata = getRuntimeAndOSMetadata()

  const metadata = {
    [TEST_FRAMEWORK]: testFramework,
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
  } catch (e) {
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
    } catch (e) {
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
    } catch (e) {
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
    return parseInt(testFileLineMatch[3], 10) || null
  } catch (e) {
    return null
  }
}

// From https://github.com/felixge/node-stack-trace/blob/ba06dcdb50d465cd440d84a563836e293b360427/index.js#L1
function getCallSites () {
  const oldLimit = Error.stackTraceLimit
  Error.stackTraceLimit = Infinity

  const dummy = {}

  const v8Handler = Error.prepareStackTrace
  Error.prepareStackTrace = function (_, v8StackTrace) {
    return v8StackTrace
  }
  Error.captureStackTrace(dummy)

  const v8StackTrace = dummy.stack
  Error.prepareStackTrace = v8Handler
  Error.stackTraceLimit = oldLimit

  return v8StackTrace
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

function removeEfdStringFromTestName (testName) {
  return testName.replace(EFD_TEST_NAME_REGEX, '')
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
