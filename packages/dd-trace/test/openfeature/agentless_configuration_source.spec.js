'use strict'

const assert = require('node:assert/strict')
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
  let fetch
  let log
  let requests
  let responses
  let runInNoopContext

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
      error: sinon.spy(),
      warn: sinon.spy(),
    }
    requests = []
    responses = []
    runInNoopContext = sinon.spy((_store, callback) => callback())
    fetch = sinon.spy((url, options) => {
      const request = { url, options }
      requests.push(request)
      const next = responses.shift()

      if (!next || next.pending) {
        return new Promise((resolve, reject) => {
          request.resolve = resolve
          request.reject = reject
          const abort = () => reject(options.signal.reason || new Error('aborted'))
          if (options.signal.aborted) abort()
          else options.signal.addEventListener('abort', abort, { once: true })
        })
      }
      if (next.error) return Promise.reject(next.error)

      return Promise.resolve({
        status: next.statusCode,
        headers: new Headers(next.headers),
        text: () => next.bodyError ? Promise.reject(next.bodyError) : Promise.resolve(next.body || ''),
      })
    })
    AgentlessConfigurationSource = proxyquire('../../src/openfeature/agentless_configuration_source', {
      '../../../datadog-core': {
        storage: () => ({ run: runInNoopContext }),
      },
      '../log': log,
    })
  })

  afterEach(() => {
    clock?.restore()
  })

  function source (options = {}) {
    return new AgentlessConfigurationSource(config, applyConfiguration, {
      fetch,
      random: () => 0.5,
      ...options,
    })
  }

  function completeScheduledResponse () {
    return clock.tickAsync(0)
  }

  function poll (configurationSource) {
    return new Promise(resolve => {
      configurationSource.pollOnce((error, result) => resolve({ error, result }))
    })
  }

  it('fetches, applies, and reuses the accepted ETag', async () => {
    responses.push(
      { statusCode: 200, headers: { etag: '"ufc-v1"' }, body: VALID_RESPONSE },
      { statusCode: 304, headers: {}, body: '' }
    )
    const configurationSource = source()
    const first = await poll(configurationSource)
    const second = await poll(configurationSource)

    sinon.assert.calledOnceWithExactly(applyConfiguration, JSON.parse(VALID_UFC))
    assert.deepStrictEqual(first, { error: null, result: { applied: true } })
    assert.deepStrictEqual(second, { error: null, result: { notModified: true } })
    assert.strictEqual(requests[0].options.headers['DD-API-KEY'], 'test-api-key')
    assert.strictEqual(requests[0].options.headers['Accept-Encoding'], 'gzip')
    assert.strictEqual(requests[0].options.headers['If-None-Match'], undefined)
    assert.strictEqual(requests[1].options.headers['If-None-Match'], '"ufc-v1"')
    assert.strictEqual(requests[0].options.redirect, 'manual')
  })

  it('suppresses tracing around agentless requests', () => {
    responses.push({ statusCode: 200, body: VALID_RESPONSE })

    source().pollOnce(() => {})

    sinon.assert.calledOnceWithMatch(runInNoopContext, { noop: true }, sinon.match.func)
  })

  it('does not send the API key over cleartext non-loopback connections', async () => {
    config.endpoint = new URL('http://flags.example.test/custom/ufc')
    responses.push({ statusCode: 200, body: VALID_RESPONSE })

    await poll(source())

    assert.strictEqual(requests[0].options.headers['DD-API-KEY'], undefined)
    sinon.assert.calledOnceWithExactly(
      log.error,
      'Not sending the Datadog API key over a non-TLS connection to %s. Configure an https Feature Flagging URL.',
      'flags.example.test'
    )
  })

  it('sends the API key to the local Docker host gateway', async () => {
    config.endpoint = new URL('http://host.docker.internal/custom/ufc')
    responses.push({ statusCode: 200, body: VALID_RESPONSE })

    await poll(source())

    assert.strictEqual(requests[0].options.headers['DD-API-KEY'], 'test-api-key')
    sinon.assert.notCalled(log.error)
  })

  it('accepts a JSON API Universal Flag Configuration without optional format', async () => {
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

    await poll(source())

    sinon.assert.calledOnceWithExactly(applyConfiguration, expected)
  })

  it('applies gzip JSON API responses decoded by fetch', async () => {
    responses.push({
      statusCode: 200,
      headers: { 'content-encoding': 'gzip' },
      body: VALID_RESPONSE,
    })

    const outcome = await poll(source())

    assert.deepStrictEqual(outcome, { error: null, result: { applied: true } })
    sinon.assert.calledOnceWithExactly(applyConfiguration, JSON.parse(VALID_UFC))
  })

  it('preserves last-known-good configuration and ETag after invalid gzip', async () => {
    responses.push(
      { statusCode: 200, headers: { etag: '"good"' }, body: VALID_RESPONSE },
      {
        statusCode: 200,
        headers: { etag: '"bad"', 'content-encoding': 'gzip' },
        bodyError: new TypeError('terminated'),
      },
      { statusCode: 304, headers: {}, body: '' }
    )
    const configurationSource = source()

    assert.ifError((await poll(configurationSource)).error)
    const invalid = await poll(configurationSource)
    assert.match(invalid.error.message, /gzip response could not be decompressed/)
    const last = await poll(configurationSource)

    assert.deepStrictEqual(last, { error: null, result: { notModified: true } })
    sinon.assert.calledOnce(applyConfiguration)
    assert.strictEqual(requests[2].options.headers['If-None-Match'], '"good"')
    sinon.assert.calledOnce(log.debug)
  })

  it('reports non-gzip response body failures', async () => {
    responses.push({
      statusCode: 200,
      bodyError: new TypeError('terminated'),
    })

    const outcome = await poll(source())

    assert.match(outcome.error.message, /response body could not be read/)
    sinon.assert.notCalled(applyConfiguration)
  })

  it('accepts managed JSON API payloads larger than 500 KB', async () => {
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

    await poll(source())

    sinon.assert.calledOnceWithExactly(applyConfiguration, expected)
  })

  it('requires JSON API at custom endpoints', async () => {
    responses.push({ statusCode: 200, body: VALID_UFC })

    await poll(source())

    sinon.assert.notCalled(applyConfiguration)
    sinon.assert.calledOnce(log.debug)
  })

  it('rejects unrelated or incomplete JSON API resources', async () => {
    responses.push(
      {
        statusCode: 200,
        body: JSON.stringify({ data: { id: '1', type: 'other-configuration', attributes: {} } }),
      },
      {
        statusCode: 200,
        body: JSON.stringify({ data: { id: '1', type: 'universal-flag-configuration' } }),
      },
      {
        statusCode: 200,
        body: JSON.stringify({
          data: {
            id: '1',
            type: 'universal-flag-configuration',
            attributes: { createdAt: '2026-01-01T00:00:00.000Z' },
          },
        }),
      }
    )
    const configurationSource = source()

    await poll(configurationSource)
    await poll(configurationSource)
    await poll(configurationSource)

    sinon.assert.notCalled(applyConfiguration)
    sinon.assert.calledThrice(log.debug)
  })

  it('preserves last-known-good configuration and ETag after malformed JSON', async () => {
    responses.push(
      { statusCode: 200, headers: { etag: '"good"' }, body: VALID_RESPONSE },
      { statusCode: 200, headers: { etag: '"bad"' }, body: '{"flags":[' },
      { statusCode: 304, headers: {}, body: '' }
    )
    const configurationSource = source()

    await poll(configurationSource)
    await poll(configurationSource)
    await poll(configurationSource)

    sinon.assert.calledOnce(applyConfiguration)
    assert.strictEqual(requests[2].options.headers['If-None-Match'], '"good"')
    sinon.assert.calledOnce(log.debug)
  })

  it('clears a stale ETag when an accepted response omits it', async () => {
    responses.push(
      { statusCode: 200, headers: { etag: '"first"' }, body: VALID_RESPONSE },
      { statusCode: 200, headers: {}, body: VALID_RESPONSE },
      { statusCode: 200, headers: {}, body: VALID_RESPONSE }
    )
    const configurationSource = source()

    await poll(configurationSource)
    await poll(configurationSource)
    await poll(configurationSource)

    assert.strictEqual(requests[1].options.headers['If-None-Match'], '"first"')
    assert.strictEqual(requests[2].options.headers['If-None-Match'], undefined)
    sinon.assert.calledThrice(applyConfiguration)
  })

  it('does not advance the ETag and keeps scheduled polling after a listener failure', async () => {
    applyConfiguration.onFirstCall().throws(new Error('listener failed'))
    responses.push(
      { statusCode: 200, headers: { etag: '"failed"' }, body: VALID_RESPONSE },
      { statusCode: 200, headers: { etag: '"accepted"' }, body: VALID_RESPONSE }
    )
    const configurationSource = source()

    configurationSource.start()
    await completeScheduledResponse()
    await clock.tickAsync(30_000)

    assert.strictEqual(requests.length, 2)
    assert.strictEqual(requests[1].options.headers['If-None-Match'], undefined)
    sinon.assert.calledTwice(applyConfiguration)
    sinon.assert.calledOnce(log.debug)
  })

  it('retries 429 and 5xx responses with bounded delays', async () => {
    responses.push(
      { statusCode: 500, bodyError: new Error('must not decode error responses') },
      { statusCode: 429, bodyError: new Error('must not decode error responses') },
      { statusCode: 200, body: VALID_RESPONSE }
    )
    const outcome = poll(source())

    await completeScheduledResponse()
    assert.strictEqual(requests.length, 1)

    await clock.tickAsync(4999)
    assert.strictEqual(requests.length, 1)
    await clock.tickAsync(1)
    assert.strictEqual(requests.length, 2)

    await clock.tickAsync(9999)
    assert.strictEqual(requests.length, 2)
    await clock.tickAsync(1)

    assert.strictEqual(requests.length, 3)
    sinon.assert.calledOnce(applyConfiguration)
    assert.deepStrictEqual(await outcome, { error: null, result: { applied: true } })
  })

  it('retries request timeout responses', async () => {
    responses.push(
      { statusCode: 408, body: '' },
      { statusCode: 200, body: VALID_RESPONSE }
    )

    const outcome = poll(source())
    await completeScheduledResponse()
    await clock.tickAsync(5000)

    assert.strictEqual(requests.length, 2)
    sinon.assert.calledOnce(applyConfiguration)
    assert.deepStrictEqual(await outcome, { error: null, result: { applied: true } })
  })

  it('settles a request timeout even when fetch does not reject after abort', async () => {
    const delayedFetch = sinon.stub().returns(new Promise(() => {}))
    const callback = sinon.spy()

    source({ fetch: delayedFetch })._request(callback)
    await clock.tickAsync(2000)

    sinon.assert.calledOnce(callback)
    assert.strictEqual(callback.firstCall.args[0].retryable, true)
    assert.strictEqual(delayedFetch.firstCall.args[1].signal.aborted, true)
  })

  it('warns after retryable HTTP responses exhaust all attempts', async () => {
    responses.push(
      { statusCode: 500, body: '' },
      { statusCode: 500, body: '' },
      { statusCode: 500, body: '' }
    )

    const outcome = poll(source())
    await completeScheduledResponse()
    await clock.tickAsync(5000)
    await clock.tickAsync(10_000)
    await outcome

    sinon.assert.calledOnceWithExactly(
      log.warn,
      'Feature Flagging agentless endpoint returned HTTP %d after %d attempts',
      500,
      3
    )
  })

  it('warns after request timeouts exhaust all attempts', async () => {
    responses.push({ pending: true }, { pending: true }, { pending: true })

    const outcome = poll(source())
    await clock.tickAsync(2000)
    await clock.tickAsync(5000)
    await clock.tickAsync(2000)
    await clock.tickAsync(10_000)
    await clock.tickAsync(2000)
    await outcome

    sinon.assert.calledOnceWithMatch(
      log.warn,
      'Feature Flagging agentless request failed after %d attempts',
      3,
      sinon.match.instanceOf(Error)
    )
  })

  it('does not retry authentication failures and rate-limits the warning', async () => {
    responses.push(
      { statusCode: 401, body: '' },
      { statusCode: 403, body: '' },
      { statusCode: 401, body: '' }
    )
    const configurationSource = source()

    await poll(configurationSource)
    await poll(configurationSource)
    await clock.tickAsync(5 * 60 * 1000)
    await poll(configurationSource)

    assert.strictEqual(requests.length, 3)
    sinon.assert.calledTwice(log.warn)
    sinon.assert.notCalled(applyConfiguration)
  })

  it('retries request timeouts without overlapping requests', async () => {
    responses.push({ pending: true }, { statusCode: 200, body: VALID_RESPONSE })
    const configurationSource = source()
    const first = sinon.spy()
    const overlapping = sinon.spy()

    configurationSource.pollOnce(first)
    configurationSource.pollOnce(overlapping)
    sinon.assert.calledOnceWithExactly(overlapping, null, { skipped: true })

    await clock.tickAsync(2000)
    await clock.tickAsync(5000)

    sinon.assert.calledOnce(applyConfiguration)
    sinon.assert.calledWith(first, null, { applied: true })
    assert.strictEqual(requests.length, 2)
  })

  it('uses fixed-delay polling and never schedules while a request is active', async () => {
    config.requestTimeoutMs = 60_000
    responses.push(
      { pending: true },
      { statusCode: 200, body: VALID_RESPONSE }
    )
    const configurationSource = source()

    configurationSource.start()
    await clock.tickAsync(30_000)
    assert.strictEqual(requests.length, 1)

    requests[0].reject(new Error('network failure'))
    await completeScheduledResponse()
    await clock.tickAsync(5000)
    assert.strictEqual(requests.length, 2)

    await clock.tickAsync(29_999)
    assert.strictEqual(requests.length, 2)
    await clock.tickAsync(1)
    assert.strictEqual(requests.length, 3)
  })

  it('stops retry timers and aborts an active request', async () => {
    responses.push({ pending: true })
    const configurationSource = source()

    configurationSource.start()
    configurationSource.stop()
    configurationSource.stop()
    await completeScheduledResponse()
    await clock.tickAsync(60_000)

    assert.strictEqual(requests.length, 1)
    assert.strictEqual(requests[0].options.signal.aborted, true)
  })

  it('stops a scheduled poll and reports subsequent polls as stopped', async () => {
    responses.push({ statusCode: 200, body: VALID_RESPONSE })
    const configurationSource = source()

    configurationSource.start()
    await completeScheduledResponse()
    configurationSource.stop()
    const outcome = await poll(configurationSource)
    await clock.tickAsync(30_000)

    assert.deepStrictEqual(outcome, { error: null, result: { stopped: true } })
    assert.strictEqual(requests.length, 1)
  })

  it('starts only once', () => {
    responses.push({ pending: true })
    const configurationSource = source()

    configurationSource.start()
    configurationSource.start()

    assert.strictEqual(requests.length, 1)
  })
})
