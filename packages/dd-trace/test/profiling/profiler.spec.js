'use strict'

const t = require('tap')
require('../setup/core')

const expect = require('chai').expect
const sinon = require('sinon')

const SpaceProfiler = require('../../src/profiling/profilers/space')
const WallProfiler = require('../../src/profiling/profilers/wall')
const EventsProfiler = require('../../src/profiling/profilers/events')
const { setTimeout } = require('node:timers/promises')

const samplingContextsAvailable = process.platform !== 'win32'

t.test('profiler', function (t) {
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
      exporterPromise
    // After all profiles resolve, need to wait another microtask
    // tick until _collect method calls _submit to begin the export.
    ]).then(() => Promise.resolve())
  }

  function setUpProfiler () {
    interval = 65 * 1000
    clock = sinon.useFakeTimers()
    exporterPromise = Promise.resolve()
    exporter = {
      export: sinon.stub().returns(exporterPromise)
    }
    consoleLogger = {
      debug: sinon.spy(),
      info: sinon.spy(),
      warn: sinon.spy(),
      error: sinon.spy()
    }

    wallProfile = {}
    wallProfilePromise = Promise.resolve(wallProfile)
    wallProfiler = {
      type: 'wall',
      start: sinon.stub(),
      stop: sinon.stub(),
      profile: sinon.stub().returns('profile'),
      encode: sinon.stub().returns(wallProfilePromise)
    }

    spaceProfile = {}
    spaceProfilePromise = Promise.resolve(spaceProfile)
    spaceProfiler = {
      type: 'space',
      start: sinon.stub(),
      stop: sinon.stub(),
      profile: sinon.stub().returns('profile'),
      encode: sinon.stub().returns(spaceProfilePromise)
    }

    logger = consoleLogger
    exporters = [exporter]
    profilers = [wallProfiler, spaceProfiler]

    sourceMapCreate = sinon.stub()
  }

  t.test('not serverless', function (t) {
    function initProfiler () {
      Profiler = proxyquire('../src/profiling/profiler', {
        '@datadog/pprof': {
          SourceMapper: {
            create: sourceMapCreate
          }
        }
      }).Profiler

      profiler = new Profiler()
    }

    t.beforeEach(() => {
      setUpProfiler()
      initProfiler()
    })

    t.afterEach(() => {
      profiler.stop()
      clock.restore()
    })

    t.test('should start the internal time profilers', async t => {
      await profiler._start({ profilers, exporters })

      sinon.assert.calledOnce(wallProfiler.start)
      sinon.assert.calledOnce(spaceProfiler.start)
      t.end()
    })

    t.test('should start only once', async t => {
      await profiler._start({ profilers, exporters })
      await profiler._start({ profilers, exporters })

      sinon.assert.calledOnce(wallProfiler.start)
      sinon.assert.calledOnce(spaceProfiler.start)
      t.end()
    })

    t.test('should allow configuring exporters by string or string array', async t => {
      const checks = [
        'agent',
        ['agent']
      ]

      for (const exporters of checks) {
        await profiler._start({
          sourceMap: false,
          exporters
        })

        expect(profiler._config.exporters[0].export).to.be.a('function')

        profiler.stop()
      }
      t.end()
    })

    t.test('should allow configuring profilers by string or string arrays', async t => {
      const checks = [
        ['space', SpaceProfiler],
        ['wall', WallProfiler, EventsProfiler],
        ['space,wall', SpaceProfiler, WallProfiler, EventsProfiler],
        ['wall,space', WallProfiler, SpaceProfiler, EventsProfiler],
        [['space', 'wall'], SpaceProfiler, WallProfiler, EventsProfiler],
        [['wall', 'space'], WallProfiler, SpaceProfiler, EventsProfiler]
      ].map(profilers => profilers.filter(profiler => samplingContextsAvailable || profiler !== EventsProfiler))

      for (const [profilers, ...expected] of checks) {
        await profiler._start({
          sourceMap: false,
          profilers
        })

        expect(profiler._config.profilers.length).to.equal(expected.length)
        for (let i = 0; i < expected.length; i++) {
          expect(profiler._config.profilers[i]).to.be.instanceOf(expected[i])
        }

        profiler.stop()
      }
      t.end()
    })

    t.test('should stop the internal profilers', async t => {
      await profiler._start({ profilers, exporters })
      profiler.stop()

      sinon.assert.calledOnce(wallProfiler.stop)
      sinon.assert.calledOnce(spaceProfiler.stop)
      t.end()
    })

    t.test('should stop when starting failed', async t => {
      wallProfiler.start.throws()

      await profiler._start({ profilers, exporters, logger })

      sinon.assert.calledOnce(wallProfiler.stop)
      sinon.assert.calledOnce(spaceProfiler.stop)
      sinon.assert.calledOnce(consoleLogger.error)
      t.end()
    })

    t.test('should stop when capturing failed', async t => {
      wallProfiler.profile.throws(new Error('boom'))

      await profiler._start({ profilers, exporters, logger })

      clock.tick(interval)

      sinon.assert.calledOnce(wallProfiler.stop)
      sinon.assert.calledOnce(spaceProfiler.stop)
      sinon.assert.calledOnce(consoleLogger.error)
      sinon.assert.notCalled(wallProfiler.encode)
      sinon.assert.notCalled(spaceProfiler.encode)
      sinon.assert.notCalled(exporter.export)
      t.end()
    })

    t.test('should not stop when encoding failed', async t => {
      const rejected = Promise.reject(new Error('boom'))
      wallProfiler.encode.returns(rejected)

      await profiler._start({ profilers, exporters, logger })

      clock.tick(interval)

      await rejected.catch(() => {})
      await setTimeout(1)

      sinon.assert.notCalled(wallProfiler.stop)
      sinon.assert.notCalled(spaceProfiler.stop)
      sinon.assert.calledOnce(consoleLogger.error)
      sinon.assert.calledOnce(exporter.export)
      t.end()
    })

    t.test('should not stop when exporting failed', async t => {
      const rejected = Promise.reject(new Error('boom'))
      exporter.export.returns(rejected)

      await profiler._start({ profilers, exporters, logger })

      clock.tick(interval)

      await rejected.catch(() => {})
      await setTimeout(1)

      sinon.assert.notCalled(wallProfiler.stop)
      sinon.assert.notCalled(spaceProfiler.stop)
      sinon.assert.calledOnce(exporter.export)
      t.end()
    })

    t.test('should flush when the interval is reached', async t => {
      await profiler._start({ profilers, exporters })

      clock.tick(interval)

      await waitForExport()

      sinon.assert.calledOnce(exporter.export)
      t.end()
    })

    t.test('should flush when the profiler is stopped', async t => {
      await profiler._start({ profilers, exporters })

      profiler.stop()

      await waitForExport()

      sinon.assert.calledOnce(exporter.export)
      t.end()
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
        DD_PROFILING_DEBUG_UPLOAD_COMPRESSION: compression
      }
      await profiler._start({ profilers, exporters, tags: { foo: 'foo' } })
      process.env = env

      clock.tick(interval)

      const { profiles, start, end, tags } = await exporterPromise

      expect(profiles).to.have.property('wall')
      expect(profiles.wall).to.be.instanceOf(Buffer)
      expect(profiles.wall.indexOf(magicBytes)).to.equal(0)
      expect(profiles).to.have.property('space')
      expect(profiles.space).to.be.instanceOf(Buffer)
      expect(profiles.space.indexOf(magicBytes)).to.equal(0)
      expect(start).to.be.a('date')
      expect(end).to.be.a('date')
      expect(end - start).to.equal(65000)
      expect(tags).to.have.property('foo', 'foo')
    }

    t.test('should export uncompressed profiles', async t => {
      await shouldExportProfiles('off', Buffer.from('uncompressed profile - '))
      t.end()
    })

    t.test('should export gzip profiles', async t => {
      await shouldExportProfiles('gzip', Buffer.from([0x1f, 0x8b]))
      t.end()
    })

    t.test('should export zstd profiles', async function (t) {
      await shouldExportProfiles('zstd', Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
      t.end()
    })

    t.test('should export gzip profiles with a level', async t => {
      await shouldExportProfiles('gzip-3', Buffer.from([0x1f, 0x8b]))
      t.end()
    })

    t.test('should export zstd profiles with a level', async function (t) {
      await shouldExportProfiles('zstd-4', Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
      t.end()
    })

    t.test('should log exporter errors', async t => {
      exporter.export.rejects(new Error('boom'))

      await profiler._start({ profilers, exporters, logger })

      clock.tick(interval)

      await waitForExport()

      sinon.assert.calledOnce(consoleLogger.warn)
      t.end()
    })

    t.test('should log encoded profile', async t => {
      exporter.export.rejects(new Error('boom'))

      await profiler._start({ profilers, exporters, logger })

      clock.tick(interval)

      await waitForExport()
      await setTimeout(1)

      const [
        startWall,
        startSpace,
        collectWall,
        collectSpace,
        submit
      ] = consoleLogger.debug.getCalls()

      sinon.assert.calledWithMatch(startWall, 'Started wall profiler')
      sinon.assert.calledWithMatch(startSpace, 'Started space profiler')

      expect(collectWall.args[0]()).to.match(/^Collected wall profile: /)
      expect(collectSpace.args[0]()).to.match(/^Collected space profile: /)

      sinon.assert.calledWithMatch(submit, 'Submitted profiles')
      t.end()
    })

    t.test('should have a new start time for each capture', async t => {
      await profiler._start({ profilers, exporters })

      clock.tick(interval)
      await waitForExport()

      const { start, end } = exporter.export.args[0][0]
      expect(start).to.be.a('date')
      expect(end).to.be.a('date')
      expect(end - start).to.equal(65000)

      sinon.assert.calledOnce(exporter.export)

      exporter.export.resetHistory()

      clock.tick(interval)
      await waitForExport()

      const { start: start2, end: end2 } = exporter.export.args[0][0]
      expect(start2).to.be.greaterThanOrEqual(end)
      expect(start2).to.be.a('date')
      expect(end2).to.be.a('date')
      expect(end2 - start2).to.equal(65000)

      sinon.assert.calledOnce(exporter.export)
      t.end()
    })

    t.test('should not pass source mapper to profilers when disabled', async t => {
      await profiler._start({ profilers, exporters, sourceMap: false })

      const options = profilers[0].start.args[0][0]
      expect(options).to.have.property('mapper', undefined)
      t.end()
    })

    t.test('should pass source mapper to profilers when enabled', async t => {
      const mapper = {}
      sourceMapCreate.returns(mapper)
      await profiler._start({ profilers, exporters, sourceMap: true })

      const options = profilers[0].start.args[0][0]
      expect(options).to.have.property('mapper')
        .which.equals(mapper)
      t.end()
    })

    t.test('should work with a root working dir and source maps on', async t => {
      const error = new Error('fail')
      sourceMapCreate.rejects(error)
      await profiler._start({ profilers, exporters, logger, sourceMap: true })
      expect(consoleLogger.error.args[0][0]).to.equal(error)
      expect(profiler._enabled).to.equal(true)
      t.end()
    })
    t.end()
  })

  t.test('serverless', function (t) {
    const flushAfterIntervals = 65

    function initServerlessProfiler () {
      Profiler = proxyquire('../src/profiling/profiler', {
        '@datadog/pprof': {
          SourceMapper: {
            create: sourceMapCreate
          }
        }
      }).ServerlessProfiler

      interval = 1 * 1000

      profiler = new Profiler()
    }

    t.beforeEach(() => {
      process.env.AWS_LAMBDA_FUNCTION_NAME = 'foobar'
      setUpProfiler()
      initServerlessProfiler()
    })

    t.afterEach(() => {
      profiler.stop()
      clock.restore()
      delete process.env.AWS_LAMBDA_FUNCTION_NAME
    })

    t.test('should increment profiled intervals after one interval elapses', async t => {
      await profiler._start({ profilers, exporters })
      expect(profiler._profiledIntervals).to.equal(0)

      clock.tick(interval)

      expect(profiler._profiledIntervals).to.equal(1)
      sinon.assert.notCalled(exporter.export)
      t.end()
    })

    t.test('should flush when flush after intervals is reached', async t => {
      await profiler._start({ profilers, exporters })

      // flushAfterIntervals + 1 becauses flushes after last interval
      for (let i = 0; i < flushAfterIntervals + 1; i++) {
        clock.tick(interval)
      }

      await waitForExport()

      sinon.assert.calledOnce(exporter.export)
      t.end()
    })
    t.end()
  })
  t.end()
})
