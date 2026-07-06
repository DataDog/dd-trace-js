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

  it('defers repository root and CODEOWNERS discovery in Vitest workers', () => {
    const cwd = sinon.stub(process, 'cwd').returns('/worker-cwd')
    const plugin = createPlugin('vitest_worker')

    assert.strictEqual(plugin.repositoryRoot, '/worker-cwd')
    assert.strictEqual(plugin.codeOwnersEntries, null)
    assert.strictEqual(plugin.shouldSkipGitMetadataExtraction, true)
    sinon.assert.calledWith(getTestEnvironmentMetadata, 'vitest', sinon.match.object, true)
    sinon.assert.notCalled(getRepositoryRoot)
    sinon.assert.notCalled(getCodeOwnersFileEntries)
    sinon.assert.called(cwd)
  })

  it('reuses repository root and CODEOWNERS entries received from the Vitest coordinator', () => {
    const codeOwnersEntries = [{ pattern: '*.js', owners: ['@datadog-dd-trace-js'] }]
    const plugin = createPlugin('vitest_worker')

    plugin._setRepositoryRoot('/repo-root', codeOwnersEntries)

    assert.strictEqual(plugin.repositoryRoot, '/repo-root')
    assert.strictEqual(plugin.codeOwnersEntries, codeOwnersEntries)
    sinon.assert.notCalled(getRepositoryRoot)
    sinon.assert.notCalled(getCodeOwnersFileEntries)
  })

  it('keeps repository root discovery for non-Vitest workers', () => {
    const codeOwnersEntries = [{ pattern: '*.js', owners: ['@datadog-dd-trace-js'] }]
    getRepositoryRoot.returns('/repo-root')
    getCodeOwnersFileEntries.returns(codeOwnersEntries)

    const plugin = createPlugin('jest_worker')

    assert.strictEqual(plugin.repositoryRoot, '/repo-root')
    assert.strictEqual(plugin.codeOwnersEntries, codeOwnersEntries)
    assert.strictEqual(plugin.shouldSkipGitMetadataExtraction, true)
    sinon.assert.calledOnce(getRepositoryRoot)
    sinon.assert.calledOnceWithExactly(getCodeOwnersFileEntries, '/repo-root')
  })

  it('starts the DI breakpoint-hit timeout when waiting, not when preparing', async () => {
    const plugin = createPlugin('jest_worker')
    const waitForDiOperation = sinon.stub(plugin, 'waitForDiOperation').resolves()
    plugin.di = {
      waitForInFlightBreakpointHits: sinon.stub().resolves(),
    }

    plugin.prepareDiBreakpointHitWait()

    sinon.assert.notCalled(waitForDiOperation)

    const preparedPromise = plugin.diBreakpointHitPromise
    await plugin.waitForDiBreakpointHits()

    sinon.assert.calledOnceWithExactly(waitForDiOperation, preparedPromise)

    plugin.cancelDiBreakpointHitWait()
    await preparedPromise

    assert.strictEqual(plugin.diBreakpointHitPromise, undefined)
    assert.deepStrictEqual(plugin.diBreakpointHitResolvers, [])
  })

  it('cancels a prepared DI breakpoint-hit wait after waiting for it', async () => {
    const plugin = createPlugin('jest_worker')
    const waitForDiOperation = sinon.stub(plugin, 'waitForDiOperation').resolves()
    plugin.di = {}

    const preparedPromise = plugin.prepareDiBreakpointHitWait()

    await plugin.waitForPreparedDiBreakpointHit()
    await preparedPromise

    sinon.assert.calledOnceWithExactly(waitForDiOperation, preparedPromise)
    assert.strictEqual(plugin.diBreakpointHitPromise, undefined)
    assert.deepStrictEqual(plugin.diBreakpointHitResolvers, [])
  })

  it('exports DI breakpoint hits with the debugger log envelope', () => {
    const plugin = createPlugin('vitest_worker')
    const exportDiLogs = sinon.spy()
    const snapshot = {
      id: 'snapshot-id',
      probe: {
        location: {
          file: 'test.js',
          lines: ['23'],
        },
      },
      stack: [{ function: 'test function' }],
    }

    plugin.tracer._exporter.exportDiLogs = exportDiLogs
    plugin.activeTestSpan = {
      context: () => ({
        _isFinished: false,
        toTraceId: () => 'trace-id',
        toSpanId: () => 'span-id',
      }),
      setTag: sinon.spy(),
    }
    plugin.testErrorStackIndex = 0

    plugin.onDiBreakpointHit({ snapshot })

    sinon.assert.calledOnce(exportDiLogs)
    assert.strictEqual(exportDiLogs.firstCall.args[0], plugin.testEnvironmentMetadata)
    const logMessage = exportDiLogs.firstCall.args[1]
    assert.strictEqual(logMessage.message, '')
    assert.deepStrictEqual(logMessage.debugger, { snapshot })
    assert.deepStrictEqual(logMessage.dd, {
      trace_id: 'trace-id',
      span_id: 'span-id',
    })
    assert.strictEqual(logMessage.logger.name, 'test.js')
    assert.strictEqual(logMessage.logger.method, 'test function')
    assert.strictEqual(typeof logMessage.logger.version, 'string')
    assert.match(logMessage.logger.thread_id, /^pid:\d+/)
    assert.match(logMessage.logger.thread_name, /^(MainThread|WorkerThread:\d+)$/)
  })

  function createPlugin (exporter) {
    class TestPlugin extends CiPlugin {
      static id = 'vitest'
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
