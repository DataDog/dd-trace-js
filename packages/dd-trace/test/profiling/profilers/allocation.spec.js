'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()

require('../../setup/core')

describe('AllocationProfiler', () => {
  let AllocationProfiler
  let clock
  let workerInstance
  let workerOnHandlers
  let memoryUsageStub
  const logger = {
    debug: sinon.spy(),
    info: sinon.spy(),
    warn: sinon.spy(),
    error: sinon.spy(),
  }

  function createProfiler (overrides = {}) {
    return new AllocationProfiler({
      allocationProfiling: {
        maxHeapBytes: 1_073_741_824,
        ...overrides,
      },
      logger,
    })
  }

  function simulateWorkerMessage (msg) {
    const handler = workerOnHandlers.get('message')
    if (handler) handler(msg)
  }

  beforeEach(() => {
    clock = sinon.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })

    workerOnHandlers = new Map()
    workerInstance = new EventEmitter()
    workerInstance.postMessage = sinon.stub()
    workerInstance.terminate = sinon.stub().resolves()
    workerInstance.unref = sinon.stub()
    workerInstance.threadId = 1

    // Override on to also track handlers in our map
    const originalOn = workerInstance.on.bind(workerInstance)
    workerInstance.on = (event, handler) => {
      workerOnHandlers.set(event, handler)
      return originalOn(event, handler)
    }

    memoryUsageStub = sinon.stub(process, 'memoryUsage').returns({
      heapUsed: 100 * 1024 * 1024,
      heapTotal: 200 * 1024 * 1024,
      rss: 300 * 1024 * 1024,
      external: 10 * 1024 * 1024,
      arrayBuffers: 5 * 1024 * 1024,
    })

    AllocationProfiler = proxyquire('../../../src/profiling/profilers/allocation', {
      'node:worker_threads': {
        Worker: sinon.stub().returns(workerInstance),
      },
    })
  })

  afterEach(() => {
    clock.restore()
    memoryUsageStub.restore()
    sinon.restore()
  })

  describe('type', () => {
    it('should return allocation', () => {
      const profiler = createProfiler()
      assert.strictEqual(profiler.type, 'allocation')
    })
  })

  describe('start', () => {
    it('should spawn a worker and wait for ready', () => {
      const profiler = createProfiler()
      profiler.start()

      assert.ok(workerInstance.unref.calledOnce)
    })

    it('should start tracking after receiving ready message', () => {
      const profiler = createProfiler()
      profiler.start()

      simulateWorkerMessage({ type: 'ready' })

      assert.ok(workerInstance.postMessage.calledWith({ type: 'start-tracking' }))
    })

    it('should not start twice', () => {
      const profiler = createProfiler()
      profiler.start()
      profiler.start()

      assert.ok(workerInstance.unref.calledOnce)
    })

    it('should stop window via heap monitor when heap exceeds limit', () => {
      const profiler = createProfiler()
      profiler.start()
      simulateWorkerMessage({ type: 'ready' })
      simulateWorkerMessage({ type: 'tracking-started' })

      // Heap grows past limit
      memoryUsageStub.returns({
        heapUsed: 2 * 1024 * 1024 * 1024,
        heapTotal: 3 * 1024 * 1024 * 1024,
        rss: 4 * 1024 * 1024 * 1024,
        external: 0,
        arrayBuffers: 0,
      })

      // Advance past the 5s heap monitor interval
      clock.tick(5_000)

      const stopCalls = workerInstance.postMessage.getCalls()
        .filter(c => c.args[0]?.type === 'stop-and-build-profile')
      assert.strictEqual(stopCalls.length, 1)
      assert.ok(logger.warn.calledWithMatch(/heap.*exceeds/i))
    })
  })

  describe('profile', () => {
    it('should return null when no window is active', () => {
      const profiler = createProfiler()
      profiler.start()

      const result = profiler.profile(true, new Date(), new Date())
      assert.strictEqual(result, null)
    })

    it('should return a token when window is active', () => {
      const profiler = createProfiler()
      profiler.start()
      simulateWorkerMessage({ type: 'ready' })
      simulateWorkerMessage({ type: 'tracking-started' })

      const token = profiler.profile(true, new Date(), new Date())
      assert.strictEqual(typeof token, 'function')

      const stopCalls = workerInstance.postMessage.getCalls()
        .filter(c => c.args[0]?.type === 'stop-and-build-profile')
      assert.strictEqual(stopCalls.length, 1)
    })

    it('should resolve encode when worker sends profile-result', async () => {
      const profiler = createProfiler()
      profiler.start()
      simulateWorkerMessage({ type: 'ready' })
      simulateWorkerMessage({ type: 'tracking-started' })

      const token = profiler.profile(true, new Date(), new Date())

      const expectedBuffer = Buffer.from('test-profile')
      simulateWorkerMessage({ type: 'profile-result', buffer: expectedBuffer })

      const result = await profiler.encode(token)
      assert.strictEqual(result, expectedBuffer)
    })

    it('should resolve encode without timeline in message', async () => {
      const profiler = createProfiler()
      profiler.start()
      simulateWorkerMessage({ type: 'ready' })
      simulateWorkerMessage({ type: 'tracking-started' })

      const token = profiler.profile(true, new Date(), new Date())

      simulateWorkerMessage({ type: 'profile-result', buffer: Buffer.from('data') })

      const result = await profiler.encode(token)
      assert.deepStrictEqual(result, Buffer.from('data'))
    })
  })

  describe('stop', () => {
    it('should send shutdown to worker', () => {
      const profiler = createProfiler()
      profiler.start()
      profiler.stop()

      const shutdownCalls = workerInstance.postMessage.getCalls()
        .filter(c => c.args[0]?.type === 'shutdown')
      assert.strictEqual(shutdownCalls.length, 1)
    })

    it('should be safe to call when not started', () => {
      const profiler = createProfiler()
      profiler.stop()
    })
  })

  describe('getInfo', () => {
    it('should return an object', () => {
      const profiler = createProfiler()
      assert.deepStrictEqual(profiler.getInfo(), {})
    })
  })

  describe('max window duration', () => {
    it('should stop window and cache profile when max duration timer fires', () => {
      const profiler = createProfiler()
      profiler.start()
      simulateWorkerMessage({ type: 'ready' })
      simulateWorkerMessage({ type: 'tracking-started' })

      // Default max window is 60s
      clock.tick(60_000)

      const stopCalls = workerInstance.postMessage.getCalls()
        .filter(c => c.args[0]?.type === 'stop-and-build-profile')
      assert.strictEqual(stopCalls.length, 1)
    })

    it('should return cached profile when timer fires before profile() call', async () => {
      const profiler = createProfiler()
      profiler.start()
      simulateWorkerMessage({ type: 'ready' })
      simulateWorkerMessage({ type: 'tracking-started' })

      // Timer fires at 30s
      clock.tick(60_000)

      // profile() should return the cached token, not null
      const token = profiler.profile(true, new Date(), new Date())
      assert.strictEqual(typeof token, 'function')

      // Worker sends back the real profile data
      const expectedBuffer = Buffer.from('timer-profile')
      simulateWorkerMessage({ type: 'profile-result', buffer: expectedBuffer })

      const result = await profiler.encode(token)
      assert.strictEqual(result, expectedBuffer)
    })

    it('should restart window after cached profile is consumed', async () => {
      const profiler = createProfiler()
      profiler.start()
      simulateWorkerMessage({ type: 'ready' })
      simulateWorkerMessage({ type: 'tracking-started' })

      clock.tick(60_000)

      const token = profiler.profile(true, new Date(), new Date())

      // Simulate worker responding with profile
      simulateWorkerMessage({ type: 'profile-result', buffer: Buffer.from('data') })
      await profiler.encode(token)

      // Allow microtask (.then) to run
      await new Promise(resolve => { resolve() })

      const startTrackingCalls = workerInstance.postMessage.getCalls()
        .filter(c => c.args[0]?.type === 'start-tracking')
      assert.strictEqual(startTrackingCalls.length, 2, 'should have sent start-tracking again')
    })

    it('should pass correct startDate from window start in timer callback', () => {
      const profiler = createProfiler()
      profiler.start()
      simulateWorkerMessage({ type: 'ready' })
      simulateWorkerMessage({ type: 'tracking-started' })

      const windowStartTime = Date.now()
      clock.tick(60_000)

      const stopCall = workerInstance.postMessage.getCalls()
        .find(c => c.args[0]?.type === 'stop-and-build-profile')
      assert.strictEqual(stopCall.args[0].startDate, windowStartTime)
      assert.strictEqual(stopCall.args[0].endDate, windowStartTime + 60_000)
    })
  })

  describe('worker failure', () => {
    it('should disable profiling on worker error message', () => {
      const profiler = createProfiler()
      profiler.start()
      simulateWorkerMessage({ type: 'error', message: 'something broke' })

      const result = profiler.profile(true, new Date(), new Date())
      assert.strictEqual(result, null)
    })

    it('should disable profiling on worker exit', () => {
      const profiler = createProfiler()
      profiler.start()

      workerInstance.emit('exit', 1)

      const result = profiler.profile(true, new Date(), new Date())
      assert.strictEqual(result, null)
    })

    it('should reject pending profile on worker crash', async () => {
      const profiler = createProfiler()
      profiler.start()
      simulateWorkerMessage({ type: 'ready' })
      simulateWorkerMessage({ type: 'tracking-started' })

      const token = profiler.profile(false, new Date(), new Date())
      assert.strictEqual(typeof token, 'function')

      // Worker crashes while profile is in-flight
      workerInstance.emit('error', new Error('worker crashed'))

      await assert.rejects(profiler.encode(token), {
        message: 'Allocation profiler worker failed',
      })
    })

    it('should reject pending profile on unexpected worker exit', async () => {
      const profiler = createProfiler()
      profiler.start()
      simulateWorkerMessage({ type: 'ready' })
      simulateWorkerMessage({ type: 'tracking-started' })

      const token = profiler.profile(false, new Date(), new Date())
      assert.strictEqual(typeof token, 'function')

      // Worker exits unexpectedly while profile is in-flight
      workerInstance.emit('exit', 1)

      await assert.rejects(profiler.encode(token), {
        message: 'Allocation profiler worker failed',
      })
    })
  })
})
