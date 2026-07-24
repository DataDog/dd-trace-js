'use strict'

const assert = require('node:assert/strict')
const zlib = require('node:zlib')

const { afterEach, beforeEach, describe, it } = require('mocha')
const nock = require('nock')
const proxyquire = require('proxyquire').noCallThru()
const sinon = require('sinon')

const { VERSION } = require('../../../../version')
require('../setup/core')

const VALID_UFC = {
  createdAt: '2026-01-01T00:00:00.000Z',
  format: 'SERVER',
  environment: { name: 'test' },
  flags: {},
}

/**
 * @param {object} [configuration]
 */
function responseBody (configuration = VALID_UFC) {
  return JSON.stringify({
    data: {
      id: '1',
      type: 'universal-flag-configuration',
      attributes: configuration,
    },
  })
}

describe('AgentlessConfigurationSource', () => {
  let AgentlessConfigurationSource
  let applyConfiguration
  let clock
  let config
  let log
  let random
  let request
  let requests
  let responses
  let sources

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
      error: sinon.spy(),
      warn: sinon.spy(),
    }
    random = sinon.stub(Math, 'random').returns(0.5)
    requests = []
    responses = []
    sources = []

    /**
     * @param {string} data
     * @param {{ signal?: AbortSignal }} options
     * @param {Function} callback
     */
    const sendRequest = (data, options, callback) => {
      const response = responses.shift()
      const requestRecord = {
        aborted: false,
        callback,
        data,
        options,
      }
      requests.push(requestRecord)

      /**
       * @returns {void}
       */
      const abort = () => {
        requestRecord.aborted = true
        if (response?.pending && !response.ignoreAbort) {
          const error = Object.assign(new Error('cancelled'), { name: 'AbortError' })
          queueMicrotask(() => callback(error))
        }
      }
      options.signal?.addEventListener('abort', abort, { once: true })

      if (response && !response.pending) {
        queueMicrotask(() => {
          options.signal?.removeEventListener('abort', abort)
          callback(
            response.error ?? null,
            response.body,
            response.statusCode,
            response.headers
          )
        })
      }
    }
    request = sinon.spy(sendRequest)

    AgentlessConfigurationSource = proxyquire('../../src/openfeature/agentless_configuration_source', {
      '../exporters/common/request': request,
      '../log': log,
    })
  })

  afterEach(() => {
    for (const configurationSource of sources) configurationSource.stop()
    random.restore()
    clock?.restore()
    nock.cleanAll()
  })

  function source () {
    const configurationSource = new AgentlessConfigurationSource(config, applyConfiguration)
    sources.push(configurationSource)
    return configurationSource
  }

  async function flush () {
    for (let i = 0; i < 10; i++) await clock.tickAsync(0)
  }

  /**
   * @param {number} milliseconds
   */
  async function tick (milliseconds) {
    await clock.tickAsync(milliseconds)
    await flush()
  }

  it('fetches, applies, and reuses an accepted ETag', async () => {
    responses.push(
      { statusCode: 200, headers: { etag: ['  W/"ufc-v1"  '] }, body: responseBody() },
      { statusCode: 304 }
    )

    source().start()
    await flush()

    sinon.assert.calledOnceWithExactly(applyConfiguration, VALID_UFC)
    assert.strictEqual(requests[0].data, '')
    assert.strictEqual(requests[0].options.url, config.endpoint)
    assert.strictEqual(requests[0].options.method, 'GET')
    assert.strictEqual(requests[0].options.retry, false)
    assert.strictEqual(requests[0].options.timeout, 2000)
    assert.strictEqual(requests[0].options.headers['DD-API-KEY'], 'test-api-key')
    assert.strictEqual(requests[0].options.headers['Accept-Encoding'], 'gzip')
    assert.strictEqual(requests[0].options.headers['DD-Client-Library-Language'], 'nodejs')
    assert.strictEqual(requests[0].options.headers['DD-Client-Library-Version'], VERSION)
    assert.strictEqual(requests[0].options.headers['If-None-Match'], undefined)

    await tick(30_000)

    assert.strictEqual(requests[1].options.headers['If-None-Match'], 'W/"ufc-v1"')
    sinon.assert.calledOnce(applyConfiguration)
  })

  it('clears an accepted ETag when the next applied response omits it', async () => {
    responses.push(
      { statusCode: 200, headers: { etag: '"first"' }, body: responseBody() },
      { statusCode: 200, body: responseBody() },
      { statusCode: 304 }
    )

    source().start()
    await flush()
    await tick(30_000)
    await tick(30_000)

    assert.strictEqual(requests[1].options.headers['If-None-Match'], '"first"')
    assert.strictEqual(requests[2].options.headers['If-None-Match'], undefined)
    sinon.assert.calledTwice(applyConfiguration)
  })

  it('buffers, decompresses, and applies a response through the shared request transport', async () => {
    clock.restore()
    clock = undefined
    const body = zlib.gzipSync(responseBody())
    config.endpoint = new URL('http://flags.dev.internal:8080/custom/ufc')
    delete config.apiKey
    nock('http://flags.dev.internal:8080', {
      badheaders: ['dd-api-key'],
      reqheaders: {
        'accept-encoding': 'gzip',
      },
    })
      .get('/custom/ufc')
      .reply(200, body, {
        'content-encoding': 'gzip',
        etag: '"real-path"',
      })

    let resolveConfiguration
    const applied = new Promise(resolve => {
      resolveConfiguration = resolve
    })
    const RealAgentlessConfigurationSource = proxyquire('../../src/openfeature/agentless_configuration_source', {
      '../log': log,
    })
    const configurationSource = new RealAgentlessConfigurationSource(config, resolveConfiguration)
    sources.push(configurationSource)

    configurationSource.start()

    assert.deepStrictEqual(await applied, VALID_UFC)
    assert.ok(nock.isDone())
  })

  it('matches JSON.parse duplicate-key and __proto__ behavior', async () => {
    const body = '{"data":{"type":"wrong","type":"universal-flag-configuration","attributes":' +
      '{"createdAt":"2026-01-01T00:00:00.000Z","format":"SERVER","environment":{"name":"test"},' +
      '"flags":{"__proto__":{"enabled":true}}}}}'
    const expected = JSON.parse(body).data.attributes
    responses.push({ statusCode: 200, body })

    source().start()
    await flush()

    sinon.assert.calledOnceWithExactly(applyConfiguration, expected)
    assert.strictEqual(Object.hasOwn(applyConfiguration.firstCall.args[0].flags, '__proto__'), true)
    assert.strictEqual(Object.prototype.enabled, undefined)
  })

  it('preserves last-known-good state and logs malformed responses once', async () => {
    responses.push(
      { statusCode: 200, headers: { etag: '"good"' }, body: responseBody() },
      { statusCode: 200, headers: { etag: '"bad"' }, body: `${responseBody()} trailing` },
      {
        statusCode: 200,
        headers: { etag: '"bad"' },
        body: responseBody({ ...VALID_UFC, format: undefined }),
      },
      { statusCode: 304 }
    )

    source().start()
    await flush()
    await tick(30_000)
    await tick(30_000)
    await tick(30_000)

    sinon.assert.calledOnce(applyConfiguration)
    sinon.assert.calledOnce(log.error)
    assert.strictEqual(requests[3].options.headers['If-None-Match'], '"good"')
  })

  it('rejects unrelated and invalid UFC resources', async () => {
    responses.push(
      {
        statusCode: 200,
        body: JSON.stringify({ data: { type: 'other', attributes: VALID_UFC } }),
      },
      {
        statusCode: 200,
        body: responseBody({ ...VALID_UFC, environment: [] }),
      },
      {
        statusCode: 200,
        body: JSON.stringify({
          data: {
            type: 'universal-flag-configuration',
            attributes: 'invalid',
          },
        }),
      }
    )

    source().start()
    await flush()
    await tick(30_000)
    await tick(30_000)

    sinon.assert.notCalled(applyConfiguration)
    sinon.assert.calledOnce(log.error)
  })

  it('does not expose malformed payload data in logs', async () => {
    responses.push(
      {
        statusCode: 200,
        body: '{"secret-json-value":',
      },
      {
        statusCode: 200,
        body: responseBody({
          createdAt: 'secret-created-at',
          environment: { name: 'secret-environment' },
          flags: {},
          'secret-property-name': 'secret-property-value',
        }),
      }
    )

    source().start()
    await flush()
    await tick(30_000)

    sinon.assert.calledOnceWithExactly(
      log.error,
      'Feature Flagging agentless endpoint returned malformed UFC payload'
    )
  })

  it('does not advance the ETag after an application failure and logs it once', async () => {
    applyConfiguration.onSecondCall().throws(new Error('listener failed'))
    applyConfiguration.onThirdCall().throws(new Error('listener failed again'))
    responses.push(
      { statusCode: 200, headers: { etag: '"good"' }, body: responseBody() },
      { statusCode: 200, headers: { etag: '"failed"' }, body: responseBody() },
      { statusCode: 200, headers: { etag: '"failed-again"' }, body: responseBody() },
      { statusCode: 304 }
    )

    source().start()
    await flush()
    await tick(30_000)
    await tick(30_000)
    await tick(30_000)

    sinon.assert.calledThrice(applyConfiguration)
    sinon.assert.calledOnce(log.warn)
    assert.strictEqual(requests[3].options.headers['If-None-Match'], '"good"')
  })

  it('retries timeout, rate-limit, and server statuses with bounded delays', async () => {
    responses.push(
      { statusCode: 408 },
      { statusCode: 429 },
      { statusCode: 200, body: responseBody() }
    )

    source().start()
    await flush()
    await tick(4999)
    assert.strictEqual(requests.length, 1)
    await tick(1)
    assert.strictEqual(requests.length, 2)
    await tick(9999)
    assert.strictEqual(requests.length, 2)
    await tick(1)

    assert.strictEqual(requests.length, 3)
    sinon.assert.calledOnceWithExactly(applyConfiguration, VALID_UFC)
  })

  it('retries network and request-timeout errors without transport retries', async () => {
    responses.push(
      { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) },
      { error: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) },
      { statusCode: 200, body: responseBody() }
    )

    source().start()
    await flush()
    await tick(5000)
    await tick(10_000)

    assert.strictEqual(requests.length, 3)
    for (const requestRecord of requests) assert.strictEqual(requestRecord.options.retry, false)
    sinon.assert.calledOnceWithExactly(applyConfiguration, VALID_UFC)
  })

  it('retries when the shared transport cannot send the request', async () => {
    responses.push(
      {},
      { statusCode: 200, body: responseBody() }
    )

    source().start()
    await flush()
    await tick(5000)

    assert.strictEqual(requests.length, 2)
    sinon.assert.calledOnceWithExactly(applyConfiguration, VALID_UFC)
  })

  it('warns once per failure category', async () => {
    responses.push(
      { statusCode: 500 },
      { statusCode: 502 },
      { statusCode: 503 },
      { statusCode: 500 },
      { statusCode: 502 },
      { statusCode: 503 },
      { error: new Error('first') },
      { error: new Error('second') },
      { error: new Error('third') },
      { statusCode: 401 }
    )

    source().start()
    await flush()
    await tick(5000)
    await tick(10_000)
    await tick(30_000)
    await tick(5000)
    await tick(10_000)
    await tick(30_000)
    await tick(5000)
    await tick(10_000)
    await tick(30_000)

    assert.deepStrictEqual(log.warn.firstCall.args, [
      'Feature Flagging agentless endpoint returned HTTP %d after %d attempts',
      503,
      3,
    ])
    assert.deepStrictEqual(log.warn.secondCall.args, [
      'Feature Flagging agentless request failed after %d attempts: %s',
      3,
      'third',
    ])
    assert.deepStrictEqual(log.warn.thirdCall.args, [
      'Feature Flagging agentless endpoint returned HTTP %d; verify endpoint authentication',
      401,
    ])
  })

  it('warns after retryable request failures exhaust all attempts', async () => {
    responses.push(
      { error: new Error('first') },
      { error: new Error('second') },
      {}
    )

    source().start()
    await flush()
    await tick(5000)
    await tick(10_000)

    sinon.assert.calledOnceWithExactly(
      log.warn,
      'Feature Flagging agentless request failed after %d attempts: %s',
      3,
      'request was not sent'
    )
  })

  it('stops a failed polling loop and allows a later start', async () => {
    const sleep = sinon.stub()
    sleep.onFirstCall().rejects(new Error('timer failed'))
    sleep.onSecondCall().returns(new Promise(() => {}))
    responses.push(
      { statusCode: 200, body: responseBody() },
      { statusCode: 200, body: responseBody() }
    )
    const TimerFailureSource = proxyquire('../../src/openfeature/agentless_configuration_source', {
      'node:timers/promises': { setTimeout: sleep },
      '../exporters/common/request': request,
      '../log': log,
    })
    const configurationSource = new TimerFailureSource(config, applyConfiguration)
    sources.push(configurationSource)

    configurationSource.start()
    await flush()
    configurationSource.start()
    await flush()

    sinon.assert.calledTwice(applyConfiguration)
    sinon.assert.calledOnceWithExactly(
      log.warn,
      'Feature Flagging agentless request failed: %s',
      'timer failed'
    )
  })

  it('does not retry authentication or other non-retryable statuses', async () => {
    responses.push(
      { statusCode: 401 },
      { statusCode: 404 }
    )

    source().start()
    await flush()

    assert.strictEqual(requests.length, 1)
    sinon.assert.calledOnceWithExactly(
      log.warn,
      'Feature Flagging agentless endpoint returned HTTP %d; verify endpoint authentication',
      401
    )

    await tick(30_000)

    assert.strictEqual(requests.length, 2)
    sinon.assert.calledOnce(log.warn)
    sinon.assert.notCalled(applyConfiguration)
  })

  it('omits a missing API key and reports the endpoint authentication failure', async () => {
    delete config.apiKey
    responses.push({ statusCode: 401 })

    source().start()
    await flush()

    assert.strictEqual(Object.hasOwn(requests[0].options.headers, 'DD-API-KEY'), false)
    sinon.assert.calledOnceWithExactly(
      log.warn,
      'Feature Flagging agentless endpoint returned HTTP %d; verify endpoint authentication',
      401
    )
    sinon.assert.notCalled(applyConfiguration)
  })

  it('uses fixed-delay polling after a request completes', async () => {
    responses.push(
      { pending: true },
      { statusCode: 200, body: responseBody() }
    )

    source().start()
    await tick(30_000)
    assert.strictEqual(requests.length, 1)

    requests[0].callback(null, responseBody(), 200, {})
    await flush()
    await tick(29_999)
    assert.strictEqual(requests.length, 1)
    await tick(1)

    assert.strictEqual(requests.length, 2)
  })

  it('coalesces concurrent and repeated starts', async () => {
    responses.push({ pending: true })
    const configurationSource = source()

    configurationSource.start()
    configurationSource.start()
    configurationSource.start()
    await flush()

    assert.strictEqual(requests.length, 1)

    requests[0].callback(null, responseBody(), 200, {})
    await flush()
    configurationSource.start()

    assert.strictEqual(requests.length, 1)
  })

  it('stops an active request and ignores its response', async () => {
    responses.push({ pending: true, ignoreAbort: true })
    const configurationSource = source()

    configurationSource.start()
    configurationSource.stop()
    requests[0].callback(null, responseBody(), 200, {})
    await flush()

    assert.strictEqual(requests[0].aborted, true)
    sinon.assert.notCalled(applyConfiguration)
  })

  it('restarts after stop without accepting the previous request', async () => {
    const oldConfiguration = { ...VALID_UFC, environment: { name: 'old' } }
    const newConfiguration = { ...VALID_UFC, environment: { name: 'new' } }
    responses.push(
      { pending: true, ignoreAbort: true },
      { statusCode: 200, headers: { etag: '"new"' }, body: responseBody(newConfiguration) },
      { statusCode: 304 }
    )
    const configurationSource = source()

    configurationSource.start()
    configurationSource.stop()
    configurationSource.start()
    requests[0].callback(null, responseBody(oldConfiguration), 200, {})
    await flush()

    assert.strictEqual(requests.length, 2)
    sinon.assert.calledOnceWithExactly(applyConfiguration, newConfiguration)

    await tick(30_000)

    assert.strictEqual(requests[2].options.headers['If-None-Match'], '"new"')
  })

  it('stops a pending retry delay and can restart', async () => {
    responses.push(
      { error: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) },
      { statusCode: 200, body: responseBody() }
    )
    const configurationSource = source()

    configurationSource.start()
    await flush()
    configurationSource.stop()
    configurationSource.start()
    await flush()

    assert.strictEqual(requests.length, 2)
    sinon.assert.calledOnceWithExactly(applyConfiguration, VALID_UFC)
  })
})
