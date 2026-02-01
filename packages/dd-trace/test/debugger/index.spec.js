'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/mocha')

describe('debugger/index', () => {
  let DynamicInstrumentation
  let Worker
  let config
  let rc
  let readFileStub
  let messageChannels

  beforeEach(() => {
    Worker = sinon.stub()
    Worker.prototype.on = sinon.stub().returnsThis()
    Worker.prototype.once = sinon.stub().returnsThis()
    Worker.prototype.unref = sinon.stub()
    Worker.prototype.terminate = sinon.stub()
    Worker.prototype.removeAllListeners = sinon.stub()

    readFileStub = sinon.stub()
    messageChannels = []

    DynamicInstrumentation = proxyquire('../../src/debugger/index', {
      fs: {
        readFile: readFileStub,
      },
      worker_threads: {
        Worker,
        MessageChannel: class MessageChannel {
          constructor () {
            this.port1 = {
              unref: sinon.stub(),
              on: sinon.stub(),
            }
            this.port2 = {
              unref: sinon.stub(),
              on: sinon.stub(),
              postMessage: sinon.stub(),
            }
            messageChannels.push(this)
          }
        },
        threadId: 0,
      },
    })

    config = {
      commitSHA: 'test-sha',
      debug: false,
      dynamicInstrumentation: {
        enabled: true,
      },
      hostname: 'test-host',
      logLevel: 'info',
      port: 8126,
      repositoryUrl: 'https://github.com/test/repo',
      service: 'test-service',
      tags: {
        'runtime-id': 'test-runtime-id',
      },
      url: new URL('http://localhost:8126'),
    }

    rc = {
      setProductHandler: sinon.stub(),
      removeProductHandler: sinon.stub(),
    }
  })

  afterEach(() => {
    // Clean up any started workers
    if (DynamicInstrumentation.isStarted()) {
      DynamicInstrumentation.stop()
    }
  })

  describe('isStarted', () => {
    it('should return false initially', () => {
      assert.strictEqual(DynamicInstrumentation.isStarted(), false)
    })

    it('should return true after start', () => {
      DynamicInstrumentation.start(config, rc)
      assert.strictEqual(DynamicInstrumentation.isStarted(), true)
    })

    it('should return false after stop', () => {
      DynamicInstrumentation.start(config, rc)
      DynamicInstrumentation.stop()
      assert.strictEqual(DynamicInstrumentation.isStarted(), false)
    })
  })

  describe('start', () => {
    it('should not start if already started', () => {
      DynamicInstrumentation.start(config, rc)
      const firstWorker = Worker.lastCall

      DynamicInstrumentation.start(config, rc)
      const secondWorker = Worker.lastCall

      assert.strictEqual(firstWorker, secondWorker)
    })

    it('should set product handler for LIVE_DEBUGGING', () => {
      DynamicInstrumentation.start(config, rc)
      sinon.assert.calledOnceWithExactly(rc.setProductHandler, 'LIVE_DEBUGGING', sinon.match.func)
    })

    it('should unref all handles to prevent keeping process alive', () => {
      DynamicInstrumentation.start(config, rc)

      const worker = Worker.lastCall.returnValue

      // Worker should be unreffed
      sinon.assert.calledOnce(worker.unref)

      // All message channel ports should be unreffed
      assert.strictEqual(messageChannels.length, 3)

      for (const channel of messageChannels) {
        sinon.assert.calledOnce(channel.port1.unref)
        sinon.assert.calledOnce(channel.port2.unref)
      }
    })
  })

  describe('stop', () => {
    it('should change isStarted state to false', () => {
      DynamicInstrumentation.start(config, rc)
      assert.strictEqual(DynamicInstrumentation.isStarted(), true)
      DynamicInstrumentation.stop()
      assert.strictEqual(DynamicInstrumentation.isStarted(), false)
    })

    it('should do nothing if not started', () => {
      DynamicInstrumentation.stop()
      assert.strictEqual(DynamicInstrumentation.isStarted(), false)
      sinon.assert.notCalled(rc.removeProductHandler)
    })

    it('should clean up all resources', () => {
      DynamicInstrumentation.start(config, rc)
      const worker = Worker.lastCall.returnValue

      // Set up some pending ack callbacks to verify they're cleaned up
      const rcHandler = rc.setProductHandler.firstCall.args[1]
      const ackCallback1 = sinon.stub()
      const ackCallback2 = sinon.stub()

      // Simulate remote config sending probes that need acknowledgment
      rcHandler('apply', { id: 'probe1' }, 'config-id-1', ackCallback1)
      rcHandler('apply', { id: 'probe2' }, 'config-id-2', ackCallback2)

      DynamicInstrumentation.stop()

      sinon.assert.calledWith(rc.removeProductHandler, 'LIVE_DEBUGGING')

      // Should remove all listeners from worker
      sinon.assert.calledOnce(worker.removeAllListeners)

      // Should terminate worker
      sinon.assert.calledOnce(worker.terminate)

      // Should invoke all pending ack callbacks with undefined (graceful shutdown)
      sinon.assert.calledOnceWithExactly(ackCallback1, undefined)
      sinon.assert.calledOnceWithExactly(ackCallback2, undefined)

      assert.strictEqual(DynamicInstrumentation.isStarted(), false)
    })

    it('should handle termination errors gracefully', () => {
      DynamicInstrumentation.start(config, rc)
      const worker = Worker.lastCall.returnValue
      const terminationError = new Error('Termination error')
      worker.terminate.throws(terminationError)

      // Set up some pending ack callbacks
      const rcHandler = rc.setProductHandler.firstCall.args[1]
      const ackCallback = sinon.stub()
      rcHandler('apply', { id: 'probe1' }, 'config-id-1', ackCallback)

      // Should not throw
      DynamicInstrumentation.stop()

      assert.strictEqual(DynamicInstrumentation.isStarted(), false)

      // Pending ack callbacks should be invoked with the error
      sinon.assert.calledOnceWithExactly(ackCallback, terminationError)
    })
  })

  describe('configure', () => {
    it('should do nothing if not started', () => {
      // Should not throw
      DynamicInstrumentation.configure(config)
    })

    it('should post message to config channel when started', () => {
      DynamicInstrumentation.start(config, rc)
      const configChannel = messageChannels[2]
      const configPort = configChannel.port2
      configPort.postMessage.resetHistory()

      DynamicInstrumentation.configure(config)

      sinon.assert.calledOnce(configPort.postMessage)

      const postedConfig = configPort.postMessage.firstCall.args[0]
      assert.deepStrictEqual(postedConfig, {
        commitSHA: 'test-sha',
        debug: false,
        dynamicInstrumentation: {
          enabled: true,
        },
        hostname: 'test-host',
        logLevel: 'info',
        port: 8126,
        propagateProcessTags: undefined,
        repositoryUrl: 'https://github.com/test/repo',
        runtimeId: 'test-runtime-id',
        service: 'test-service',
        url: 'http://localhost:8126/',
      })
    })
  })

  describe('lifecycle', () => {
    it('should be able to start again after stopping', () => {
      // First start
      DynamicInstrumentation.start(config, rc)
      assert.strictEqual(DynamicInstrumentation.isStarted(), true)

      const firstWorkerCall = Worker.callCount
      const firstSetProductHandlerCall = rc.setProductHandler.callCount

      // Stop
      DynamicInstrumentation.stop()
      assert.strictEqual(DynamicInstrumentation.isStarted(), false)

      // Start again
      DynamicInstrumentation.start(config, rc)
      assert.strictEqual(DynamicInstrumentation.isStarted(), true)

      // Should have created a new worker
      assert.strictEqual(Worker.callCount, firstWorkerCall + 1)

      // Should have registered product handler again
      assert.strictEqual(rc.setProductHandler.callCount, firstSetProductHandlerCall + 1)
      sinon.assert.calledWith(rc.setProductHandler, 'LIVE_DEBUGGING', sinon.match.func)
    })

    it('should be able to restart after unexpected worker exit', () => {
      // First start
      DynamicInstrumentation.start(config, rc)
      assert.strictEqual(DynamicInstrumentation.isStarted(), true)

      const firstWorker = Worker.lastCall.returnValue
      const exitHandler = firstWorker.once.getCalls().find(call => call.args[0] === 'exit').args[1]

      const firstWorkerCall = Worker.callCount

      // Simulate unexpected exit
      exitHandler(1)
      assert.strictEqual(DynamicInstrumentation.isStarted(), false)

      // Should be able to start again
      DynamicInstrumentation.start(config, rc)
      assert.strictEqual(DynamicInstrumentation.isStarted(), true)

      // Should have created a new worker
      assert.strictEqual(Worker.callCount, firstWorkerCall + 1)
    })
  })

  describe('readProbeFile', () => {
    it('should do nothing when path is not provided', () => {
      // probeFile is undefined by default (not set in config)
      DynamicInstrumentation.start(config, rc)
      sinon.assert.notCalled(readFileStub)
    })

    it('should read and parse valid probe file', () => {
      const probes = [
        { id: 'probe1', type: 'log' },
        { id: 'probe2', type: 'metric' },
      ]
      const probeFileContent = JSON.stringify(probes)
      config.dynamicInstrumentation.probeFile = '/path/to/probes.json'

      readFileStub.callsFake((path, encoding, callback) => {
        callback(null, probeFileContent)
      })

      DynamicInstrumentation.start(config, rc)

      // Verify file was read
      sinon.assert.calledOnce(readFileStub)
      sinon.assert.calledWith(readFileStub, '/path/to/probes.json', 'utf8', sinon.match.func)

      // Verify probes were parsed and posted to probe channel
      const probeChannelPort2 = messageChannels[0].port2
      const postMessageCalls = probeChannelPort2.postMessage.getCalls()

      // Should post a message for each probe with action 'apply'
      assert.strictEqual(postMessageCalls.length, 2)
      assert.deepStrictEqual(postMessageCalls[0].args[0], {
        action: 'apply',
        probe: probes[0],
      })
      assert.deepStrictEqual(postMessageCalls[1].args[0], {
        action: 'apply',
        probe: probes[1],
      })
    })

    it('should handle file read error gracefully', () => {
      config.dynamicInstrumentation.probeFile = '/path/to/missing.json'
      const readError = new Error('ENOENT: no such file or directory')

      readFileStub.callsFake((path, encoding, callback) => {
        callback(readError)
      })

      // Should not throw
      DynamicInstrumentation.start(config, rc)

      sinon.assert.calledOnce(readFileStub)
    })

    it('should handle invalid JSON gracefully', () => {
      config.dynamicInstrumentation.probeFile = '/path/to/invalid.json'
      const invalidJSON = '{ invalid json content'

      readFileStub.callsFake((path, encoding, callback) => {
        callback(null, invalidJSON)
      })

      // Should not throw
      DynamicInstrumentation.start(config, rc)

      sinon.assert.calledOnce(readFileStub)
    })
  })

  describe('ack callback handling', () => {
    let probeChannelPort2
    let messageHandler

    beforeEach(() => {
      DynamicInstrumentation.start(config, rc)
      // The first MessageChannel is the probe channel
      probeChannelPort2 = messageChannels[0].port2
      // Find the message handler registered on port2
      const onCalls = probeChannelPort2.on.getCalls()
      const messageCall = onCalls.find(call => call.args[0] === 'message')
      messageHandler = messageCall.args[1]
    })

    it('should call ack callback with error when ackId is valid', () => {
      const ackCallback = sinon.stub()
      const productHandler = rc.setProductHandler.lastCall.args[1]
      const testError = new Error('Test error')

      // Trigger product handler to register an ack callback
      productHandler('apply', { id: 'probe1' }, 'config-id', ackCallback)

      // Simulate message from worker with error
      messageHandler({ ackId: 1, error: testError })

      sinon.assert.calledOnce(ackCallback)
      sinon.assert.calledWith(ackCallback, testError)
    })

    it('should call ack callback without error when successful', () => {
      const ackCallback = sinon.stub()
      const productHandler = rc.setProductHandler.lastCall.args[1]

      // Trigger product handler to register an ack callback
      productHandler('apply', { id: 'probe1' }, 'config-id', ackCallback)

      // Simulate successful message from worker
      messageHandler({ ackId: 1 })

      sinon.assert.calledOnce(ackCallback)
      sinon.assert.calledWith(ackCallback, undefined)
    })

    it('should delete ack callback after invocation', () => {
      const ackCallback = sinon.stub()
      const productHandler = rc.setProductHandler.lastCall.args[1]

      // Trigger product handler to register an ack callback
      productHandler('apply', { id: 'probe1' }, 'config-id', ackCallback)

      // Simulate message from worker
      messageHandler({ ackId: 1 })

      // Try to trigger the same ackId again
      messageHandler({ ackId: 1 })

      // Ack callback should only be called once
      sinon.assert.calledOnce(ackCallback)
    })

    it('should handle unknown ackId gracefully', () => {
      const testError = new Error('Unknown ackId error')

      // Simulate message with unknown ackId - should not throw
      messageHandler({ ackId: 999, error: testError })
    })

    it('should handle unknown ackId without error gracefully', () => {
      // Simulate message with unknown ackId and no error - should not throw
      messageHandler({ ackId: 999 })
    })
  })

  describe('cleanup with pending acks', () => {
    it('should call pending ack callbacks with error on unexpected exit', () => {
      const ackCallback1 = sinon.stub()
      const ackCallback2 = sinon.stub()
      const ackCallback3 = sinon.stub()

      DynamicInstrumentation.start(config, rc)

      const productHandler = rc.setProductHandler.lastCall.args[1]

      // Register multiple pending ack callbacks
      productHandler('apply', { id: 'probe1' }, 'config-id-1', ackCallback1)
      productHandler('apply', { id: 'probe2' }, 'config-id-2', ackCallback2)
      productHandler('apply', { id: 'probe3' }, 'config-id-3', ackCallback3)

      // Verify callbacks are NOT called yet (still pending)
      sinon.assert.notCalled(ackCallback1)
      sinon.assert.notCalled(ackCallback2)
      sinon.assert.notCalled(ackCallback3)

      const worker = Worker.lastCall.returnValue
      const exitHandler = worker.once.getCalls().find(call => call.args[0] === 'exit').args[1]

      // Simulate worker exit with error code
      exitHandler(1)

      // NOW all pending ack callbacks should be called with error
      sinon.assert.calledOnce(ackCallback1)
      sinon.assert.calledOnce(ackCallback2)
      sinon.assert.calledOnce(ackCallback3)

      // Each should be called with the same error containing the exit code
      const error1 = ackCallback1.firstCall.args[0]
      const error2 = ackCallback2.firstCall.args[0]
      const error3 = ackCallback3.firstCall.args[0]

      assert.ok(error1 instanceof Error)
      assert.ok(error1.message.includes('Dynamic Instrumentation worker thread exited unexpectedly'))
      assert.ok(error1.message.includes('code 1'))

      // All callbacks should receive the same error instance
      assert.strictEqual(error2, error1)
      assert.strictEqual(error3, error1)
    })

    it('should call pending ack callbacks with undefined on graceful shutdown', () => {
      const ackCallback1 = sinon.stub()
      const ackCallback2 = sinon.stub()

      DynamicInstrumentation.start(config, rc)

      const productHandler = rc.setProductHandler.lastCall.args[1]

      // Register multiple pending ack callbacks
      productHandler('apply', { id: 'probe1' }, 'config-id-1', ackCallback1)
      productHandler('apply', { id: 'probe2' }, 'config-id-2', ackCallback2)

      // Verify callbacks are NOT called yet (still pending)
      sinon.assert.notCalled(ackCallback1)
      sinon.assert.notCalled(ackCallback2)

      // Stop gracefully
      DynamicInstrumentation.stop()

      // NOW all pending ack callbacks should be called without error
      sinon.assert.calledOnce(ackCallback1)
      sinon.assert.calledOnce(ackCallback2)
      sinon.assert.calledWith(ackCallback1, undefined)
      sinon.assert.calledWith(ackCallback2, undefined)
    })

    it('should remove RC product handler during cleanup', () => {
      DynamicInstrumentation.start(config, rc)

      const productHandler = rc.setProductHandler.lastCall.args[1]
      const ackCallback = sinon.stub()

      // Register a pending ack callback
      productHandler('apply', { id: 'probe1' }, 'config-id', ackCallback)

      DynamicInstrumentation.stop()

      // RC product handler should be removed
      sinon.assert.calledWith(rc.removeProductHandler, 'LIVE_DEBUGGING')
    })

    it('should handle cleanup with no pending acks', () => {
      DynamicInstrumentation.start(config, rc)

      // Stop without any pending acks - should not throw
      DynamicInstrumentation.stop()

      sinon.assert.calledWith(rc.removeProductHandler, 'LIVE_DEBUGGING')
      assert.strictEqual(DynamicInstrumentation.isStarted(), false)
    })

    it('should call pending acks with error when termination fails', () => {
      const ackCallback = sinon.stub()

      DynamicInstrumentation.start(config, rc)

      const productHandler = rc.setProductHandler.lastCall.args[1]
      productHandler('apply', { id: 'probe1' }, 'config-id', ackCallback)

      const worker = Worker.lastCall.returnValue
      const terminationError = new Error('Termination failed')
      worker.terminate.throws(terminationError)

      // Stop should handle termination error
      DynamicInstrumentation.stop()

      // Pending ack should be called with the termination error
      sinon.assert.calledOnce(ackCallback)
      assert.strictEqual(ackCallback.firstCall.args[0], terminationError)
    })
  })
})
