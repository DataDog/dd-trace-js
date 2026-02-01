'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { assertObjectContains } = require('../../../../../integration-tests/helpers')
require('../../setup/core')

const cachedExecStub = sinon.stub().returns('')

const { getCIMetadata } = require('../../../src/plugins/util/ci')
const {
  CI_ENV_VARS,
  CI_NODE_LABELS,
  GIT_PULL_REQUEST_BASE_BRANCH,
  GIT_PULL_REQUEST_BASE_BRANCH_HEAD_SHA,
  GIT_COMMIT_HEAD_SHA,
} = require('../../../src/plugins/util/tags')

const { getGitMetadata } = proxyquire('../../../src/plugins/util/git', {
  './git-cache': {
    cachedExec: cachedExecStub,
  },
})
const { getTestEnvironmentMetadata } = proxyquire('../../../src/plugins/util/test', {
  './git': {
    getGitMetadata,
  },
})

describe('test environment data', () => {
  it('getTestEnvironmentMetadata can include service name', () => {
    const tags = getTestEnvironmentMetadata('jest', { service: 'service-name' })
    assertObjectContains(tags, { 'service.name': 'service-name' })
  })

  it('getCIMetadata returns an empty object if the CI is not supported', () => {
    process.env = {}
    assert.deepStrictEqual(getCIMetadata(), {})
  })

  const ciProviders = fs.readdirSync(path.join(__dirname, 'ci-env'))
  ciProviders.forEach(ciProvider => {
    const assertions = require(path.join(__dirname, 'ci-env', ciProvider))
    if (ciProvider === 'github.json') {
      // We grab the first assertion because we only need to test one
      const [env] = assertions[0]
      it('can read pull request data from GitHub Actions', () => {
        process.env = env
        process.env.GITHUB_BASE_REF = 'datadog:main'
        process.env.GITHUB_EVENT_PATH = path.join(__dirname, 'fixtures', 'github_event_payload.json')
        const {
          [GIT_PULL_REQUEST_BASE_BRANCH]: pullRequestBaseBranch,
          [GIT_PULL_REQUEST_BASE_BRANCH_HEAD_SHA]: pullRequestBaseBranchHeadSha,
          [GIT_COMMIT_HEAD_SHA]: headCommitSha,
        } = getTestEnvironmentMetadata()

        assert.deepStrictEqual({
          pullRequestBaseBranch,
          pullRequestBaseBranchHeadSha,
          headCommitSha,
        }, {
          pullRequestBaseBranch: 'datadog:main',
          pullRequestBaseBranchHeadSha: '52e0974c74d41160a03d59ddc73bb9f5adab054b',
          headCommitSha: 'df289512a51123083a8e6931dd6f57bb3883d4c4',
        })
      })
      it('does not crash if GITHUB_EVENT_PATH is not a valid JSON file', () => {
        process.env = env
        process.env.GITHUB_BASE_REF = 'datadog:main'
        process.env.GITHUB_EVENT_PATH = path.join(__dirname, 'fixtures', 'github_event_payload_malformed.json')
        const {
          [GIT_PULL_REQUEST_BASE_BRANCH]: pullRequestBaseBranch,
          [GIT_PULL_REQUEST_BASE_BRANCH_HEAD_SHA]: pullRequestBaseBranchHeadSha,
          [GIT_COMMIT_HEAD_SHA]: headCommitSha,
        } = getTestEnvironmentMetadata()

        assert.strictEqual(pullRequestBaseBranch, 'datadog:main')
        assert.strictEqual(pullRequestBaseBranchHeadSha, undefined)
        assert.strictEqual(headCommitSha, undefined)
      })
    }

    assertions.forEach(([env, expectedSpanTags], index) => {
      it(`reads env info for spec ${index} from ${ciProvider}`, () => {
        process.env = env
        const { TESTING_TEST_OPTIMIZATION_TEST_CASE_NAME: testCaseName } = env
        const { [CI_ENV_VARS]: envVars, [CI_NODE_LABELS]: nodeLabels, ...restOfTags } = getTestEnvironmentMetadata()
        const {
          [CI_ENV_VARS]: expectedEnvVars,
          [CI_NODE_LABELS]: expectedNodeLabels,
          ...restOfExpectedTags
        } = expectedSpanTags

        const msg = testCaseName ?? `${testCaseName} Failed`

        assertObjectContains(restOfTags, restOfExpectedTags, msg)
        // `CI_ENV_VARS` key contains a dictionary
        if (envVars && expectedEnvVars) {
          assert.deepStrictEqual(JSON.parse(envVars), JSON.parse(expectedEnvVars), msg)
        }
        // `CI_NODE_LABELS` key contains an array
        if (nodeLabels && expectedNodeLabels) {
          assertObjectContains(JSON.parse(nodeLabels).sort(), JSON.parse(expectedNodeLabels).sort(), msg)
        }
      })
    })
  })
})
