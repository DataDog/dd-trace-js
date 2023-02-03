const path = require('path')
const fs = require('fs')

const istanbul = require('istanbul-lib-coverage')
const ignore = require('ignore')

const { getGitMetadata } = require('./git')
const { getUserProviderGitMetadata } = require('./user-provided-git')
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
  CI_WORKSPACE_PATH
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
const LIBRARY_VERSION = 'library_version'
const TEST_COMMAND = 'test.command'
const TEST_BUNDLE = 'test.bundle'
const TEST_SESSION_ID = 'test_session_id'
const TEST_MODULE_ID = 'test_module_id'
const TEST_SUITE_ID = 'test_suite_id'

const CI_APP_ORIGIN = 'ciapp-test'

const JEST_TEST_RUNNER = 'test.jest.test_runner'

const TEST_ITR_TESTS_SKIPPED = '_dd.ci.itr.tests_skipped'
const TEST_SESSION_ITR_SKIPPING_ENABLED = 'test_session.itr.tests_skipping.enabled'
const TEST_SESSION_CODE_COVERAGE_ENABLED = 'test_session.code_coverage.enabled'
const TEST_MODULE_ITR_SKIPPING_ENABLED = 'test_module.itr.tests_skipping.enabled'
const TEST_MODULE_CODE_COVERAGE_ENABLED = 'test_module.code_coverage.enabled'

const TEST_CODE_COVERAGE_LINES_TOTAL = 'test.codecov_lines_total'

module.exports = {
  TEST_CODE_OWNERS,
  TEST_FRAMEWORK,
  TEST_FRAMEWORK_VERSION,
  JEST_TEST_RUNNER,
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
  TEST_SESSION_ID,
  TEST_MODULE_ID,
  TEST_SUITE_ID,
  TEST_ITR_TESTS_SKIPPED,
  TEST_BUNDLE,
  TEST_SESSION_ITR_SKIPPING_ENABLED,
  TEST_SESSION_CODE_COVERAGE_ENABLED,
  TEST_MODULE_ITR_SKIPPING_ENABLED,
  TEST_MODULE_CODE_COVERAGE_ENABLED,
  TEST_CODE_COVERAGE_LINES_TOTAL,
  addIntelligentTestRunnerSpanTags,
  getCoveredFilenamesFromCoverage,
  resetCoverage,
  mergeCoverage,
  fromCoverageMapToCoverage
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
  return metadata
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

function getTestCommonTags (name, suite, version) {
  return {
    [SPAN_TYPE]: 'test',
    [TEST_TYPE]: 'test',
    [SAMPLING_RULE_DECISION]: 1,
    [SAMPLING_PRIORITY]: AUTO_KEEP,
    [TEST_NAME]: name,
    [TEST_SUITE]: suite,
    [TEST_SOURCE_FILE]: suite,
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
    ? testSuiteAbsolutePath : path.relative(sourceRoot, testSuiteAbsolutePath)

  return testSuitePath.replace(path.sep, '/')
}

const POSSIBLE_CODEOWNERS_LOCATIONS = [
  'CODEOWNERS',
  '.github/CODEOWNERS',
  'docs/CODEOWNERS',
  '.gitlab/CODEOWNERS'
]

function getCodeOwnersFileEntries (rootDir = process.cwd()) {
  let codeOwnersContent

  POSSIBLE_CODEOWNERS_LOCATIONS.forEach(location => {
    try {
      codeOwnersContent = fs.readFileSync(`${rootDir}/${location}`).toString()
    } catch (e) {
      // retry with next path
    }
  })
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

function getTestLevelCommonTags (command, testFrameworkVersion) {
  return {
    [TEST_FRAMEWORK_VERSION]: testFrameworkVersion,
    [LIBRARY_VERSION]: ddTraceVersion,
    [TEST_COMMAND]: command,
    [TEST_TYPE]: 'test'
  }
}

function getTestSessionCommonTags (command, testFrameworkVersion) {
  return {
    [SPAN_TYPE]: 'test_session_end',
    [RESOURCE_NAME]: `test_session.${command}`,
    ...getTestLevelCommonTags(command, testFrameworkVersion)
  }
}

function getTestModuleCommonTags (command, testFrameworkVersion) {
  return {
    [SPAN_TYPE]: 'test_module_end',
    [RESOURCE_NAME]: `test_module.${command}`,
    [TEST_BUNDLE]: command,
    ...getTestLevelCommonTags(command, testFrameworkVersion)
  }
}

function getTestSuiteCommonTags (command, testFrameworkVersion, testSuite) {
  return {
    [SPAN_TYPE]: 'test_suite_end',
    [RESOURCE_NAME]: `test_suite.${testSuite}`,
    [TEST_BUNDLE]: command,
    [TEST_SUITE]: testSuite,
    ...getTestLevelCommonTags(command, testFrameworkVersion)
  }
}

function addIntelligentTestRunnerSpanTags (
  testSessionSpan,
  testModuleSpan,
  { isSuitesSkipped, isSuitesSkippingEnabled, isCodeCoverageEnabled, testCodeCoverageLinesTotal }
) {
  testSessionSpan.setTag(TEST_ITR_TESTS_SKIPPED, isSuitesSkipped ? 'true' : 'false')
  testSessionSpan.setTag(TEST_SESSION_ITR_SKIPPING_ENABLED, isSuitesSkippingEnabled ? 'true' : 'false')
  testSessionSpan.setTag(TEST_SESSION_CODE_COVERAGE_ENABLED, isCodeCoverageEnabled ? 'true' : 'false')

  testModuleSpan.setTag(TEST_ITR_TESTS_SKIPPED, isSuitesSkipped ? 'true' : 'false')
  testModuleSpan.setTag(TEST_MODULE_ITR_SKIPPING_ENABLED, isSuitesSkippingEnabled ? 'true' : 'false')
  testModuleSpan.setTag(TEST_MODULE_CODE_COVERAGE_ENABLED, isCodeCoverageEnabled ? 'true' : 'false')

  // If suites have been skipped we don't want to report the total coverage, as it will be wrong
  if (testCodeCoverageLinesTotal !== undefined && !isSuitesSkipped) {
    testSessionSpan.setTag(TEST_CODE_COVERAGE_LINES_TOTAL, testCodeCoverageLinesTotal)
    testModuleSpan.setTag(TEST_CODE_COVERAGE_LINES_TOTAL, testCodeCoverageLinesTotal)
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
