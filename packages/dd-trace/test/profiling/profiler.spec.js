'use strict'

require('../setup/tap')

const expect = require('chai').expect
const sinon = require('sinon')

const SpaceProfiler = require('../../src/profiling/profilers/space')
const WallProfiler = require('../../src/profiling/profilers/wall')

const INTERVAL = 65 * 1000

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

  function waitForExport () {
    return Promise.all([
      wallProfilePromise,
      spaceProfilePromise,
      exporterPromise
    // After all profiles resolve, need to wait another microtask
    // tick until _collect method calls _submit to begin the export.
    ]).then(() => Promise.resolve())
  }

  beforeEach(() => {
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

    Profiler = proxyquire('../src/profiling/profiler', {
      '@datadog/pprof': {
        SourceMapper: {
          create: sourceMapCreate
        }
      }
    }).Profiler

    profiler = new Profiler()
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
      ['wall', WallProfiler],
      ['space,wall', SpaceProfiler, WallProfiler],
      ['wall,space', WallProfiler, SpaceProfiler],
      [['space', 'wall'], SpaceProfiler, WallProfiler],
      [['wall', 'space'], WallProfiler, SpaceProfiler]
    ]

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
    const rejected = Promise.reject(new Error('boom'))
    wallProfiler.encode.returns(rejected)

    await profiler._start({ profilers, exporters, logger })

    clock.tick(INTERVAL)

    await rejected.catch(() => {})

    sinon.assert.calledOnce(wallProfiler.stop)
    sinon.assert.calledOnce(spaceProfiler.stop)
    sinon.assert.calledOnce(consoleLogger.error)
  })

  it('should flush when the interval is reached', async () => {
    await profiler._start({ profilers, exporters })

    clock.tick(INTERVAL)

    await waitForExport()

    sinon.assert.calledOnce(exporter.export)
  })

  it('should export profiles', async () => {
    await profiler._start({ profilers, exporters, tags: { foo: 'foo' } })

    clock.tick(INTERVAL)

    await waitForExport()

    const { profiles, start, end, tags } = exporter.export.args[0][0]

    expect(profiles).to.have.property('wall', wallProfile)
    expect(profiles).to.have.property('space', spaceProfile)
    expect(start).to.be.a('date')
    expect(end).to.be.a('date')
    expect(end - start).to.equal(65000)
    expect(tags).to.have.property('foo', 'foo')
  })

  it('should not start when disabled', async () => {
    await profiler._start({ profilers, exporters, enabled: false })

    sinon.assert.notCalled(wallProfiler.start)
    sinon.assert.notCalled(spaceProfiler.start)
  })

  it('should log exporter errors', async () => {
    exporter.export.rejects(new Error('boom'))

    await profiler._start({ profilers, exporters, logger })

    clock.tick(INTERVAL)

    await waitForExport()

    sinon.assert.calledOnce(consoleLogger.error)
  })

  it('should log encoded profile', async () => {
    exporter.export.rejects(new Error('boom'))

    await profiler._start({ profilers, exporters, logger })

    clock.tick(INTERVAL)

    await waitForExport()

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

  it('should skip submit with no profiles', async () => {
    const start = new Date()
    const end = new Date()
    try {
      await profiler._submit({}, start, end)
      throw new Error('should have got exception from _submit')
    } catch (err) {
      expect(err.message).to.equal('No profiles to submit')
    }
  })

  it('should have a new start time for each capture', async () => {
    await profiler._start({ profilers, exporters })

    clock.tick(INTERVAL)
    await waitForExport()

    const { start, end } = exporter.export.args[0][0]
    expect(start).to.be.a('date')
    expect(end).to.be.a('date')
    expect(end - start).to.equal(65000)

    sinon.assert.calledOnce(exporter.export)

    exporter.export.resetHistory()

    clock.tick(INTERVAL)
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
    expect(profiler._enabled).to.equal(true)
  })
})
