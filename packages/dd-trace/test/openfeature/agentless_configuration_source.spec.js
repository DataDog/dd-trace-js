'use strict'

const assert = require('node:assert/strict')
const { beforeEach, describe, it } = require('mocha')
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
  let config
  let fetch
  let log
  let requests
  let responses
  let runInNoopContext

  beforeEach(() => {
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

  function source (options = {}) {
    return new AgentlessConfigurationSource(config, applyConfiguration, {
      fetch,
      ...options,
    })
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
      }
    )
    const configurationSource = source()

    await poll(configurationSource)
    await poll(configurationSource)

    sinon.assert.notCalled(applyConfiguration)
    sinon.assert.calledTwice(log.debug)
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

})
