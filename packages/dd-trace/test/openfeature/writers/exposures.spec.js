'use strict'

const assert = require('node:assert/strict')
const { format, inspect } = require('node:util')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../../setup/core')
const { assertObjectContains } = require('../../../../../integration-tests/helpers')

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
      '../../log': log,
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

      assert.ok(writer._bufferSize > initialSize, `Expected ${writer._bufferSize} > ${initialSize}`)
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

    it('should buffer events while disabled and drain on enable', () => {
      writer.setEnabled(false)
      writer.append(exposureEvent)

      // Pending events stay out of the main buffer until enable.
      assert.strictEqual(writer._buffer.length, 0)

      writer.setEnabled(true)

      assert.strictEqual(writer._buffer.length, 1)
      assert.strictEqual(writer._buffer[0], exposureEvent)
    })

    it('should keep every pending event when count equals the cap', () => {
      writer.setEnabled(false)

      const cap = 1000
      const events = []
      for (let i = 0; i < cap; i++) {
        events.push({ ...exposureEvent, seq: i })
      }
      writer.append(events)
      writer.setEnabled(true)

      assert.strictEqual(writer._buffer.length, cap)
      assert.strictEqual(writer.droppedEventCount, 0)
      sinon.assert.notCalled(log.warn)
    })

    it('should drop oldest pending events one past the cap', () => {
      writer.setEnabled(false)

      const cap = 1000
      const events = []
      for (let i = 0; i < cap + 1; i++) {
        events.push({ ...exposureEvent, seq: i })
      }
      writer.append(events)
      writer.setEnabled(true)

      assert.strictEqual(writer._buffer.length, cap)
      assert.strictEqual(writer._buffer[0].seq, 1)
      assert.strictEqual(writer._buffer.at(-1).seq, cap)
      assert.strictEqual(writer.droppedEventCount, 1)
      sinon.assert.calledOnce(log.warn)
      assert.match(format(...log.warn.firstCall.args), /dropped exposure event\(s\) at cap 1000/)
    })

    it('should throttle the drop warning while still counting every dropped event', () => {
      writer.setEnabled(false)

      const cap = 1000
      const events = []
      for (let i = 0; i < cap + 1; i++) {
        events.push({ ...exposureEvent, seq: i })
      }
      writer.append(events)
      writer.append({ ...exposureEvent, seq: cap + 1 })
      writer.append({ ...exposureEvent, seq: cap + 2 })

      assert.strictEqual(writer.droppedEventCount, 3)
      sinon.assert.calledOnce(log.warn)
    })
  })

  describe('makePayload', () => {
    it('should return context wrapper with exposures array', () => {
      const events = [exposureEvent]
      const payload = writer.makePayload(events)

      assert.ok(
        payload !== null && typeof payload === 'object' && !Array.isArray(payload),
        `Expected a non-null non-array object, got: ${inspect(payload)}`
      )
      assert.ok(Object.hasOwn(payload, 'context'), `Available keys: ${inspect(Object.keys(payload))}`)
      assert.ok(Object.hasOwn(payload, 'exposures'), `Available keys: ${inspect(Object.keys(payload))}`)
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

    it('should include serial_id when present', () => {
      const payload = writer.makePayload([{ ...exposureEvent, serial_id: 340132 }])

      assert.deepStrictEqual(payload.exposures[0], {
        timestamp: 1672531200000,
        allocation: { key: 'allocation_123' },
        flag: { key: 'test_flag' },
        variant: { key: 'A' },
        serial_id: 340132,
        subject: {
          id: 'user_123',
          type: 'user',
          attributes: { plan: 'premium' },
        },
      })
    })

    it('should include a serial_id of zero', () => {
      const payload = writer.makePayload([{ ...exposureEvent, serial_id: 0 }])

      assert.strictEqual(payload.exposures[0].serial_id, 0)
    })

    // The intake declares serial_id as an integer and rejects the whole exposure on a type
    // mismatch, so anything non-numeric has to leave the encoded payload entirely.
    for (const [label, serialId] of [
      ['absent', undefined],
      ['null', null],
      ['a string', '340132'],
      ['a boolean', true],
    ]) {
      it(`should omit serial_id when it is ${label}`, () => {
        const event = { ...exposureEvent }
        if (serialId !== undefined) {
          event.serial_id = serialId
        }
        const encoded = JSON.stringify(writer.makePayload([event]))

        assert.ok(!encoded.includes('serial_id'), `Encoded payload: ${encoded}`)
      })
    }

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
      assert.ok(
        !(Object.hasOwn(payload.context, 'version')),
        `Available keys: ${inspect(Object.keys(payload.context))}`
      )
      assert.ok(!(Object.hasOwn(payload.context, 'env')), `Available keys: ${inspect(Object.keys(payload.context))}`)
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

      assertObjectContains(formattedEvent, {
        allocation: {
          key: 'allocation_123',
        },
        flag: {
          key: 'test_flag',
        },
        variant: {
          key: 'A',
        },
        subject: {
          id: 'user_123',
        },
      })
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
      assert.strictEqual(options.retry, true)
      assert.match(options.path, /\/evp_proxy\/v2\//)
      assert.strictEqual(options.headers['Content-Type'], 'application/json')
      assert.strictEqual(options.headers['X-Datadog-EVP-Subdomain'], 'event-platform-intake')
      assert.strictEqual(options.headers['DD-API-KEY'], undefined)
      assert.strictEqual(options.headers['DD-API-KEY-FINGERPRINT'], undefined)

      const parsedPayload = JSON.parse(payload)
      assert.ok(
        parsedPayload !== null && typeof parsedPayload === 'object' && !Array.isArray(parsedPayload),
        `Expected non-null non-array object, got ${inspect(parsedPayload)}`
      )
      assert.ok(Object.hasOwn(parsedPayload, 'context'), `Available keys: ${inspect(Object.keys(parsedPayload))}`)
      assert.ok(Object.hasOwn(parsedPayload, 'exposures'), `Available keys: ${inspect(Object.keys(parsedPayload))}`)
      assert.strictEqual(parsedPayload.exposures?.length, 1)
      assert.ok(parsedPayload.exposures[0].timestamp)
      assert.strictEqual(parsedPayload.context.service, 'test-service')
    })

    it('should flush events through the selected EVP v4 proxy path', () => {
      const url = new URL('http://serverless-init:9126')
      writer.setEnabled(true, {
        url,
        basePath: '/evp_proxy/v4/',
        headers: {
          'X-Datadog-EVP-Subdomain': 'event-platform-intake',
        },
      })
      writer.append(exposureEvent)

      writer.flush()

      const [, options] = request.getCall(0).args
      assert.strictEqual(options.url, url)
      assert.strictEqual(options.path, '/evp_proxy/v4/api/v2/exposures')
      assert.strictEqual(options.headers['X-Datadog-EVP-Subdomain'], 'event-platform-intake')
      assert.strictEqual(options.headers['DD-API-KEY'], undefined)
      assert.strictEqual(options.headers['DD-API-KEY-FINGERPRINT'], undefined)
    })

    it('should use a caller-supplied route without performing discovery', () => {
      const url = new URL('http://custom-agent:9126')
      writer.setEnabled(true, {
        url,
        basePath: '/evp_proxy/v2/',
      })
      writer.append(exposureEvent)

      writer.flush()

      const [, options] = request.getCall(0).args
      assert.strictEqual(options.url, url)
      assert.strictEqual(options.path, '/evp_proxy/v2/api/v2/exposures')
    })

    it('should flush events directly to HTTPS intake without the local EVP prefix', () => {
      const url = new URL('https://event-platform-intake.datadoghq.com')
      const agent = {}
      writer.setEnabled(true, {
        url,
        basePath: '',
        agent,
        headers: {
          'DD-API-KEY': 'test-api-key',
          'DD-API-KEY-FINGERPRINT': 'rijn_i8Jug5ocjALL7JZiV1a8HzXqkwDRKcE7hK9IouPQwio',
        },
      })
      writer.append(exposureEvent)

      writer.flush()

      const [, options] = request.getCall(0).args
      assert.strictEqual(options.url, url)
      assert.strictEqual(options.path, '/api/v2/exposures')
      assert.strictEqual(options.retry, true)
      assert.strictEqual(options.agent, agent)
      assert.strictEqual(options.headers['DD-API-KEY'], 'test-api-key')
      assert.strictEqual(
        options.headers['DD-API-KEY-FINGERPRINT'],
        'rijn_i8Jug5ocjALL7JZiV1a8HzXqkwDRKcE7hK9IouPQwio'
      )
      assert.strictEqual(options.headers['X-Datadog-EVP-Subdomain'], undefined)
    })

    for (const [name, error, statusCode] of [
      ['temporary DNS failure', Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' })],
      ['connection refusal', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
      ['missing Unix socket', Object.assign(
        new Error('connect ENOENT /var/run/datadog/apm.socket'),
        { code: 'ENOENT' }
      )],
      ['unresolvable hostname', Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })],
      ['HTTP 403', Object.assign(new Error('Forbidden'), { status: 403 }), 403],
      ['HTTP 404', Object.assign(new Error('Not Found'), { status: 404 }), 404],
      ['HTTP 405', Object.assign(new Error('Method Not Allowed'), { status: 405 }), 405],
    ]) {
      it(`should switch to direct intake after definitive local ${name}`, async () => {
        const localUrl = new URL('http://serverless-init:8126')
        const directUrl = new URL('https://event-platform-intake.datadoghq.com')
        const directAgent = {}
        request.onFirstCall().yieldsAsync(error, null, statusCode)
        writer.setEnabled(true, {
          url: localUrl,
          basePath: '/evp_proxy/v4',
          headers: {
            'X-Datadog-EVP-Subdomain': 'event-platform-intake',
          },
          fallback: {
            url: directUrl,
            basePath: '',
            agent: directAgent,
            headers: {
              'DD-API-KEY': 'test-api-key',
            },
          },
        })
        writer.append(exposureEvent)

        writer.flush()
        await clock.tickAsync(0)

        sinon.assert.calledTwice(request)
        assert.strictEqual(request.firstCall.args[1].url, localUrl)
        assert.strictEqual(request.firstCall.args[1].path, '/evp_proxy/v4/api/v2/exposures')
        assert.strictEqual(request.secondCall.args[1].url, directUrl)
        assert.strictEqual(request.secondCall.args[1].path, '/api/v2/exposures')
        assert.strictEqual(request.secondCall.args[1].agent, directAgent)
        assert.strictEqual(request.secondCall.args[1].headers['DD-API-KEY'], 'test-api-key')

        writer.append(exposureEvent)
        writer.flush()

        sinon.assert.calledThrice(request)
        assert.strictEqual(request.thirdCall.args[1].url, directUrl)
      })
    }

    for (const [name, error, statusCode] of [
      ['connection reset', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
      ['broken pipe', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })],
      ['timeout', Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })],
    ]) {
      it(`should not replay ambiguous local ${name} and should switch future batches to direct intake`, async () => {
        const localUrl = new URL('http://serverless-init:8126')
        const directUrl = new URL('https://event-platform-intake.datadoghq.com')
        request.onFirstCall().yieldsAsync(error, null, statusCode)
        writer.setEnabled(true, {
          url: localUrl,
          basePath: '/evp_proxy/v4',
          headers: {
            'X-Datadog-EVP-Subdomain': 'event-platform-intake',
          },
          fallback: {
            url: directUrl,
            basePath: '',
            headers: {
              'DD-API-KEY': 'test-api-key',
            },
          },
        })
        writer.append(exposureEvent)

        writer.flush()
        await clock.tickAsync(0)

        sinon.assert.calledOnce(request)
        assert.strictEqual(request.firstCall.args[1].url, localUrl)
        sinon.assert.calledWithExactly(
          log.error,
          'Failed to send events to %s%s: %s',
          'http://serverless-init:8126/',
          '/evp_proxy/v4/api/v2/exposures',
          error.message
        )

        writer.append(exposureEvent)
        writer.flush()

        sinon.assert.calledTwice(request)
        assert.strictEqual(request.secondCall.args[1].url, directUrl)
      })
    }

    for (const [name, error, statusCode] of [
      ['HTTP 429', Object.assign(new Error('Too Many Requests'), { status: 429 }), 429],
      ['HTTP 500', Object.assign(new Error('Internal Server Error'), { status: 500 }), 500],
    ]) {
      it(`should not replay ${name} through direct intake or switch future batches`, async () => {
        const localUrl = new URL('http://serverless-init:8126')
        request.onFirstCall().yieldsAsync(error, null, statusCode)
        writer.setEnabled(true, {
          url: localUrl,
          basePath: '/evp_proxy/v4',
          headers: {
            'X-Datadog-EVP-Subdomain': 'event-platform-intake',
          },
          fallback: {
            url: new URL('https://event-platform-intake.datadoghq.com'),
            basePath: '',
            headers: {
              'DD-API-KEY': 'test-api-key',
            },
          },
        })
        writer.append(exposureEvent)

        writer.flush()
        await clock.tickAsync(0)

        sinon.assert.calledOnce(request)

        writer.append(exposureEvent)
        writer.flush()

        sinon.assert.calledTwice(request)
        assert.strictEqual(request.secondCall.args[1].url, localUrl)
      })
    }

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

      const warnCalls = log.warn.getCalls()
      assert(
        warnCalls.some(call => /dropped 5 events/.test(format(...call.args))),
        `Got warn calls: ${inspect(warnCalls.map(c => c.args))}`
      )
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
