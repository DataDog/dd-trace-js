'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')

const VALID_UFC = JSON.stringify({
  createdAt: '2026-01-01T00:00:00.000Z',
  format: 'SERVER',
  environment: { name: 'test' },
  flags: {},
})
const VALID_RESPONSE = JSON.stringify({
  data: {
    id: '1',
    type: 'universal-flag-configuration',
    attributes: JSON.parse(VALID_UFC),
  },
})

describe('AgentlessConfigurationSource', () => {
  let AgentlessConfigurationSource
  let applyConfiguration
  let clock
  let config
  let log
  let requests
  let responses
  let runInNoopContext
  let transport

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    applyConfiguration = sinon.stub()
    config = {
      endpoint: new URL('http://127.0.0.1:8080/api/v2/feature-flagging/config/rules-based/server'),
      pollIntervalMs: 30_000,
      requestTimeoutMs: 2000,
      apiKey: 'test-api-key',
    }
    log = {
      debug: sinon.spy(),
      warn: sinon.spy(),
    }
    requests = []
    responses = []
    runInNoopContext = sinon.spy((_store, callback) => callback())
    transport = {
      request: sinon.spy((url, options, onResponse) => {
        const request = new EventEmitter()
        request.url = url
        request.options = options
        request.setTimeout = sinon.spy((timeout, onTimeout) => {
          request.timeout = timeout
          request.onTimeout = onTimeout
        })
        request.destroy = sinon.spy(error => {
          if (error) request.emit('error', error)
        })
        request.end = sinon.spy(() => {
          const next = responses.shift()
          if (!next || next.pending) return
          if (next.error) {
            request.emit('error', next.error)
            return
          }
          const response = new EventEmitter()
          response.statusCode = next.statusCode
          response.headers = next.headers || {}
          onResponse(response)
          if (next.body) response.emit('data', Buffer.from(next.body))
          response.emit('end')
        })
        requests.push(request)
        return request
      }),
    }
    AgentlessConfigurationSource = proxyquire('../../src/openfeature/agentless_configuration_source', {
      '../../../datadog-core': {
        storage: () => ({ run: runInNoopContext }),
      },
      'node:http': transport,
      '../log': log,
    })
  })

  afterEach(() => {
    clock.restore()
  })

  function source (options = {}) {
    return new AgentlessConfigurationSource(config, applyConfiguration, {
      http: transport,
      random: () => 0.5,
      ...options,
    })
  }

  function completeScheduledResponse () {
    clock.tick(0)
  }

  it('fetches, applies, and reuses the accepted ETag', () => {
    responses.push(
      { statusCode: 200, headers: { etag: '"ufc-v1"' }, body: VALID_RESPONSE },
      { statusCode: 304, headers: {}, body: '' }
    )
    const configurationSource = source()
    const first = sinon.spy()
    const second = sinon.spy()

    configurationSource.pollOnce(first)
    completeScheduledResponse()
    configurationSource.pollOnce(second)
    completeScheduledResponse()

    sinon.assert.calledOnceWithExactly(applyConfiguration, JSON.parse(VALID_UFC))
    sinon.assert.calledWith(first, null, { applied: true })
    sinon.assert.calledWith(second, null, { notModified: true })
    assert.strictEqual(requests[0].options.headers['DD-API-KEY'], 'test-api-key')
    assert.strictEqual(requests[0].options.headers['If-None-Match'], undefined)
    assert.strictEqual(requests[1].options.headers['If-None-Match'], '"ufc-v1"')
    assert.strictEqual(requests[0].timeout, 2000)
  })

  it('suppresses tracing around agentless requests', () => {
    responses.push({ statusCode: 200, body: VALID_RESPONSE })

    source().pollOnce(() => {})

    sinon.assert.calledOnceWithMatch(runInNoopContext, { noop: true }, sinon.match.func)
  })

  it('unwraps a JSON API Universal Flag Configuration response', () => {
    const expected = JSON.parse(VALID_UFC)
    delete expected.format
    responses.push({
      statusCode: 200,
      body: JSON.stringify({
        data: {
          id: '1',
          type: 'universal-flag-configuration',
          attributes: expected,
        },
      }),
    })

    source().pollOnce(() => {})

    sinon.assert.calledOnceWithExactly(applyConfiguration, expected)
  })

  it('accepts managed JSON API payloads larger than 500 KB', () => {
    const expected = JSON.parse(VALID_UFC)
    expected.flags.large = { description: 'x'.repeat(500 * 1024) }
    responses.push({
      statusCode: 200,
      body: JSON.stringify({
        data: {
          id: 'opaque-id',
          type: 'universal-flag-configuration',
          attributes: expected,
        },
      }),
    })

    source().pollOnce(() => {})

    sinon.assert.calledOnceWithExactly(applyConfiguration, expected)
  })

  it('requires JSON API at custom endpoints', () => {
    responses.push({ statusCode: 200, body: VALID_UFC })

    source().pollOnce(() => {})

    sinon.assert.notCalled(applyConfiguration)
    sinon.assert.calledOnce(log.debug)
  })

  it('rejects unrelated or incomplete JSON API resources', () => {
    responses.push(
      {
        statusCode: 200,
        body: JSON.stringify({ data: { id: '1', type: 'other-configuration', attributes: {} } }),
      },
      {
        statusCode: 200,
        body: JSON.stringify({ data: { id: '1', type: 'universal-flag-configuration' } }),
      }
    )
    const configurationSource = source()

    configurationSource.pollOnce(() => {})
    configurationSource.pollOnce(() => {})

    sinon.assert.notCalled(applyConfiguration)
    sinon.assert.calledTwice(log.debug)
  })

  it('preserves last-known-good configuration and ETag after malformed JSON', () => {
    responses.push(
      { statusCode: 200, headers: { etag: '"good"' }, body: VALID_RESPONSE },
      { statusCode: 200, headers: { etag: '"bad"' }, body: '{"flags":[' },
      { statusCode: 304, headers: {}, body: '' }
    )
    const configurationSource = source()

    configurationSource.pollOnce(() => {})
    completeScheduledResponse()
    configurationSource.pollOnce(() => {})
    completeScheduledResponse()
    configurationSource.pollOnce(() => {})
    completeScheduledResponse()

    sinon.assert.calledOnce(applyConfiguration)
    assert.strictEqual(requests[2].options.headers['If-None-Match'], '"good"')
    sinon.assert.calledOnce(log.debug)
  })

  it('clears a stale ETag when an accepted response omits it', () => {
    responses.push(
      { statusCode: 200, headers: { etag: '"first"' }, body: VALID_RESPONSE },
      { statusCode: 200, headers: {}, body: VALID_RESPONSE },
      { statusCode: 200, headers: {}, body: VALID_RESPONSE }
    )
    const configurationSource = source()

    configurationSource.pollOnce(() => {})
    configurationSource.pollOnce(() => {})
    configurationSource.pollOnce(() => {})

    assert.strictEqual(requests[1].options.headers['If-None-Match'], '"first"')
    assert.strictEqual(requests[2].options.headers['If-None-Match'], undefined)
    sinon.assert.calledThrice(applyConfiguration)
  })

  it('does not advance the ETag and keeps scheduled polling after a listener failure', () => {
    applyConfiguration.onFirstCall().throws(new Error('listener failed'))
    responses.push(
      { statusCode: 200, headers: { etag: '"failed"' }, body: VALID_RESPONSE },
      { statusCode: 200, headers: { etag: '"accepted"' }, body: VALID_RESPONSE }
    )
    const configurationSource = source()

    configurationSource.start()
    clock.tick(30_000)

    assert.strictEqual(requests.length, 2)
    assert.strictEqual(requests[1].options.headers['If-None-Match'], undefined)
    sinon.assert.calledTwice(applyConfiguration)
    sinon.assert.calledOnce(log.debug)
  })

  it('retries 429 and 5xx responses with bounded delays', () => {
    responses.push(
      { statusCode: 500, body: '' },
      { statusCode: 429, body: '' },
      { statusCode: 200, body: VALID_RESPONSE }
    )
    const callback = sinon.spy()

    source().pollOnce(callback)
    completeScheduledResponse()
    assert.strictEqual(requests.length, 1)

    clock.tick(4999)
    assert.strictEqual(requests.length, 1)
    clock.tick(1)
    completeScheduledResponse()
    assert.strictEqual(requests.length, 2)

    clock.tick(9999)
    assert.strictEqual(requests.length, 2)
    clock.tick(1)
    completeScheduledResponse()

    assert.strictEqual(requests.length, 3)
    sinon.assert.calledOnce(applyConfiguration)
    sinon.assert.calledWith(callback, null, { applied: true })
  })

  it('retries request timeout responses', () => {
    responses.push(
      { statusCode: 408, body: '' },
      { statusCode: 200, body: VALID_RESPONSE }
    )

    source().pollOnce(() => {})
    clock.tick(5000)
    completeScheduledResponse()

    assert.strictEqual(requests.length, 2)
    sinon.assert.calledOnce(applyConfiguration)
  })

  it('warns after retryable HTTP responses exhaust all attempts', () => {
    responses.push(
      { statusCode: 500, body: '' },
      { statusCode: 500, body: '' },
      { statusCode: 500, body: '' }
    )

    source().pollOnce(() => {})
    clock.tick(5000)
    clock.tick(10_000)

    sinon.assert.calledOnceWithExactly(
      log.warn,
      'Feature Flagging agentless endpoint returned HTTP %d after %d attempts',
      500,
      3
    )
  })

  it('warns after request timeouts exhaust all attempts', () => {
    responses.push({ pending: true }, { pending: true }, { pending: true })

    source().pollOnce(() => {})
    requests[0].onTimeout()
    clock.tick(5000)
    requests[1].onTimeout()
    clock.tick(10_000)
    requests[2].onTimeout()

    sinon.assert.calledOnceWithMatch(
      log.warn,
      'Feature Flagging agentless request failed after %d attempts',
      3,
      sinon.match.instanceOf(Error)
    )
  })

  it('does not retry authentication failures and rate-limits the warning', () => {
    responses.push(
      { statusCode: 401, body: '' },
      { statusCode: 403, body: '' },
      { statusCode: 401, body: '' }
    )
    const configurationSource = source()

    configurationSource.pollOnce(() => {})
    completeScheduledResponse()
    configurationSource.pollOnce(() => {})
    completeScheduledResponse()
    clock.tick(5 * 60 * 1000)
    configurationSource.pollOnce(() => {})
    completeScheduledResponse()

    assert.strictEqual(requests.length, 3)
    sinon.assert.calledTwice(log.warn)
    sinon.assert.notCalled(applyConfiguration)
  })

  it('retries request timeouts without overlapping requests', () => {
    responses.push({ pending: true }, { statusCode: 200, body: VALID_RESPONSE })
    const configurationSource = source()
    const first = sinon.spy()
    const overlapping = sinon.spy()

    configurationSource.pollOnce(first)
    configurationSource.pollOnce(overlapping)
    sinon.assert.calledOnceWithExactly(overlapping, null, { skipped: true })

    requests[0].onTimeout()
    completeScheduledResponse()
    clock.tick(5000)
    completeScheduledResponse()

    sinon.assert.calledOnce(applyConfiguration)
    sinon.assert.calledWith(first, null, { applied: true })
    assert.strictEqual(requests.length, 2)
  })

  it('uses fixed-delay polling and never schedules while a request is active', () => {
    responses.push(
      { pending: true },
      { statusCode: 200, body: VALID_RESPONSE }
    )
    const configurationSource = source()

    configurationSource.start()
    clock.tick(30_000)
    assert.strictEqual(requests.length, 1)

    requests[0].emit('error', new Error('network failure'))
    clock.tick(5000)
    completeScheduledResponse()
    assert.strictEqual(requests.length, 2)

    clock.tick(29_999)
    assert.strictEqual(requests.length, 2)
    clock.tick(1)
    assert.strictEqual(requests.length, 3)
  })

  it('stops retry timers and aborts an active request', () => {
    responses.push({ pending: true })
    const configurationSource = source()

    configurationSource.start()
    configurationSource.stop()
    configurationSource.stop()
    clock.tick(60_000)

    assert.strictEqual(requests.length, 1)
    sinon.assert.calledOnce(requests[0].destroy)
  })

  it('starts only once', () => {
    responses.push({ pending: true })
    const configurationSource = source()

    configurationSource.start()
    configurationSource.start()

    assert.strictEqual(requests.length, 1)
  })
})
