const path = require('path')

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

const TEST_FRAMEWORK = 'test.framework'
const TEST_TYPE = 'test.type'
const TEST_NAME = 'test.name'
const TEST_SUITE = 'test.suite'
const TEST_STATUS = 'test.status'
const TEST_PARAMETERS = 'test.parameters'
const TEST_SKIP_REASON = 'test.skip_reason'

const ERROR_TYPE = 'error.type'
const ERROR_MESSAGE = 'error.msg'
const ERROR_STACK = 'error.stack'

const CI_APP_ORIGIN = 'ciapp-test'

module.exports = {
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_STATUS,
  TEST_PARAMETERS,
  TEST_SKIP_REASON,
  ERROR_TYPE,
  ERROR_MESSAGE,
  ERROR_STACK,
  CI_APP_ORIGIN,
  getTestEnvironmentMetadata,
  getTestParametersString,
  finishAllTraceSpans,
  getTestParentSpan,
  getTestSuitePath
}

function getTestEnvironmentMetadata (testFramework) {
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

  return {
    [TEST_FRAMEWORK]: testFramework,
    ...gitMetadata,
    ...ciMetadata,
    ...userProvidedGitMetadata,
    ...runtimeAndOSMetadata
  }
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
    'x-datadog-parent-id': '0000000000000000',
    'x-datadog-sampled': 1
  })
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
