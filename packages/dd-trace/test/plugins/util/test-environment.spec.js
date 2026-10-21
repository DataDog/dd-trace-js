'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { describe, it, beforeEach, afterEach } = require('mocha')
const msgpack = require('@msgpack/msgpack')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { assertObjectContains } = require('../../../../../integration-tests/helpers')
require('../../setup/core')
const { AgentlessCiVisibilityEncoder } = require('../../../src/encode/agentless-ci-visibility')
const id = require('../../../src/id')

const cachedExecStub = sinon.stub().returns('')

const { expandGlobPattern, getJobIDFromDiagFile } = require('../../../src/plugins/util/ci')
const {
  CI_ENV_VARS,
  CI_NODE_LABELS,
  GIT_PULL_REQUEST_BASE_BRANCH,
  GIT_PULL_REQUEST_BASE_BRANCH_HEAD_SHA,
  GIT_COMMIT_HEAD_SHA,
  PR_NUMBER,
} = require('../../../src/plugins/util/tags')

const freshConfig = () => {
  const loadConfig = proxyquire.noPreserveCache()
  const createConfig = loadConfig('../../../src/config', {})
  return createConfig()
}

const { getGitMetadata } = proxyquire('../../../src/plugins/util/git', {
  './git-cache': {
    cachedExec: cachedExecStub,
  },
})
const ciModule = proxyquire('../../../src/plugins/util/ci', {
  '../../config': freshConfig,
})
const { getCIMetadata } = ciModule
const userProvidedGit = proxyquire('../../../src/plugins/util/user-provided-git', {
  '../../config': freshConfig,
})
const { getTestEnvironmentMetadata, getTestLevelsMetadataTags } = proxyquire('../../../src/plugins/util/test', {
  './ci': ciModule,
  './git': {
    getGitMetadata,
  },
  './user-provided-git': userProvidedGit,
})

