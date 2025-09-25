'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../setup/core')

let ExposuresWriter
let writer
let exposureEvent
let request
let config
let log
let clock

describe('FFE Exposures Writer', () => {
  beforeEach(() => {
    exposureEvent = {
      timestamp: 1672531200000,
      allocation: { key: 'allocation_123' },
      flag: { key: 'test_flag' },
      variant: { key: 'A' },
      subject: {
        id: 'user_123',
        type: 'user',
        attributes: { plan: 'premium' }
      }
    }

    request = sinon.stub().yieldsAsync(null, 'OK', 200)

    config = {
      site: 'datadoghq.com',
      hostname: 'localhost',
      port: 8126,
      url: new (require('url').URL)('http://localhost:8126'),
      apiKey: 'test-api-key',
      ffeFlushInterval: 1000,
      ffeTimeout: 5000,
      service: 'test-service',
      version: '1.0.0',
      env: 'test'
    }

    log = {
      debug: sinon.spy(),
      error: sinon.spy(),
      warn: sinon.spy()
    }

    clock = sinon.useFakeTimers()

    ExposuresWriter = proxyquire('../../../src/ffe/writers/exposures', {
      '../../exporters/common/request': request,
      '../../log': log
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
      expect(writer._interval).to.equal(1000)
      expect(writer._timeout).to.equal(5000)
      expect(writer._bufferLimit).to.equal(1000)
      expect(writer._buffer).to.be.an('array').that.is.empty
    })

    it('should set up periodic flushing', () => {
      expect(writer._periodic).to.exist
    })
  })

  describe('append', () => {
    beforeEach(() => {
      writer.setEnabled(true) // Enable writer for append tests
    })

    it('should add exposure event to buffer', () => {
      writer.append(exposureEvent)

      expect(writer._buffer).to.have.length(1)
      expect(writer._buffer[0]).to.equal(exposureEvent)
    })

    it('should track buffer size', () => {
      const initialSize = writer._bufferSize

      writer.append(exposureEvent)

      expect(writer._bufferSize).to.be.greaterThan(initialSize)
    })

    it('should drop events when buffer is full', () => {
      writer._bufferLimit = 2

      writer.append(exposureEvent)
      writer.append(exposureEvent)
      writer.append(exposureEvent) // Should be dropped

      expect(writer._buffer).to.have.length(2)
      expect(writer._droppedEvents).to.equal(1)
      expect(log.warn).to.have.been.calledOnce
    })

    it('should drop events exceeding 1MB size limit', () => {
      const largeEvent = {
        ...exposureEvent,
        largeData: 'x'.repeat(1024 * 1024 + 1) // > 1MB
      }

      writer.append(largeEvent)

      expect(writer._buffer).to.have.length(0)
      expect(writer._droppedEvents).to.equal(1)
      expect(log.warn).to.have.been.calledWith(
        sinon.match(/event size .* bytes exceeds limit/)
      )
    })

    it('should flush when payload would exceed 5MB limit', () => {
      sinon.spy(writer, 'flush')

      // Create events that together exceed 5MB
      const largeEvent = {
        ...exposureEvent,
        largeData: 'x'.repeat(3 * 1024 * 1024) // 3MB each
      }

      writer.append(largeEvent) // First event, buffer = ~3MB
      writer.append(largeEvent) // Second event would make buffer ~6MB, should trigger flush

      expect(writer.flush).to.have.been.calledOnce
      expect(log.debug).to.have.been.calledWith(
        sinon.match(/buffer size would exceed .* bytes, flushing first/)
      )
    })

    it('should buffer events when disabled', () => {
      writer.setEnabled(false) // Disable writer

      writer.append(exposureEvent)

      expect(writer._buffer).to.have.length(0) // Event should not be in main buffer
      expect(writer._pendingEvents).to.have.length(1) // Should be in pending events
      expect(writer._pendingEvents[0].event).to.equal(exposureEvent)
    })
  })

  describe('makePayload', () => {
    it('should return context wrapper with exposures array', () => {
      const events = [exposureEvent]
      const payload = writer.makePayload(events)

      expect(payload).to.be.an('object')
      expect(payload).to.have.property('context')
      expect(payload).to.have.property('exposures')
      expect(payload.exposures).to.be.an('array').with.length(1)
    })

    it('should include service metadata in context', () => {
      const events = [exposureEvent]
      const payload = writer.makePayload(events)

      expect(payload.context).to.deep.equal({
        service_name: 'test-service',
        version: '1.0.0',
        env: 'test'
      })
    })

    it('should format exposure events correctly', () => {
      const events = [exposureEvent]
      const payload = writer.makePayload(events)
      const formattedEvent = payload.exposures[0]

      expect(formattedEvent).to.deep.equal({
        timestamp: 1672531200000,
        allocation: { key: 'allocation_123' },
        flag: { key: 'test_flag' },
        variant: { key: 'A' },
        subject: {
          id: 'user_123',
          type: 'user',
          attributes: { plan: 'premium' }
        }
      })
    })

    it('should handle optional config values', () => {
      const writerWithoutOptionals = new ExposuresWriter({
        ...config,
        version: undefined,
        env: undefined
      })

      const events = [exposureEvent]
      const payload = writerWithoutOptionals.makePayload(events)

      expect(payload.context).to.deep.equal({
        service_name: 'test-service'
      })
      expect(payload.context).to.not.have.property('version')
      expect(payload.context).to.not.have.property('env')
    })

    it('should handle flat format with dot notation', () => {
      const flatEvent = {
        timestamp: 1672531200000,
        'allocation.key': 'allocation_123',
        'flag.key': 'test_flag',
        'variant.key': 'A',
        'subject.id': 'user_123'
      }

      const payload = writer.makePayload([flatEvent])
      const formattedEvent = payload.exposures[0]

      expect(formattedEvent.allocation.key).to.equal('allocation_123')
      expect(formattedEvent.flag.key).to.equal('test_flag')
      expect(formattedEvent.variant.key).to.equal('A')
      expect(formattedEvent.subject.id).to.equal('user_123')
      expect(formattedEvent.subject.type).to.equal('user') // default
      expect(formattedEvent.subject.attributes).to.deep.equal({}) // default
    })
  })

  describe('flush', () => {
    beforeEach(() => {
      writer.setEnabled(true) // Enable writer
    })

    it('should skip flushing when buffer is empty', () => {
      writer.flush()

      expect(request).to.not.have.been.called
    })

    it('should skip flushing when writer is disabled', () => {
      writer.setEnabled(false)
      writer.append(exposureEvent)

      writer.flush()

      expect(request).to.not.have.been.called
    })

    it('should flush events to agent via EVP proxy', () => {
      writer.append(exposureEvent)

      writer.flush()

      expect(request).to.have.been.calledOnce
      const [payload, options] = request.getCall(0).args

      expect(options.method).to.equal('POST')
      expect(options.path).to.include('/evp_proxy/v2/')
      expect(options.headers['Content-Type']).to.equal('application/json')
      expect(options.headers['X-Datadog-EVP-Subdomain']).to.equal('event-platform-intake')

      const parsedPayload = JSON.parse(payload)
      expect(parsedPayload).to.be.an('object')
      expect(parsedPayload).to.have.property('context')
      expect(parsedPayload).to.have.property('exposures')
      expect(parsedPayload.exposures).to.be.an('array').with.length(1)
      expect(parsedPayload.exposures[0].timestamp).to.exist
      expect(parsedPayload.context.service_name).to.equal('test-service')
    })

    it('should empty buffer after flushing', () => {
      writer.append(exposureEvent)
      expect(writer._buffer).to.have.length(1)

      writer.flush()

      expect(writer._buffer).to.have.length(0)
      expect(writer._bufferSize).to.equal(0)
    })

    it('should log errors on request failure', () => {
      request.yieldsAsync(new Error('Network error'))
      writer.append(exposureEvent)

      writer.flush()

      expect(log.error).to.have.been.calledOnce
    })

    it('should log success on 2xx response', () => {
      writer.append(exposureEvent)

      writer.flush()

      expect(log.debug).to.have.been.called
    })

    it('should warn on non-2xx response', () => {
      request.yieldsAsync(null, 'Error', 400)
      writer.append(exposureEvent)

      writer.flush()

      expect(log.warn).to.have.been.calledOnce
    })
  })

  describe('periodic flushing', () => {
    beforeEach(() => {
      writer.setEnabled(true)
    })

    it('should flush periodically', () => {
      writer.append(exposureEvent)

      clock.tick(1000) // Advance by flush interval

      expect(request).to.have.been.calledOnce
    })

    it('should not flush empty buffer periodically', () => {
      clock.tick(1000)

      expect(request).to.not.have.been.called
    })
  })

  describe('destroy', () => {
    it('should clear periodic timer', () => {
      const clearIntervalSpy = sinon.spy(global, 'clearInterval')

      writer.destroy()

      expect(clearIntervalSpy).to.have.been.calledOnce
      clearIntervalSpy.restore()
    })

    it('should flush remaining events', () => {
      writer.setEnabled(true)
      writer.append(exposureEvent)

      writer.destroy()

      expect(request).to.have.been.calledOnce
    })

    it('should log dropped events count', () => {
      writer._droppedEvents = 5

      writer.destroy()

      expect(log.warn).to.have.been.calledWith(
        sinon.match(/dropped 5 events/)
      )
    })

    it('should prevent multiple destruction', () => {
      writer.destroy()
      writer.destroy() // Should not throw or cause issues

      expect(writer._destroyed).to.be.true
    })
  })
})
