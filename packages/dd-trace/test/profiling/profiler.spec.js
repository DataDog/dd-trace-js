'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

describe('profiler', function () {
  let Profiler
  let profiler
  let wallProfiler
  let wallProfile
  let wallProfilePromise
  let spaceProfiler
  let spaceProfile
  let spaceProfilePromise
  let clock
  let exporter
  let exporterPromise
  let exporters
  let profilers
  let consoleLogger
  let logger
  let sourceMapCreate
  let interval

  function waitForExport () {
    return Promise.all([
      wallProfilePromise,
      spaceProfilePromise,
      exporterPromise,
    // After all profiles resolve, need to wait another microtask
    // tick until _collect method calls _submit to begin the export.
    ]).then(() => Promise.resolve())
  }

  function setUpProfiler () {
    interval = 65 * 1000
    clock = sinon.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })
    exporterPromise = Promise.resolve()
    exporter = {
      export: sinon.stub().returns(exporterPromise),
    }
    consoleLogger = {
      debug: sinon.spy(),
      info: sinon.spy(),
      warn: sinon.spy(),
      error: sinon.spy(),
    }

    wallProfile = {}
    wallProfilePromise = Promise.resolve(wallProfile)
    wallProfiler = {
      type: 'wall',
      start: sinon.stub(),
      stop: sinon.stub(),
      profile: sinon.stub().returns('profile'),
      getInfo: sinon.stub().returns({}),
      encode: sinon.stub().returns(wallProfilePromise),
    }

    spaceProfile = {}
    spaceProfilePromise = Promise.resolve(spaceProfile)
    spaceProfiler = {
      type: 'space',
      start: sinon.stub(),
      stop: sinon.stub(),
      profile: sinon.stub().returns('profile'),
      getInfo: sinon.stub().returns({}),
      encode: sinon.stub().returns(spaceProfilePromise),
    }

    logger = consoleLogger
    exporters = [exporter]
    profilers = [wallProfiler, spaceProfiler]

    sourceMapCreate = sinon.stub()
  }

  function makeStartOptions (overrides = {}) {
    return {
      profilers,
      exporters,
      url: 'http://127.0.0.1:8126',
      ...overrides,
    }
  }

  describe('not serverless', function () {
    function initProfiler () {
      Profiler = proxyquire('../../src/profiling/profiler', {
        '@datadog/pprof': {
          SourceMapper: {
            create: sourceMapCreate,
          },
        },
      }).Profiler

      profiler = new Profiler()
    }

    beforeEach(() => {
      setUpProfiler()
      initProfiler()
    })

    afterEach(() => {
      profiler.stop()
      clock.restore()
    })

    it('should start the internal time profilers', async () => {
      await profiler._start(makeStartOptions())

      sinon.assert.calledOnce(wallProfiler.start)
      sinon.assert.calledOnce(spaceProfiler.start)
    })

    it('should start only once', async () => {
      await profiler._start(makeStartOptions())
      await profiler._start(makeStartOptions())

      sinon.assert.calledOnce(wallProfiler.start)
      sinon.assert.calledOnce(spaceProfiler.start)
    })

    it('should stop the internal profilers', async () => {
      await profiler._start(makeStartOptions())
      profiler.stop()

      sinon.assert.calledOnce(wallProfiler.stop)
      sinon.assert.calledOnce(spaceProfiler.stop)
    })

    it('should stop when starting failed', async () => {
      wallProfiler.start.throws()

      await profiler._start(makeStartOptions({ logger }))

      sinon.assert.calledOnce(wallProfiler.stop)
      sinon.assert.calledOnce(spaceProfiler.stop)
      sinon.assert.calledOnce(consoleLogger.error)
    })

    it('should stop when capturing failed', async () => {
      wallProfiler.profile.throws(new Error('boom'))

      await profiler._start(makeStartOptions({ logger }))

      clock.tick(interval)

      sinon.assert.calledOnce(wallProfiler.stop)
      sinon.assert.calledOnce(spaceProfiler.stop)
      sinon.assert.calledOnce(consoleLogger.error)
      sinon.assert.notCalled(wallProfiler.encode)
      sinon.assert.notCalled(spaceProfiler.encode)
      sinon.assert.notCalled(exporter.export)
    })

    it('should not stop when encoding failed', async () => {
      const rejected = Promise.reject(new Error('boom'))
      wallProfiler.encode.returns(rejected)

      await profiler._start(makeStartOptions({ logger }))

      clock.tick(interval)

      await rejected.catch(() => {})
      await clock.tickAsync(1)

      sinon.assert.notCalled(wallProfiler.stop)
      sinon.assert.notCalled(spaceProfiler.stop)
      sinon.assert.calledOnce(consoleLogger.error)
      sinon.assert.calledOnce(exporter.export)
    })

    it('should not stop when exporting failed', async () => {
      const rejected = Promise.reject(new Error('boom'))
      exporter.export.returns(rejected)

      await profiler._start(makeStartOptions({ logger }))

      clock.tick(interval)

      await rejected.catch(() => {})
      await clock.tickAsync(1)

      sinon.assert.notCalled(wallProfiler.stop)
      sinon.assert.notCalled(spaceProfiler.stop)
      sinon.assert.calledOnce(exporter.export)
    })

    it('should flush when the interval is reached', async () => {
      await profiler._start(makeStartOptions())

      clock.tick(interval)

      await waitForExport()

      sinon.assert.calledOnce(exporter.export)
    })

    it('should flush when the profiler is stopped', async () => {
      await profiler._start(makeStartOptions())

      profiler.stop()

      await waitForExport()

      sinon.assert.calledOnce(exporter.export)
    })

    async function shouldExportProfiles (compression, magicBytes) {
      wallProfile = Buffer.from('uncompressed profile - wall')
      wallProfilePromise = Promise.resolve(wallProfile)
      wallProfiler.encode.returns(wallProfilePromise)
      spaceProfile = Buffer.from('uncompressed profile - space')
      spaceProfilePromise = Promise.resolve(spaceProfile)
      spaceProfiler.encode.returns(spaceProfilePromise)

      exporterPromise = new Promise(resolve => {
        exporter.export = (exportSpec) => {
          resolve(exportSpec)
          return exporterPromise
        }
      })

      const env = process.env
      process.env = {
        DD_PROFILING_DEBUG_UPLOAD_COMPRESSION: compression,
      }
      await profiler._start(makeStartOptions({ tags: { foo: 'foo' } }))
      process.env = env

      clock.tick(interval)

      const { profiles, start, end, tags } = await exporterPromise

      assert.ok(Object.hasOwn(profiles, 'wall'))
      assert.ok(profiles.wall instanceof Buffer)
      assert.strictEqual(profiles.wall.indexOf(magicBytes), 0)
      assert.ok(Object.hasOwn(profiles, 'space'))
      assert.ok(profiles.space instanceof Buffer)
      assert.strictEqual(profiles.space.indexOf(magicBytes), 0)
      assert.ok(start instanceof Date)
      assert.ok(end instanceof Date)
      assert.strictEqual(end.getTime() - start.getTime(), 65000)
      assert.strictEqual(tags.foo, 'foo')
    }

    it('should export uncompressed profiles', async () => {
      await shouldExportProfiles('off', Buffer.from('uncompressed profile - '))
    })

    it('should export gzip profiles', async () => {
      await shouldExportProfiles('gzip', Buffer.from([0x1f, 0x8b]))
    })

    it('should export zstd profiles', async function () {
      await shouldExportProfiles('zstd', Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
    })

    it('should export gzip profiles with a level', async () => {
      await shouldExportProfiles('gzip-3', Buffer.from([0x1f, 0x8b]))
    })

    it('should export zstd profiles with a level', async function () {
      await shouldExportProfiles('zstd-4', Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
    })

    it('should log exporter errors', async () => {
      exporter.export.rejects(new Error('boom'))

      await profiler._start(makeStartOptions({ logger }))

      clock.tick(interval)

      await waitForExport()

      sinon.assert.calledOnce(consoleLogger.warn)
    })

    it('should log encoded profile', async () => {
      exporter.export.rejects(new Error('boom'))

      await profiler._start(makeStartOptions({ logger }))

      clock.tick(interval)

      await waitForExport()
      await clock.tickAsync(1)

      const [
        startWall,
        startSpace,
        collectWall,
        collectSpace,
        submit,
      ] = consoleLogger.debug.getCalls()

      sinon.assert.calledWithMatch(startWall, 'Started wall profiler')
      sinon.assert.calledWithMatch(startSpace, 'Started space profiler')

      assert.match(collectWall.args[0](), /^Collected wall profile: /)
      assert.match(collectSpace.args[0](), /^Collected space profile: /)

      sinon.assert.calledWithMatch(submit, 'Submitted profiles')
    })

    it('should have a new start time for each capture', async () => {
      await profiler._start(makeStartOptions())

      clock.tick(interval)
      await waitForExport()

      const { start, end } = exporter.export.args[0][0]
      assert.ok(start instanceof Date)
      assert.ok(end instanceof Date)
      assert.strictEqual(end.getTime() - start.getTime(), 65000)

      sinon.assert.calledOnce(exporter.export)

      exporter.export.resetHistory()

      clock.tick(interval)
      await waitForExport()

      const { start: start2, end: end2 } = exporter.export.args[0][0]
      assert.ok(start2 >= end)
      assert.ok(start2 instanceof Date)
      assert.ok(end2 instanceof Date)
      assert.strictEqual(end2.getTime() - start2.getTime(), 65000)

      sinon.assert.calledOnce(exporter.export)
    })

    it('should not pass source mapper to profilers when disabled', async () => {
      await profiler._start(makeStartOptions({ sourceMap: false }))

      const options = profilers[0].start.args[0][0]
      assert.strictEqual(options.mapper, undefined)
    })

    it('should pass source mapper to profilers when enabled', async () => {
      const mapper = { infoMap: new Map() }
      sourceMapCreate.returns(Promise.resolve(mapper))
      await profiler._start(makeStartOptions({ sourceMap: true }))

      const options = profilers[0].start.args[0][0]
      assert.ok(Object.hasOwn(options, 'mapper'))
      assert.strictEqual(mapper, options.mapper)
    })

    it('should work with a root working dir and source maps on', async () => {
      const error = new Error('fail')
      sourceMapCreate.rejects(error)
      await profiler._start(makeStartOptions({ logger, sourceMap: true }))
      assert.strictEqual(consoleLogger.error.args[0][0], error)
      assert.strictEqual(profiler.enabled, true)
    })

    it('should have serverless property set to false', () => {
      assert.strictEqual(profiler.serverless, false)
    })

    it('should include serverless: false in export infos', async () => {
      exporterPromise = new Promise(resolve => {
        exporter.export = (exportSpec) => {
          resolve(exportSpec)
          return Promise.resolve()
        }
      })

      await profiler._start(makeStartOptions())

      clock.tick(interval)

      const { infos } = await exporterPromise

      assert.strictEqual(infos.serverless, false)
    })

    it('should include sourceMapCount: 0 when source maps are disabled', async () => {
      exporterPromise = new Promise(resolve => {
        exporter.export = (exportSpec) => {
          resolve(exportSpec)
          return Promise.resolve()
        }
      })

      await profiler._start(makeStartOptions({ sourceMap: false }))

      clock.tick(interval)

      const { infos } = await exporterPromise

      assert.strictEqual(infos.sourceMapCount, 0)
    })

    it('should include sourceMapCount: 0 when no source maps are found', async () => {
      const mapper = { infoMap: new Map() }
      sourceMapCreate.returns(Promise.resolve(mapper))

      exporterPromise = new Promise(resolve => {
        exporter.export = (exportSpec) => {
          resolve(exportSpec)
          return Promise.resolve()
        }
      })

      await profiler._start(makeStartOptions({ sourceMap: true }))

      clock.tick(interval)

      const { infos } = await exporterPromise

      assert.strictEqual(infos.sourceMapCount, 0)
    })

    it('should include sourceMapCount with the number of loaded source maps', async () => {
      const mapper = {
        infoMap: new Map([
          ['file1.js', {}],
          ['file2.js', {}],
          ['file3.js', {}],
        ]),
      }
      sourceMapCreate.returns(Promise.resolve(mapper))

      exporterPromise = new Promise(resolve => {
        exporter.export = (exportSpec) => {
          resolve(exportSpec)
          return Promise.resolve()
        }
      })

      await profiler._start(makeStartOptions({ sourceMap: true }))

      clock.tick(interval)

      const { infos } = await exporterPromise

      assert.strictEqual(infos.sourceMapCount, 3)
    })
  })

  describe('serverless', function () {
    const flushAfterIntervals = 65

    function initServerlessProfiler () {
      Profiler = proxyquire('../../src/profiling/profiler', {
        '@datadog/pprof': {
          SourceMapper: {
            create: sourceMapCreate,
          },
        },
      }).ServerlessProfiler

      interval = 1 * 1000

      profiler = new Profiler()
    }

    beforeEach(() => {
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'foobar'
      setUpProfiler()
      initServerlessProfiler()
    })

    afterEach(() => {
      profiler.stop()
      clock.restore()
      delete process.env.AWS_LAMBDA_FUNCTION_NAME
    })

    it('should increment profiled intervals after one interval elapses', async () => {
      await profiler._start(makeStartOptions())
      assert.strictEqual(profiler.profiledIntervals, 0)

      clock.tick(interval)

      assert.strictEqual(profiler.profiledIntervals, 1)
      sinon.assert.notCalled(exporter.export)
    })

    it('should flush when flush after intervals is reached', async () => {
      await profiler._start(makeStartOptions())

      // flushAfterIntervals + 1 because it flushes after last interval
      for (let i = 0; i < flushAfterIntervals + 1; i++) {
        clock.tick(interval)
      }

      await waitForExport()

      sinon.assert.calledOnce(exporter.export)
    })

    it('should have serverless property set to true', () => {
      assert.strictEqual(profiler.serverless, true)
    })

    it('should include serverless: true in export infos', async () => {
      exporterPromise = new Promise(resolve => {
        exporter.export = (exportSpec) => {
          resolve(exportSpec)
          return Promise.resolve()
        }
      })

      await profiler._start(makeStartOptions())

      // flushAfterIntervals + 1 because it flushes after last interval
      for (let i = 0; i < flushAfterIntervals + 1; i++) {
        clock.tick(interval)
      }

      const { infos } = await exporterPromise

      assert.strictEqual(infos.serverless, true)
    })

    it('should include sourceMapCount in export infos', async () => {
      const mapper = {
        infoMap: new Map([
          ['file1.js', {}],
          ['file2.js', {}],
        ]),
      }
      sourceMapCreate.returns(Promise.resolve(mapper))

      exporterPromise = new Promise(resolve => {
        exporter.export = (exportSpec) => {
          resolve(exportSpec)
          return Promise.resolve()
        }
      })

      await profiler._start(makeStartOptions({ sourceMap: true }))

      // flushAfterIntervals + 1 because it flushes after last interval
      for (let i = 0; i < flushAfterIntervals + 1; i++) {
        clock.tick(interval)
      }

      const { infos } = await exporterPromise

      assert.strictEqual(infos.sourceMapCount, 2)
    })
  })
})
