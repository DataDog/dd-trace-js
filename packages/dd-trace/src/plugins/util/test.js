const {
  getGitMetadata,
  GIT_BRANCH,
  GIT_COMMIT_SHA,
  GIT_REPOSITORY_URL,
  GIT_TAG,
  GIT_COMMIT_AUTHOR_EMAIL,
  GIT_COMMIT_AUTHOR_NAME,
  GIT_COMMIT_MESSAGE
} = require('./git')
const { getCIMetadata } = require('./ci')
const { getRuntimeAndOSMetadata } = require('./env')

const TEST_FRAMEWORK = 'test.framework'
const TEST_TYPE = 'test.type'
const TEST_NAME = 'test.name'
const TEST_SUITE = 'test.suite'
const TEST_STATUS = 'test.status'
const TEST_PARAMETERS = 'test.parameters'

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
  ERROR_TYPE,
  ERROR_MESSAGE,
  ERROR_STACK,
  CI_APP_ORIGIN,
  getTestEnvironmentMetadata,
  getTestParametersString,
  finishAllTraceSpans
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
    [GIT_COMMIT_MESSAGE]: commitMessage
  } = ciMetadata

  const gitMetadata = getGitMetadata({
    commitSHA,
    branch,
    repositoryUrl,
    tag,
    authorName,
    authorEmail,
    commitMessage
  })

  const runtimeAndOSMetadata = getRuntimeAndOSMetadata()

  return {
    [TEST_FRAMEWORK]: testFramework,
    ...gitMetadata,
    ...ciMetadata,
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