describe('Test Parallelization environment metadata', () => {
  let originalEnv

  beforeEach(() => {
    originalEnv = process.env
    process.env = {
      GITLAB_CI: 'true',
      CI_JOB_ID: 'run-job-789',
      CI_JOB_NAME: 'tests',
      CI_JOB_URL: 'https://gitlab.com/project/-/jobs/789',
      CI_PIPELINE_ID: 'run-pipeline-456',
      CI_PIPELINE_URL: 'https://gitlab.com/project/-/pipelines/456',
    }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('keeps the planning and execution jobs distinct on every test level', () => {
    process.env._DD_TEST_PARALLELIZATION_ENABLED = 'true'
    const planEnv = {
      _DD_TEST_PARALLELIZATION_PLAN_PROVIDER_NAME: 'plan-provider_name',
      _DD_TEST_PARALLELIZATION_PLAN_PIPELINE_ID: 'plan-pipeline_id',
      _DD_TEST_PARALLELIZATION_PLAN_PIPELINE_NAME: 'plan-pipeline_name',
      _DD_TEST_PARALLELIZATION_PLAN_PIPELINE_DISPLAY_NAME: 'plan-pipeline_display_name',
      _DD_TEST_PARALLELIZATION_PLAN_PIPELINE_NUMBER: 'plan-pipeline_number',
      _DD_TEST_PARALLELIZATION_PLAN_PIPELINE_URL: 'https://gitlab.com/plan/pipeline_url',
      _DD_TEST_PARALLELIZATION_PLAN_JOB_ID: 'plan-job_id',
      _DD_TEST_PARALLELIZATION_PLAN_JOB_NAME: 'plan-job_name',
      _DD_TEST_PARALLELIZATION_PLAN_JOB_URL: 'https://gitlab.com/plan/job_url',
      _DD_TEST_PARALLELIZATION_PLAN_STAGE_NAME: 'plan-stage_name',
    }
    Object.assign(process.env, planEnv)
    const metadata = getTestEnvironmentMetadata('mocha', undefined, true)
    const expectedPlanTags = {
      'test.parallelization.enabled': 'true',
      'test.parallelization.plan.provider.name': 'plan-provider_name',
      'test.parallelization.plan.pipeline.id': 'plan-pipeline_id',
      'test.parallelization.plan.pipeline.name': 'plan-pipeline_name',
      'test.parallelization.plan.pipeline.display_name': 'plan-pipeline_display_name',
      'test.parallelization.plan.pipeline.number': 'plan-pipeline_number',
      'test.parallelization.plan.pipeline.url': 'https://gitlab.com/plan/pipeline_url',
      'test.parallelization.plan.job.id': 'plan-job_id',
      'test.parallelization.plan.job.name': 'plan-job_name',
      'test.parallelization.plan.job.url': 'https://gitlab.com/plan/job_url',
      'test.parallelization.plan.stage.name': 'plan-stage_name',
    }
    assertObjectContains(metadata, {
      ...expectedPlanTags,
      'ci.job.id': 'run-job-789',
      'ci.job.name': 'tests',
      'ci.job.url': 'https://gitlab.com/project/-/jobs/789',
      'ci.pipeline.id': 'run-pipeline-456',
    })
    const testLevelsTags = getTestLevelsMetadataTags(metadata)
    assertObjectContains(testLevelsTags, expectedPlanTags)

    const encoder = new AgentlessCiVisibilityEncoder({ flush () {} }, { tags: {} })
    encoder.addMetadataTags({ test_levels: testLevelsTags })
    const eventTypes = ['test_session_end', 'test_module_end', 'test_suite_end', 'test']
    for (const type of eventTypes) {
      encoder.encode([{
        trace_id: id('1234abcd1234abcd'),
        span_id: id('1234abcd1234abcd'),
        parent_id: id('1234abcd1234abcd'),
        type,
        name: 'mocha.test',
        resource: 'example',
        service: 'example',
        error: 0,
        start: 0,
        duration: 1,
        meta: { ...metadata },
        metrics: {},
      }])
    }
    const payload = msgpack.decode(encoder.makePayload(), { useBigInt64: true })
    assert.deepStrictEqual(payload.events.map(({ type }) => type), eventTypes)
    for (const event of payload.events) {
      assertObjectContains({ ...payload.metadata.test_levels, ...event.content.meta }, {
        ...expectedPlanTags,
        'ci.job.id': 'run-job-789',
      })
    }
  })

  for (const enabled of [undefined, '', 'false', '0', 'invalid']) {
    it(`ignores planning metadata when parallelization is ${String(enabled)}`, () => {
      if (enabled !== undefined) process.env._DD_TEST_PARALLELIZATION_ENABLED = enabled
      process.env._DD_TEST_PARALLELIZATION_PLAN_JOB_ID = 'stale-plan-job'
      const metadata = getTestEnvironmentMetadata('mocha', undefined, true)
      assert.deepStrictEqual(Object.keys(metadata).filter(key => key.startsWith('test.parallelization.')), [])
    })
  }

  it('does not enable parallelization from the public variable names', () => {
    process.env.DD_TEST_PARALLELIZATION_ENABLED = 'true'
    process.env.DD_TEST_PARALLELIZATION_PLAN_JOB_ID = 'public-plan-job'
    const metadata = getTestEnvironmentMetadata('mocha', undefined, true)
    assert.deepStrictEqual(Object.keys(metadata).filter(key => key.startsWith('test.parallelization.')), [])
  })

  for (const enabled of ['true', 'TRUE', '1']) {
    it(`supports ${enabled} without inventing missing planning-job metadata`, () => {
      process.env = {
        _DD_TEST_PARALLELIZATION_ENABLED: enabled,
        _DD_TEST_PARALLELIZATION_PLAN_JOB_ID: '',
      }
      const metadata = getTestEnvironmentMetadata('mocha', undefined, true)
      assert.deepStrictEqual(getTestLevelsMetadataTags(metadata), {
        'test.parallelization.enabled': 'true',
      })
    })
  }
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

  it('does not set pr.number on Buildkite when BUILDKITE_PULL_REQUEST is the literal string false', () => {
    process.env = {
      BUILDKITE: 'true',
      BUILDKITE_BUILD_ID: 'buildkite-pipeline-id',
      BUILDKITE_JOB_ID: 'buildkite-job-id',
      BUILDKITE_PIPELINE_SLUG: 'buildkite-pipeline-name',
      BUILDKITE_BUILD_NUMBER: 'buildkite-pipeline-number',
      BUILDKITE_BUILD_URL: 'https://buildkite-build-url.com',
      BUILDKITE_BRANCH: 'gh-readonly-queue/main/pr-1234-abcdef0123456789abcdef0123456789abcdef01',
      BUILDKITE_COMMIT: 'b9f0fb3fdbb94c9d24b2c75b49663122a529e123',
      BUILDKITE_REPO: 'http://hostname.com/repo.git',
      BUILDKITE_PULL_REQUEST: 'false',
      BUILDKITE_PULL_REQUEST_BASE_BRANCH: 'main',
    }

    const tags = getCIMetadata()

    assert.strictEqual(tags[PR_NUMBER], undefined)
    assert.strictEqual(tags[GIT_PULL_REQUEST_BASE_BRANCH], undefined)
  })
})

describe('expandGlobPattern', () => {
  // Base path used by all cases — forward-slash throughout to match the posix
  // convention that ci.js commits to after the path.sep normalization.
  const FIXTURES = path.join(__dirname, 'fixtures').replaceAll(path.sep, '/')

  it('passes through a literal path without magic chars unchanged', () => {
    const literal = `${FIXTURES}/runner/_diag`
    assert.deepStrictEqual(expandGlobPattern(literal), [literal])
  })

  it('expands a single-* segment to matching directories', () => {
    // fixtures/runner/actions-runner/cached/*/_diag
    // The only match is 2.334.0/_diag
    const pattern = `${FIXTURES}/runner/actions-runner/cached/*/_diag`
    assert.deepStrictEqual(
      expandGlobPattern(pattern),
      [`${FIXTURES}/runner/actions-runner/cached/2.334.0/_diag`]
    )
  })

  it('expands two consecutive * segments (nested cached/<version>/_diag layout)', () => {
    // fixtures/runner/actions-runner/*/*/_diag resolves through cached/2.334.0
    const pattern = `${FIXTURES}/runner/actions-runner/*/*/_diag`
    assert.deepStrictEqual(
      expandGlobPattern(pattern),
      [`${FIXTURES}/runner/actions-runner/cached/2.334.0/_diag`]
    )
  })

  it('expands env-derived runnerRoot/*/_diag (legacy flat layout)', () => {
    // runner_legacy has _diag directly under actions-runner/ — no cached/<version> wrapper.
    // Covers the root-level single-* candidate that getGithubDiagnosticDirsFromEnv emits.
    // * matches every direct child (actions-runner and work), so both appear; existence
    // of the final _diag segment is checked later by the caller, not here.
    const pattern = `${FIXTURES}/runner_legacy/*/_diag`
    assert.deepStrictEqual(
      expandGlobPattern(pattern),
      [
        `${FIXTURES}/runner_legacy/actions-runner/_diag`,
        `${FIXTURES}/runner_legacy/work/_diag`,
      ]
    )
  })

  it('returns an empty array when the directory before the wildcard does not exist', () => {
    const pattern = `${FIXTURES}/nonexistent/*/_diag`
    assert.deepStrictEqual(expandGlobPattern(pattern), [])
  })

  it('does not expand ** as a recursive glob — only matches a single path segment', () => {
    // ** is not a recursive wildcard here: it is treated as a single-segment
    // pattern (same as *), so it cannot reach actions-runner/cached/2.334.0/_diag
    // (which is multiple levels deep). This guards against a future caller adding
    // a ** pattern expecting recursive expansion that silently no-ops.
    const pattern = `${FIXTURES}/runner/**/_diag`
    const results = expandGlobPattern(pattern)
    assert.ok(
      !results.includes(`${FIXTURES}/runner/actions-runner/cached/2.334.0/_diag`),
      '** must not traverse multiple path segments like a recursive glob'
    )
  })
})

describe('test getJobIDFromDiagFile function', () => {
  const TEST_HOME = path.join(__dirname, 'fixtures')

  let originalRunnerTemp

  beforeEach(() => { originalRunnerTemp = process.env.RUNNER_TEMP })
  afterEach(() => {
    if (originalRunnerTemp == null) {
      delete process.env.RUNNER_TEMP
    } else {
      process.env.RUNNER_TEMP = originalRunnerTemp
    }
  })

  const runnerTempPaths = [
    { runnerTemp: path.join(TEST_HOME, '/runner/work/_temp'), expected: '9876543210' },
    // Flat layout: older self-hosted runners place _diag directly under actions-runner/
    // with no cached/<version>/ wrapper. Exercises the actions-runner/_diag candidate.
    { runnerTemp: path.join(TEST_HOME, '/runner_legacy/work/_temp'), expected: '9876543210' },
    { runnerTemp: null, expected: null },
    { runnerTemp: undefined, expected: null },
    { runnerTemp: path.join(TEST_HOME, Math.random().toString(36).slice(2, 10)), expected: null },
    { runnerTemp: path.join(TEST_HOME, '/runner_empty/work/_temp'), expected: null },
  ]

  for (const { runnerTemp, expected } of runnerTempPaths) {
    it(`returns ${expected} for runnerTemp: ${runnerTemp}`, () => {
      if (runnerTemp == null) {
        delete process.env.RUNNER_TEMP
      } else {
        process.env.RUNNER_TEMP = runnerTemp
      }
      assert.strictEqual(getJobIDFromDiagFile(), expected)
    })
  }
})

describe('getJobIDFromDiagFile Windows branch', () => {
  // ci.js destructs fs at require-time so sinon cannot reach those bindings after the fact.
  // proxyquire injects the stubs before the module loads, so they become the local variables.
  const readdirSyncStub = sinon.stub()
  const existsSyncStub = sinon.stub()
  const readFileSyncStub = sinon.stub()

  const { getJobIDFromDiagFile: getJobIDFromDiagFileWin } = proxyquire('../../../src/plugins/util/ci', {
    fs: { readdirSync: readdirSyncStub, existsSync: existsSyncStub, readFileSync: readFileSyncStub },
  })

  let platformDescriptor

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    existsSyncStub.returns(false)
    readdirSyncStub.throws(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', platformDescriptor)
    delete process.env.RUNNER_TEMP
    readdirSyncStub.reset()
    existsSyncStub.reset()
    readFileSyncStub.reset()
  })

  const LOG_CONTENT = '"job": {\n"v": 9876543210\n}'

  it('finds job ID via nested layout C:/actions-runner/cached/<version>/_diag (mirrors runner fixture)', () => {
    process.env.RUNNER_TEMP = 'C:/runner/work/_temp'
    existsSyncStub.withArgs('C:/runner/work/_temp').returns(true)
    // expandGlobPattern walks C:/actions-runner/*/*/_diag segment by segment
    readdirSyncStub.withArgs('C:/actions-runner').returns(['cached'])
    readdirSyncStub.withArgs('C:/actions-runner/cached').returns(['2.334.0'])
    readdirSyncStub.withArgs('C:/actions-runner/cached/2.334.0/_diag', sinon.match.object).returns([
      { isFile: () => true, name: 'Worker_20240115-102345-12345.log' },
    ])
    readFileSyncStub
      .withArgs('C:/actions-runner/cached/2.334.0/_diag/Worker_20240115-102345-12345.log', 'utf8')
      .returns(LOG_CONTENT)

    assert.strictEqual(getJobIDFromDiagFileWin(), '9876543210')
  })

  it('finds job ID via flat layout C:/actions-runner/_diag (mirrors runner_legacy fixture)', () => {
    process.env.RUNNER_TEMP = 'C:/runner_legacy/work/_temp'
    existsSyncStub.withArgs('C:/runner_legacy/work/_temp').returns(true)
    // No nested dirs — patterns yield nothing; the well-known literal succeeds directly.
    readdirSyncStub.withArgs('C:/actions-runner/_diag', sinon.match.object).returns([
      { isFile: () => true, name: 'Worker_legacy.log' },
    ])
    readFileSyncStub.withArgs('C:/actions-runner/_diag/Worker_legacy.log', 'utf8').returns(LOG_CONTENT)

    assert.strictEqual(getJobIDFromDiagFileWin(), '9876543210')
  })

  it('returns null when Worker log contains no job ID (mirrors runner_empty fixture)', () => {
    process.env.RUNNER_TEMP = 'C:/runner_empty/work/_temp'
    existsSyncStub.withArgs('C:/runner_empty/work/_temp').returns(true)
    readdirSyncStub.withArgs('C:/actions-runner/_diag', sinon.match.object).returns([
      { isFile: () => true, name: 'Worker_empty.log' },
    ])
    readFileSyncStub.withArgs('C:/actions-runner/_diag/Worker_empty.log', 'utf8').returns('')

    assert.strictEqual(getJobIDFromDiagFileWin(), null)
  })
})
