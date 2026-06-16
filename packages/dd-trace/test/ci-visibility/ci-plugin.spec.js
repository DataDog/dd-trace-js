'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

const {
  OS_ARCHITECTURE,
  OS_PLATFORM,
  OS_VERSION,
  RUNTIME_NAME,
  RUNTIME_VERSION,
} = require('../../src/plugins/util/env')
const {
  CI_PROVIDER_NAME,
  CI_WORKSPACE_PATH,
  GIT_BRANCH,
  GIT_COMMIT_HEAD_MESSAGE,
  GIT_COMMIT_HEAD_SHA,
  GIT_COMMIT_MESSAGE,
  GIT_COMMIT_SHA,
  GIT_PULL_REQUEST_BASE_BRANCH_SHA,
  GIT_REPOSITORY_URL,
  GIT_TAG,
} = require('../../src/plugins/util/tags')
const {
  TEST_SOURCE_FILE,
} = require('../../src/plugins/util/test')

describe('CiPlugin', () => {
  let CiPlugin
  let getCodeOwnersFileEntries
  let getRepositoryRoot
  let getTestEnvironmentMetadata

  beforeEach(() => {
    getCodeOwnersFileEntries = sinon.stub()
    getRepositoryRoot = sinon.stub()
    getTestEnvironmentMetadata = sinon.stub().returns(getTestEnvironmentMetadataPayload())

    CiPlugin = proxyquire('../../src/plugins/ci_plugin', {
      './util/git': {
        getRepositoryRoot,
      },
      './util/test': {
        ...require('../../src/plugins/util/test'),
        getCodeOwnersFileEntries,
        getTestEnvironmentMetadata,
      },
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  for (const exporter of ['vitest_worker', 'jest_worker', 'mocha_worker', 'cucumber_worker']) {
    it(`defers repository root and CODEOWNERS discovery in ${exporter} processes`, () => {
      const cwd = sinon.stub(process, 'cwd').returns('/worker-cwd')
      const plugin = createPlugin(exporter)

      assert.strictEqual(plugin.repositoryRoot, '/worker-cwd')
      assert.strictEqual(plugin.codeOwnersEntries, null)
      assert.strictEqual(plugin.shouldSkipGitMetadataExtraction, true)
      sinon.assert.calledWith(
        getTestEnvironmentMetadata,
        getFrameworkFromExporter(exporter),
        sinon.match.object,
        true
      )
      sinon.assert.notCalled(getRepositoryRoot)
      sinon.assert.notCalled(getCodeOwnersFileEntries)
      sinon.assert.called(cwd)
    })
  }

  it('reuses repository root and CODEOWNERS entries received from the coordinator', () => {
    const codeOwnersEntries = [{ pattern: '*.js', owners: ['@datadog-dd-trace-js'] }]
    const plugin = createPlugin('vitest_worker')

    plugin._setRepositoryRoot('/repo-root', codeOwnersEntries)

    assert.strictEqual(plugin.repositoryRoot, '/repo-root')
    assert.strictEqual(plugin.codeOwnersEntries, codeOwnersEntries)
    sinon.assert.notCalled(getRepositoryRoot)
    sinon.assert.notCalled(getCodeOwnersFileEntries)
  })

  it('serializes CODEOWNERS entries before propagating them to workers', () => {
    const codeOwnersEntry = { pattern: '*.js', owners: ['@datadog-dd-trace-js'] }
    Object.defineProperty(codeOwnersEntry, 'regex', { value: /test\.js/ })
    const plugin = createPlugin('vitest_worker')
    plugin._setRepositoryRoot('/repo-root', [codeOwnersEntry])

    const codeOwnersEntries = plugin._getSerializableCodeOwnersEntries()

    assert.deepStrictEqual(codeOwnersEntries, [{ pattern: '*.js', owners: ['@datadog-dd-trace-js'] }])
    assert.notStrictEqual(codeOwnersEntries, plugin.codeOwnersEntries)
    assert.notStrictEqual(codeOwnersEntries[0].owners, codeOwnersEntry.owners)
  })

  it('defers repository root discovery in Playwright workers with a propagated root', () => {
    const previousRepositoryRoot = process.env._DD_TEST_OPT_WORKER_REPOSITORY_ROOT
    process.env._DD_TEST_OPT_WORKER_REPOSITORY_ROOT = '/repo-root'

    try {
      const plugin = createPlugin('playwright_worker')

      assert.strictEqual(plugin.repositoryRoot, '/repo-root')
      assert.strictEqual(plugin.codeOwnersEntries, null)
      assert.strictEqual(plugin.shouldSkipGitMetadataExtraction, true)
      sinon.assert.notCalled(getRepositoryRoot)
      sinon.assert.notCalled(getCodeOwnersFileEntries)
    } finally {
      if (previousRepositoryRoot === undefined) {
        delete process.env._DD_TEST_OPT_WORKER_REPOSITORY_ROOT
      } else {
        process.env._DD_TEST_OPT_WORKER_REPOSITORY_ROOT = previousRepositoryRoot
      }
    }
  })

  it('loads CODEOWNERS when the worker receives the same repository root without parsed entries', () => {
    const codeOwnersEntries = [{ pattern: '*.js', owners: ['@datadog-dd-trace-js'] }]
    const cwd = sinon.stub(process, 'cwd').returns('/repo-root')
    getCodeOwnersFileEntries.returns(codeOwnersEntries)
    const plugin = createPlugin('jest_worker')

    plugin._setRepositoryRoot('/repo-root')

    assert.strictEqual(plugin.repositoryRoot, '/repo-root')
    assert.strictEqual(plugin.codeOwnersEntries, codeOwnersEntries)
    sinon.assert.notCalled(getRepositoryRoot)
    sinon.assert.calledOnceWithExactly(getCodeOwnersFileEntries, '/repo-root')
    sinon.assert.called(cwd)
  })

  it('loads CODEOWNERS lazily if propagated entries were not applied before lookup', () => {
    const codeOwnersEntries = [{ pattern: 'test.js', owners: ['@datadog-dd-trace-js'] }]
    getCodeOwnersFileEntries.returns(codeOwnersEntries)
    const plugin = createPlugin('jest_worker')

    const codeOwners = plugin.getCodeOwners({ [TEST_SOURCE_FILE]: 'test.js' })

    assert.strictEqual(codeOwners, JSON.stringify(['@datadog-dd-trace-js']))
    assert.strictEqual(plugin.codeOwnersEntries, codeOwnersEntries)
    sinon.assert.calledOnceWithExactly(getCodeOwnersFileEntries, plugin.repositoryRoot)
  })

  it('keeps repository root discovery for worker exporters without propagated git metadata', () => {
    const codeOwnersEntries = [{ pattern: '*.js', owners: ['@datadog-dd-trace-js'] }]
    getRepositoryRoot.returns('/repo-root')
    getCodeOwnersFileEntries.returns(codeOwnersEntries)

    const plugin = createPlugin('playwright_worker')

    assert.strictEqual(plugin.repositoryRoot, '/repo-root')
    assert.strictEqual(plugin.codeOwnersEntries, codeOwnersEntries)
    assert.strictEqual(plugin.shouldSkipGitMetadataExtraction, false)
    sinon.assert.calledOnce(getRepositoryRoot)
    sinon.assert.calledOnceWithExactly(getCodeOwnersFileEntries, '/repo-root')
  })

  function createPlugin (exporter) {
    class TestPlugin extends CiPlugin {
      static id = getFrameworkFromExporter(exporter)
    }

    const plugin = new TestPlugin({ _exporter: {} })
    plugin.configure({
      enabled: false,
      experimental: {
        exporter,
      },
    })
    return plugin
  }
})

function getFrameworkFromExporter (exporter) {
  return exporter.slice(0, -'_worker'.length)
}

function getTestEnvironmentMetadataPayload () {
  return {
    [GIT_REPOSITORY_URL]: 'git@github.com:DataDog/dd-trace-js.git',
    [GIT_COMMIT_SHA]: 'abc123',
    [OS_VERSION]: 'test-os-version',
    [OS_PLATFORM]: 'test-os-platform',
    [OS_ARCHITECTURE]: 'test-os-architecture',
    [RUNTIME_NAME]: 'node',
    [RUNTIME_VERSION]: process.version,
    [GIT_BRANCH]: 'test-branch',
    [CI_PROVIDER_NAME]: 'github',
    [CI_WORKSPACE_PATH]: undefined,
    [GIT_COMMIT_MESSAGE]: 'test commit',
    [GIT_TAG]: undefined,
    [GIT_PULL_REQUEST_BASE_BRANCH_SHA]: undefined,
    [GIT_COMMIT_HEAD_SHA]: undefined,
    [GIT_COMMIT_HEAD_MESSAGE]: undefined,
  }
}
