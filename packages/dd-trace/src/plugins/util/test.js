const { getGitMetadata, GIT_BRANCH, GIT_COMMIT_SHA, GIT_REPOSITORY_URL, GIT_TAG } = require('./git')
const { getCIMetadata } = require('./ci')
const { getRuntimeAndOSMetadata } = require('./env')

const TEST_FRAMEWORK = 'test.framework'
const TEST_TYPE = 'test.type'
const TEST_NAME = 'test.name'
const TEST_SUITE = 'test.suite'
const TEST_STATUS = 'test.status'
const TEST_PARAMETERS = 'test.parameters'

const ERROR_TYPE = 'error.type'
const ERROR_MESSAGE = 'error.message'
const ERROR_STACK = 'error.stack'

module.exports = {
  TEST_FRAMEWORK,
  TEST_TYPE,
  TEST_NAME,
  TEST_SUITE,
  TEST_STATUS,
  ERROR_TYPE,
  ERROR_MESSAGE,
  ERROR_STACK,
  TEST_PARAMETERS,
  getTestEnvironmentMetadata
}

function getTestEnvironmentMetadata (testFramework) {
  // TODO: eventually these will come from the tracer (generally available)
  const ciMetadata = getCIMetadata()
  const {
    [GIT_COMMIT_SHA]: commitSHA,
    [GIT_BRANCH]: branch,
    [GIT_REPOSITORY_URL]: repositoryUrl,
    [GIT_TAG]: tag
  } = ciMetadata

  const gitMetadata = getGitMetadata({ commitSHA, branch, repositoryUrl, tag })

  const runtimeAndOSMetadata = getRuntimeAndOSMetadata()

  return {
    [TEST_FRAMEWORK]: testFramework,
    ...gitMetadata,
    ...ciMetadata,
    ...runtimeAndOSMetadata
  }
}
