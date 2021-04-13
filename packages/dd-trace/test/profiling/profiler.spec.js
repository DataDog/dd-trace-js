'use strict'

const expect = require('chai').expect
const sinon = require('sinon')
const semver = require('semver')

const INTERVAL = 60 * 1000

if (!semver.satisfies(process.version, '>=10.12')) {
  describe = describe.skip // eslint-disable-line no-global-assign
}

describe('profiler', () => {
  let Profiler
  let profiler
  let cpuProfiler
  let cpuProfile
  let cpuProfilePromise
  let heapProfiler
  let heapProfile
  let heapProfilePromise
  let clock
  let exporter
  let exporters
  let profilers
  let consoleLogger
  let logger

  function waitForExport () {
    return Promise.all([
      cpuProfilePromise,
      heapProfilePromise
    // After all profiles resolve, need to wait another microtask
    // tick until _collect method calls _submit to begin the export.
    ]).then(() => Promise.resolve())
  }

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    exporter = {
      export: sinon.stub().returns(Promise.resolve())
    }
    consoleLogger = {
      debug: sinon.spy(),
      info: sinon.spy(),
      warn: sinon.spy(),
      error: sinon.spy()
    }

    cpuProfile = {}
    cpuProfilePromise = Promise.resolve(cpuProfile)
    cpuProfiler = {
      type: 'cpu',
      start: sinon.stub(),
      stop: sinon.stub(),
      profile: sinon.stub().returns(cpuProfilePromise)
    }

    heapProfile = {}
    heapProfilePromise = Promise.resolve(heapProfile)
    heapProfiler = {
      type: 'heap',
      start: sinon.stub(),
      stop: sinon.stub(),
      profile: sinon.stub().returns(heapProfilePromise)
    }

    logger = consoleLogger
    exporters = [exporter]
    profilers = [cpuProfiler, heapProfiler]

    Profiler = require('../../src/profiling/profiler').Profiler

    profiler = new Profiler()
  })

  afterEach(() => {
    profiler.stop()
    clock.restore()
  })

  it('should start the internal time profilers', () => {
    profiler.start({ profilers, exporters })

    sinon.assert.calledOnce(cpuProfiler.start)
    sinon.assert.calledOnce(heapProfiler.start)
  })

  it('should start only once', () => {
    profiler.start({ profilers, exporters })
    profiler.start({ profilers, exporters })

    sinon.assert.calledOnce(cpuProfiler.start)
    sinon.assert.calledOnce(heapProfiler.start)
  })

  it('should stop the internal profilers', () => {
    profiler.start({ profilers, exporters })
    profiler.stop()

    sinon.assert.calledOnce(cpuProfiler.stop)
    sinon.assert.calledOnce(heapProfiler.stop)
  })

  it('should stop when starting failed', () => {
    cpuProfiler.start.throws()

    profiler.start({ profilers, exporters, logger })

    sinon.assert.calledOnce(cpuProfiler.stop)
    sinon.assert.calledOnce(heapProfiler.stop)
    sinon.assert.calledOnce(consoleLogger.error)
  })

  it('should stop when capturing failed', async () => {
    const rejected = Promise.reject(new Error('boom'))
    cpuProfiler.profile.returns(rejected)

    profiler.start({ profilers, exporters, logger })

    clock.tick(INTERVAL)

    await rejected.catch(() => {})

    sinon.assert.calledOnce(cpuProfiler.stop)
    sinon.assert.calledOnce(heapProfiler.stop)
    sinon.assert.calledOnce(consoleLogger.error)
  })

  it('should flush when the interval is reached', async () => {
    profiler.start({ profilers, exporters })

    clock.tick(INTERVAL)

    await waitForExport()

    sinon.assert.calledOnce(exporter.export)
  })

  it('should export profiles', async () => {
    profiler.start({ profilers, exporters, tags: { foo: 'foo' } })

    clock.tick(INTERVAL)

    await waitForExport()

    const { profiles, start, end, tags } = exporter.export.args[0][0]

    expect(profiles).to.have.property('cpu', cpuProfile)
    expect(profiles).to.have.property('heap', heapProfile)
    expect(start).to.be.a('date')
    expect(end).to.be.a('date')
    expect(end - start).to.equal(60000)
    expect(tags).to.have.property('foo', 'foo')
  })

  it('should not start when disabled', () => {
    profiler.start({ profilers, exporters, enabled: false })

    sinon.assert.notCalled(cpuProfiler.start)
    sinon.assert.notCalled(heapProfiler.start)
  })

  it('should log exporter errors', async () => {
    exporter.export.yields(new Error('boom'))

    profiler.start({ profilers, exporters, logger })

    clock.tick(INTERVAL)

    await waitForExport()

    sinon.assert.calledOnce(consoleLogger.error)
  })
})
