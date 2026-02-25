'use strict'

const assert = require('node:assert/strict')
const { format } = require('node:util')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../setup/core')

describe('OpenFeature Exposures Writer', () => {
  let ExposuresWriter
  let writer
  let exposureEvent
  let request
  let config
  let log
  let clock

  beforeEach(() => {
    exposureEvent = {
      timestamp: 1672531200000,
      allocation: { key: 'allocation_123' },
      flag: { key: 'test_flag' },
      variant: { key: 'A' },
      subject: {
        id: 'user_123',
        type: 'user',
        attributes: { plan: 'premium' },
      },
    }

    request = sinon.stub().yieldsAsync(null, 'OK', 200)

    config = {
      site: 'datadoghq.com',
      hostname: 'localhost',
      port: 8126,
      url: new URL('http://localhost:8126'),
      apiKey: 'test-api-key',
      ffeFlushInterval: 1000,
      ffeTimeout: 5000,
      service: 'test-service',
      version: '1.0.0',
      env: 'test',
    }

    log = {
      debug: sinon.spy(),
      error: sinon.spy(),
      warn: sinon.spy(),
    }

    clock = sinon.useFakeTimers()

    ExposuresWriter = proxyquire('../../../src/openfeature/writers/exposures', {
      './base': proxyquire('../../../src/openfeature/writers/base', {
        '../../exporters/common/request': request,
        '../../log': log,
      }),
    })

    writer = new ExposuresWriter(config)
  })

  afterEach(() => {
    if (writer && writer.destroy) {
      writer.destroy()
    }
    clock.restore()
  })

  describe('constructor', () => {
    it('should initialize with correct defaults', () => {
      assert.strictEqual(writer._interval, 1000)
      assert.strictEqual(writer._timeout, 5000)
      assert.strictEqual(writer._bufferLimit, 1000)
      assert.deepStrictEqual(writer._buffer, [])
    })

    it('should set up periodic flushing', () => {
      assert.ok(writer._periodic)
    })
  })

  describe('append', () => {
    beforeEach(() => {
      writer.setEnabled(true) // Enable writer for append tests
    })

    it('should add exposure event to buffer', () => {
      writer.append(exposureEvent)

      assert.strictEqual(writer._buffer?.length, 1)
      assert.strictEqual(writer._buffer[0], exposureEvent)
    })

    it('should track buffer size', () => {
      const initialSize = writer._bufferSize

      writer.append(exposureEvent)

      assert.ok(writer._bufferSize > initialSize)
    })

    it('should drop events when buffer is full', () => {
      writer._bufferLimit = 2

      writer.append(exposureEvent)
      writer.append(exposureEvent)
      writer.append(exposureEvent) // Should be dropped

      assert.strictEqual(writer._buffer?.length, 2)
      assert.strictEqual(writer._droppedEvents, 1)
      sinon.assert.calledOnce(log.warn)
    })

    it('should drop events exceeding 1MB size limit', () => {
      const largeEvent = {
        ...exposureEvent,
        largeData: 'x'.repeat(1024 * 1024 + 1), // > 1MB
      }

      writer.append(largeEvent)

      assert.strictEqual(writer._buffer?.length, 0)
      assert.strictEqual(writer._droppedEvents, 1)
      sinon.assert.calledWith(log.warn, sinon.match(/event size[\s\S]*bytes exceeds limit/))
    })

    it('should flush when payload would exceed 5MB limit', () => {
      // Create events that together exceed 5MB (limit is 5242880 bytes)
      // Individual event limit is (1MB - 1KB) = 1047552 bytes
      // Use ~1020KB events to safely stay under individual limit
      const largeEvent = {
        ...exposureEvent,
        largeData: 'x'.repeat(1020 * 1024), // ~1020KB each
      }

      // Add 5 events (~5MB total)
      // Events 1-5 should accumulate and not trigger flush
      for (let i = 0; i < 5; i++) {
        writer.append(largeEvent)
        assert.strictEqual(writer._buffer.length, i + 1,
          `Buffer should contain ${i + 1} event(s) after appending event ${i + 1}`)
      }

      // Verify request was not called yet
      sinon.assert.notCalled(request)

      // Add 6th event (~6MB total) - should trigger flush
      writer.append(largeEvent)
      // Verify request was called (flush happened when limit was reached)
      sinon.assert.called(request)
      // 6th event should have triggered flush, leaving only the new event
      assert.strictEqual(writer._buffer.length, 1,
        'Buffer should contain 1 event after flush was triggered by 6th event')
    })

    it('should buffer events when disabled', () => {
      writer.setEnabled(false) // Disable writer

      writer.append(exposureEvent)

      assert.strictEqual(writer._buffer?.length, 0) // Event should not be in main buffer
      assert.strictEqual(writer._pendingEvents?.length, 1) // Should be in pending events
      assert.strictEqual(writer._pendingEvents[0], exposureEvent)
    })
  })

  describe('makePayload', () => {
    it('should return context wrapper with exposures array', () => {
      const events = [exposureEvent]
      const payload = writer.makePayload(events)

      assert.ok(payload !== null && typeof payload === 'object' && !Array.isArray(payload))
      assert.ok(Object.hasOwn(payload, 'context'))
      assert.ok(Object.hasOwn(payload, 'exposures'))
      assert.strictEqual(payload.exposures?.length, 1)
    })

    it('should include service metadata in context', () => {
      const events = [exposureEvent]
      const payload = writer.makePayload(events)

      assert.deepStrictEqual(payload.context, {
        service: 'test-service',
        version: '1.0.0',
        env: 'test',
      })
    })

    it('should format exposure events correctly', () => {
      const events = [exposureEvent]
      const payload = writer.makePayload(events)
      const formattedEvent = payload.exposures[0]

      assert.deepStrictEqual(formattedEvent, {
        timestamp: 1672531200000,
        allocation: { key: 'allocation_123' },
        flag: { key: 'test_flag' },
        variant: { key: 'A' },
        subject: {
          id: 'user_123',
          type: 'user',
          attributes: { plan: 'premium' },
        },
      })
    })

    it('should handle optional config values', () => {
      const writerWithoutOptionals = new ExposuresWriter({
        ...config,
        version: undefined,
        env: undefined,
      })

      const events = [exposureEvent]
      const payload = writerWithoutOptionals.makePayload(events)

      assert.deepStrictEqual(payload.context, {
        service: 'test-service',
      })
      assert.ok(!(Object.hasOwn(payload.context, 'version')))
      assert.ok(!(Object.hasOwn(payload.context, 'env')))
    })

    it('should handle flat format with dot notation', () => {
      const flatEvent = {
        timestamp: 1672531200000,
        'allocation.key': 'allocation_123',
        'flag.key': 'test_flag',
        'variant.key': 'A',
        'subject.id': 'user_123',
      }

      const payload = writer.makePayload([flatEvent])
      const formattedEvent = payload.exposures[0]

      assert.strictEqual(formattedEvent.allocation.key, 'allocation_123')
      assert.strictEqual(formattedEvent.flag.key, 'test_flag')
      assert.strictEqual(formattedEvent.variant.key, 'A')
      assert.strictEqual(formattedEvent.subject.id, 'user_123')
      assert.strictEqual(formattedEvent.subject.type, undefined)
      assert.strictEqual(formattedEvent.subject.attributes, undefined)
    })
  })

  describe('flush', () => {
    beforeEach(() => {
      writer.setEnabled(true) // Enable writer
    })

    it('should skip flushing when buffer is empty', () => {
      writer.flush()

      sinon.assert.notCalled(request)
    })

    it('should skip flushing when writer is disabled', () => {
      writer.setEnabled(false)
      writer.append(exposureEvent)

      writer.flush()

      sinon.assert.notCalled(request)
    })

    it('should flush events to agent via EVP proxy', () => {
      writer.append(exposureEvent)

      writer.flush()

      sinon.assert.calledOnce(request)
      const [payload, options] = request.getCall(0).args

      assert.strictEqual(options.method, 'POST')
      assert.match(options.path, /\/evp_proxy\/v2\//)
      assert.strictEqual(options.headers['Content-Type'], 'application/json')
      assert.strictEqual(options.headers['X-Datadog-EVP-Subdomain'], 'event-platform-intake')

      const parsedPayload = JSON.parse(payload)
      assert.ok(parsedPayload !== null && typeof parsedPayload === 'object' && !Array.isArray(parsedPayload))
      assert.ok(Object.hasOwn(parsedPayload, 'context'))
      assert.ok(Object.hasOwn(parsedPayload, 'exposures'))
      assert.strictEqual(parsedPayload.exposures?.length, 1)
      assert.ok(parsedPayload.exposures[0].timestamp)
      assert.strictEqual(parsedPayload.context.service, 'test-service')
    })

    it('should empty buffer after flushing', () => {
      writer.append(exposureEvent)
      assert.strictEqual(writer._buffer?.length, 1)

      writer.flush()

      assert.strictEqual(writer._buffer?.length, 0)
      assert.strictEqual(writer._bufferSize, 0)
    })

    it('should log errors on request failure', (done) => {
      request.yieldsAsync(new Error('Network error'))
      writer.append(exposureEvent)

      writer.flush()

      clock.tickAsync(0).then(() => {
        sinon.assert.calledOnce(log.error)
        done()
      })
    })

    it('should log success on 2xx response', () => {
      writer.append(exposureEvent)

      writer.flush()

      sinon.assert.called(log.debug)
    })

    it('should warn on non-2xx response', (done) => {
      request.yieldsAsync(null, 'Error', 400)
      writer.append(exposureEvent)

      writer.flush()

      clock.tickAsync(0).then(() => {
        sinon.assert.calledOnce(log.warn)
        done()
      })
    })
  })

  describe('periodic flushing', () => {
    beforeEach(() => {
      writer.setEnabled(true)
    })

    it('should flush periodically', () => {
      writer.append(exposureEvent)

      clock.tick(1000) // Advance by flush interval

      sinon.assert.calledOnce(request)
    })

    it('should not flush empty buffer periodically', () => {
      clock.tick(1000)

      sinon.assert.notCalled(request)
    })
  })

  describe('destroy', () => {
    it('should clear periodic timer', () => {
      const clearIntervalSpy = sinon.spy(global, 'clearInterval')

      writer.destroy()

      sinon.assert.calledOnce(clearIntervalSpy)
      clearIntervalSpy.restore()
    })

    it('should flush remaining events', () => {
      writer.setEnabled(true)
      writer.append(exposureEvent)

      writer.destroy()

      sinon.assert.calledOnce(request)
    })

    it('should log dropped events count', () => {
      writer._droppedEvents = 5

      writer.destroy()

      assert(log.warn.getCalls().some(call => /dropped 5 events/.test(format(...call.args))))
    })

    it('should prevent multiple destruction', () => {
      writer.setEnabled(true)
      writer.append(exposureEvent)

      // Destroy and verify flush happens
      writer.destroy()
      sinon.assert.calledOnce(request)
      request.resetHistory()

      // Advance time to when periodic flush would have happened
      clock.tick(1000)

      // No additional flush should occur (periodic timer was cleared)
      sinon.assert.notCalled(request)

      // Second destroy should be safe and not cause additional flushes
      writer.destroy()
      sinon.assert.notCalled(request)
    })
  })
})
