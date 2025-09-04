'use strict'

const { expect } = require('chai')
// const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const { setTimeout } = require('node:timers/promises')

require('tap').mochaGlobals()
require('../setup/core')

const SpaceProfiler = require('../../src/profiling/profilers/space')
const WallProfiler = require('../../src/profiling/profilers/wall')
const EventsProfiler = require('../../src/profiling/profilers/events')

const samplingContextsAvailable = process.platform !== 'win32'

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

  describe('not serverless', function () {
    function initProfiler () {
      Profiler = proxyquire('../../src/profiling/profiler', {
        '@datadog/pprof': {
          SourceMapper: {
            create: sourceMapCreate
          }
        }
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
      await profiler._start({ profilers, exporters })

      sinon.assert.calledOnce(wallProfiler.start)
      sinon.assert.calledOnce(spaceProfiler.start)
    })

    it('should start only once', async () => {
      await profiler._start({ profilers, exporters })
      await profiler._start({ profilers, exporters })

      sinon.assert.calledOnce(wallProfiler.start)
      sinon.assert.calledOnce(spaceProfiler.start)
    })

    it('should allow configuring exporters by string or string array', async () => {
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
    })

    it('should allow configuring profilers by string or string arrays', async () => {
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
    })

    it('should stop the internal profilers', async () => {
      await profiler._start({ profilers, exporters })
      profiler.stop()

      sinon.assert.calledOnce(wallProfiler.stop)
      sinon.assert.calledOnce(spaceProfiler.stop)
    })

    it('should stop when starting failed', async () => {
      wallProfiler.start.throws()

      await profiler._start({ profilers, exporters, logger })

      sinon.assert.calledOnce(wallProfiler.stop)
      sinon.assert.calledOnce(spaceProfiler.stop)
      sinon.assert.calledOnce(consoleLogger.error)
    })

    it('should stop when capturing failed', async () => {
      wallProfiler.profile.throws(new Error('boom'))

      await profiler._start({ profilers, exporters, logger })

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

      await profiler._start({ profilers, exporters, logger })

      clock.tick(interval)

      await rejected.catch(() => {})
      await setTimeout(1)

      sinon.assert.notCalled(wallProfiler.stop)
      sinon.assert.notCalled(spaceProfiler.stop)
      sinon.assert.calledOnce(consoleLogger.error)
      sinon.assert.calledOnce(exporter.export)
    })

    it('should not stop when exporting failed', async () => {
      const rejected = Promise.reject(new Error('boom'))
      exporter.export.returns(rejected)

      await profiler._start({ profilers, exporters, logger })

      clock.tick(interval)

      await rejected.catch(() => {})
      await setTimeout(1)

      sinon.assert.notCalled(wallProfiler.stop)
      sinon.assert.notCalled(spaceProfiler.stop)
      sinon.assert.calledOnce(exporter.export)
    })

    it('should flush when the interval is reached', async () => {
      await profiler._start({ profilers, exporters })

      clock.tick(interval)

      await waitForExport()

      sinon.assert.calledOnce(exporter.export)
    })

    it('should flush when the profiler is stopped', async () => {
      await profiler._start({ profilers, exporters })

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

      await profiler._start({ profilers, exporters, logger })

      clock.tick(interval)

      await waitForExport()

      sinon.assert.calledOnce(consoleLogger.warn)
    })

    it('should log encoded profile', async () => {
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
    })

    it('should have a new start time for each capture', async () => {
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
    })

    it('should not pass source mapper to profilers when disabled', async () => {
      await profiler._start({ profilers, exporters, sourceMap: false })

      const options = profilers[0].start.args[0][0]
      expect(options).to.have.property('mapper', undefined)
    })

    it('should pass source mapper to profilers when enabled', async () => {
      const mapper = {}
      sourceMapCreate.returns(mapper)
      await profiler._start({ profilers, exporters, sourceMap: true })

      const options = profilers[0].start.args[0][0]
      expect(options).to.have.property('mapper')
        .which.equals(mapper)
    })

    it('should work with a root working dir and source maps on', async () => {
      const error = new Error('fail')
      sourceMapCreate.rejects(error)
      await profiler._start({ profilers, exporters, logger, sourceMap: true })
      expect(consoleLogger.error.args[0][0]).to.equal(error)
      expect(profiler.enabled).to.equal(true)
    })
  })

  describe('serverless', function () {
    const flushAfterIntervals = 65

    function initServerlessProfiler () {
      Profiler = proxyquire('../../src/profiling/profiler', {
        '@datadog/pprof': {
          SourceMapper: {
            create: sourceMapCreate
          }
        }
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
      await profiler._start({ profilers, exporters })
      expect(profiler.profiledIntervals).to.equal(0)

      clock.tick(interval)

      expect(profiler.profiledIntervals).to.equal(1)
      sinon.assert.notCalled(exporter.export)
    })

    it('should flush when flush after intervals is reached', async () => {
      await profiler._start({ profilers, exporters })

      // flushAfterIntervals + 1 becauses flushes after last interval
      for (let i = 0; i < flushAfterIntervals + 1; i++) {
        clock.tick(interval)
      }

      await waitForExport()

      sinon.assert.calledOnce(exporter.export)
    })
  })
})
