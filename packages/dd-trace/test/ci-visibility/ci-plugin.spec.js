'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const dc = require('dc-polyfill')
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

  it('clears ITR state when library configuration fails', () => {
    const getLibraryConfiguration = sinon.stub().callsArgWith(1, new Error('settings failed'))
    const addMetadataTags = sinon.stub()
    const onDone = sinon.stub()
    const plugin = createPlugin('jest_worker')
    plugin.tracer._exporter = {
      addMetadataTags,
      getLibraryConfiguration,
    }
    plugin.libraryConfig = { isSuitesSkippingEnabled: true }
    plugin.itrCorrelationId = 'correlation-id'
    plugin.skippableSuitesCoverage = { 'suite.js': 'coverage' }
    plugin.configure({
      enabled: true,
      experimental: {
        exporter: 'jest_worker',
      },
    })

    dc.channel('ci:vitest:library-configuration').publish({
      frameworkVersion: '1.0.0',
      onDone,
    })
    plugin.configure(false)

    assert.strictEqual(plugin.libraryConfig, undefined)
    assert.strictEqual(plugin.itrCorrelationId, undefined)
    assert.strictEqual(plugin.skippableSuitesCoverage, undefined)
    sinon.assert.calledOnce(getLibraryConfiguration)
    sinon.assert.calledOnce(onDone)
  })

  it('uploads regular coverage reports', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-js-coverage-reports-'))
    const regularReportPath = path.join(rootDir, 'lcov.info')

    fs.writeFileSync(regularReportPath, 'regular coverage')

    try {
      const plugin = createPlugin('jest_worker')
      const uploadCoverageReport = sinon.stub().yields()
      plugin.tracer._exporter.uploadCoverageReport = uploadCoverageReport

      plugin.uploadCoverageReports({ rootDir })

      sinon.assert.calledOnce(uploadCoverageReport)
      assert.deepStrictEqual(uploadCoverageReport.firstCall.args[0], {
        filePath: regularReportPath,
        format: 'lcov',
        testEnvironmentMetadata: plugin.testEnvironmentMetadata,
      })
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true })
    }
  })

  it('ignores invalid coverage report roots', () => {
    const invalidRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-js-coverage-reports-'))
    fs.rmSync(invalidRoot, { recursive: true })

    const plugin = createPlugin('jest_worker')
    const uploadCoverageReport = sinon.stub().yields()
    plugin.tracer._exporter.uploadCoverageReport = uploadCoverageReport

    try {
      plugin.uploadCoverageReports({ rootDir: invalidRoot })
      fs.writeFileSync(invalidRoot, 'not a directory')
      plugin.uploadCoverageReports({ rootDir: invalidRoot })
      plugin.uploadCoverageReports({ rootDir: Symbol('invalid-root') })

      sinon.assert.notCalled(uploadCoverageReport)
    } finally {
      fs.rmSync(invalidRoot, { force: true })
    }
  })

  it('excludes coverage reports reached through linked directories', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-js-coverage-reports-'))
    const rootDir = path.join(fixtureDir, 'root')
    const outsideDir = path.join(fixtureDir, 'outside')
    const linkedRootDir = path.join(fixtureDir, 'linked-root')
    const outsideReportPath = path.join(outsideDir, 'lcov.info')
    const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir'

    fs.mkdirSync(rootDir)
    fs.mkdirSync(outsideDir)
    fs.writeFileSync(outsideReportPath, 'outside coverage')
    fs.symlinkSync(outsideDir, path.join(rootDir, 'coverage'), directoryLinkType)
    fs.symlinkSync(outsideDir, linkedRootDir, directoryLinkType)

    try {
      const plugin = createPlugin('jest_worker')
      const uploadCoverageReport = sinon.stub().yields()
      plugin.tracer._exporter.uploadCoverageReport = uploadCoverageReport

      plugin.uploadCoverageReports({ rootDir })
      plugin.uploadCoverageReports({ rootDir: linkedRootDir })

      sinon.assert.notCalled(uploadCoverageReport)
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true })
    }
  })

  it('excludes symlinked coverage report files', function () {
    if (process.platform === 'win32') this.skip()

    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-js-coverage-reports-'))
    const rootDir = path.join(fixtureDir, 'root')
    const outsideReportPath = path.join(fixtureDir, 'outside.info')

    fs.mkdirSync(rootDir)
    fs.writeFileSync(outsideReportPath, 'outside coverage')
    fs.symlinkSync(outsideReportPath, path.join(rootDir, 'lcov.info'))

    try {
      const plugin = createPlugin('jest_worker')
      const uploadCoverageReport = sinon.stub().yields()
      plugin.tracer._exporter.uploadCoverageReport = uploadCoverageReport

      plugin.uploadCoverageReports({ rootDir })

      sinon.assert.notCalled(uploadCoverageReport)
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true })
    }
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

  it('adds a new DI probe after removing one from the same location', async () => {
    const plugin = createPlugin('jest_worker')
    const setProbePromise = Promise.resolve()
    const addLineProbe = sinon.stub()
      .onFirstCall().returns(['probe-1', setProbePromise])
      .onSecondCall().returns(['probe-2', setProbePromise])
    const removeProbe = sinon.stub().resolves()
    const file = `${plugin.repositoryRoot}/test.js`
    const line = 23
    const error = { stack: `Error: test failed\n    at test (${file}:${line}:5)` }
    plugin.di = { addLineProbe, removeProbe }

    const firstProbe = plugin.addDiProbe(error)
    await plugin.removeDiProbe({ file, line })
    const secondProbe = plugin.addDiProbe(error)

    assert.strictEqual(firstProbe.probeId, 'probe-1')
    assert.strictEqual(secondProbe.probeId, 'probe-2')
    sinon.assert.calledTwice(addLineProbe)
    sinon.assert.calledOnceWithExactly(removeProbe, 'probe-1')
  })

  it('removes all DI probes with Windows-style file paths', async () => {
    const plugin = createPlugin('jest_worker')
    const setProbePromise = Promise.resolve()
    const addLineProbe = sinon.stub()
      .onCall(0).returns(['probe-1', setProbePromise])
      .onCall(1).returns(['probe-2', setProbePromise])
      .onCall(2).returns(['probe-3', setProbePromise])
      .onCall(3).returns(['probe-4', setProbePromise])
    const removeProbe = sinon.stub().resolves()
    const firstFile = 'C:\\repo\\first.spec.js'
    const secondFile = 'C:\\repo\\second.spec.js'
    const firstError = { stack: `Error: first failure\n    at first (${firstFile}:23:5)` }
    const secondError = { stack: `Error: second failure\n    at second (${secondFile}:42:5)` }
    plugin.di = { addLineProbe, removeProbe }
    plugin._setRepositoryRoot('C:\\repo', [])

    plugin.addDiProbe(firstError)
    plugin.addDiProbe(secondError)
    await plugin.removeAllDiProbes()

    assert.deepStrictEqual(removeProbe.args, [['probe-1'], ['probe-2']])

    plugin.addDiProbe(firstError)
    plugin.addDiProbe(secondError)

    sinon.assert.callCount(addLineProbe, 4)
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
