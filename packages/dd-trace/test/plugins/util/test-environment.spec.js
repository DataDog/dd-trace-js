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

const { getCIMetadata, expandGlobPattern, getJobIDFromDiagFile } = require('../../../src/plugins/util/ci')
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
