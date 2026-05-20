'use strict'

const assert = require('node:assert/strict')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('nyc instrumentation', () => {
  const rootDir = '/repo'

  function loadNycInstrumentation ({ coverageBackfill } = {}) {
    let hook
    const channels = {}
    const setupSettingsCachePath = sinon.spy()
    const readCoverageBackfillFromCache = sinon.stub().returns(coverageBackfill)
    const applySkippedCoverageToCoverage = sinon.spy()
    const wrap = sinon.spy((target, method, wrapper) => {
      target[method] = wrapper(target[method])
    })
    const addHook = sinon.spy((options, transform) => {
      hook = transform
    })
    const channel = (name) => {
      channels[name] ??= {
        hasSubscribers: false,
        publish: sinon.spy(),
      }
      return channels[name]
    }

    proxyquire.noPreserveCache().noCallThru()('../src/nyc', {
      '../../datadog-shimmer': { wrap },
      '../../dd-trace/src/ci-visibility/test-optimization-cache': {
        readCoverageBackfillFromCache,
        setupSettingsCachePath,
      },
      '../../dd-trace/src/config/helper': {
        getEnvironmentVariable: sinon.stub(),
      },
      '../../dd-trace/src/plugins/util/test': {
        applySkippedCoverageToCoverage,
      },
      './helpers/instrument': {
        addHook,
        channel,
      },
    })

    return {
      addHook,
      applySkippedCoverageToCoverage,
      hook,
      readCoverageBackfillFromCache,
      setupSettingsCachePath,
      wrap,
    }
  }

  function getNycPackage (getCoverageMapFromAllCoverageFiles) {
    function Nyc () {
      this.cwd = rootDir
    }

    Nyc.prototype.getCoverageMapFromAllCoverageFiles = getCoverageMapFromAllCoverageFiles
    Nyc.prototype.wrap = sinon.spy()
    Nyc.prototype.report = function (...args) {
      return this.getCoverageMapFromAllCoverageFiles(...args)
    }

    return Nyc
  }

  function countCoverageMapWraps (wrap) {
    return wrap.getCalls()
      .filter(call => call.args[1] === 'getCoverageMapFromAllCoverageFiles')
      .length
  }

  it('registers the nyc hook and initializes the settings cache path', () => {
    const { addHook, hook, setupSettingsCachePath } = loadNycInstrumentation()
    const Nyc = getNycPackage(sinon.spy())

    assert.deepStrictEqual(addHook.firstCall.args[0], {
      name: 'nyc',
      versions: ['>=17'],
    })

    assert.strictEqual(hook(Nyc), Nyc)
    sinon.assert.calledOnce(setupSettingsCachePath)
  })

  it('applies cached coverage backfill to synchronous coverage maps before reporting', () => {
    const coverageBackfill = { 'src/skipped.js': 'AQ==' }
    const coverageMap = { files: [] }
    const getCoverageMapFromAllCoverageFiles = sinon.stub().returns(coverageMap)
    const {
      applySkippedCoverageToCoverage,
      hook,
      readCoverageBackfillFromCache,
      wrap,
    } = loadNycInstrumentation({ coverageBackfill })
    const Nyc = getNycPackage(getCoverageMapFromAllCoverageFiles)

    hook(Nyc)
    const nyc = new Nyc()
    const result = nyc.report('text-summary')

    assert.strictEqual(result, coverageMap)
    sinon.assert.calledOnceWithExactly(getCoverageMapFromAllCoverageFiles, 'text-summary')
    sinon.assert.calledOnce(readCoverageBackfillFromCache)
    sinon.assert.calledOnceWithExactly(
      applySkippedCoverageToCoverage,
      coverageMap,
      coverageBackfill,
      rootDir
    )
    assert.strictEqual(countCoverageMapWraps(wrap), 1)
  })

  it('applies cached coverage backfill to asynchronous coverage maps before reporting', async () => {
    const coverageBackfill = { 'src/skipped.js': 'AQ==' }
    const coverageMap = { files: [] }
    const getCoverageMapFromAllCoverageFiles = sinon.stub().resolves(coverageMap)
    const {
      applySkippedCoverageToCoverage,
      hook,
    } = loadNycInstrumentation({ coverageBackfill })
    const Nyc = getNycPackage(getCoverageMapFromAllCoverageFiles)

    hook(Nyc)
    const nyc = new Nyc()
    const result = await nyc.report()

    assert.strictEqual(result, coverageMap)
    sinon.assert.calledOnceWithExactly(
      applySkippedCoverageToCoverage,
      coverageMap,
      coverageBackfill,
      rootDir
    )
  })

  it('wraps each nyc instance only once', () => {
    const coverageBackfill = { 'src/skipped.js': 'AQ==' }
    const coverageMap = { files: [] }
    const getCoverageMapFromAllCoverageFiles = sinon.stub().returns(coverageMap)
    const {
      applySkippedCoverageToCoverage,
      hook,
      readCoverageBackfillFromCache,
      wrap,
    } = loadNycInstrumentation({ coverageBackfill })
    const Nyc = getNycPackage(getCoverageMapFromAllCoverageFiles)

    hook(Nyc)
    const nyc = new Nyc()
    nyc.report()
    nyc.report()

    assert.strictEqual(countCoverageMapWraps(wrap), 1)
    sinon.assert.calledOnce(readCoverageBackfillFromCache)
    sinon.assert.calledTwice(applySkippedCoverageToCoverage)
  })

  it('does not wrap coverage map collection without cached coverage backfill', () => {
    const coverageMap = { files: [] }
    const getCoverageMapFromAllCoverageFiles = sinon.stub().returns(coverageMap)
    const {
      applySkippedCoverageToCoverage,
      hook,
      wrap,
    } = loadNycInstrumentation({ coverageBackfill: {} })
    const Nyc = getNycPackage(getCoverageMapFromAllCoverageFiles)

    hook(Nyc)
    const nyc = new Nyc()

    assert.strictEqual(nyc.report(), coverageMap)
    assert.strictEqual(countCoverageMapWraps(wrap), 0)
    sinon.assert.notCalled(applySkippedCoverageToCoverage)
  })
})
