'use strict'

const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
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
      debug: sinon.spy(),
      warn: sinon.spy(),
    }
    random = sinon.stub(Math, 'random').returns(0.5)
    requests = []
    responses = []
    sources = []

    request = sinon.spy((data, options, callback) => {
      const response = responses.shift()
      let responseStream
      const activeRequest = {
        destroy: sinon.spy(() => {
          if (responseStream) {
            responseStream.destroy(new Error('cancelled'))
          } else if (response?.pending && !response.ignoreDestroy) {
            queueMicrotask(() => callback(new Error('cancelled')))
          }
        }),
      }
      const requestRecord = { activeRequest, callback, data, options }
      requests.push(requestRecord)

      if (response && !response.pending) {
        queueMicrotask(() => {
          if (response.error) {
            callback(response.error)
          } else {
            responseStream = createResponseStream(response)
            callback(null, responseStream)
          }
        })
      }

      return activeRequest
    })

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

  /**
   * @param {object} response
   */
  function createResponseStream (response) {
    const chunks = response.bodyChunks || [response.body || '']
    let pushed = false

    const responseStream = new Readable({
      read () {
        if (pushed) return
        pushed = true
        response.onRead?.()
        for (const chunk of chunks) {
          this.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }
        if (response.bodyError) {
          this.destroy(response.bodyError)
        } else if (!response.bodyPending) {
          this.push(null)
        }
      },
    })
    responseStream.statusCode = response.statusCode
    responseStream.headers = response.headers || {}
    return responseStream
  }

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
    const configurationSource = source()

    configurationSource.start()
    await flush()

    sinon.assert.calledOnceWithExactly(applyConfiguration, VALID_UFC)
    assert.strictEqual(requests[0].data, '')
    assert.strictEqual(requests[0].options.url, config.endpoint)
    assert.strictEqual(requests[0].options.method, 'GET')
    assert.strictEqual(requests[0].options.responseType, 'stream')
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
    const configurationSource = source()

    configurationSource.start()
    await flush()
    await tick(30_000)
    await tick(30_000)

    assert.strictEqual(requests[1].options.headers['If-None-Match'], '"first"')
    assert.strictEqual(requests[2].options.headers['If-None-Match'], undefined)
    sinon.assert.calledTwice(applyConfiguration)
  })

  it('streams and applies a response through the shared request transport', async () => {
    clock.restore()
    clock = undefined
    nock('http://127.0.0.1:8080', {
      reqheaders: {
        'accept-encoding': 'gzip',
        'dd-api-key': 'test-api-key',
      },
    })
      .get('/api/v2/feature-flagging/config/rules-based/server')
      .reply(200, responseBody(), { etag: '"real-path"' })

    let resolveConfiguration
    const applied = new Promise(resolve => {
      resolveConfiguration = resolve
    })
    const RealAgentlessConfigurationSource = proxyquire('../../src/openfeature/agentless_configuration_source', {
      '../log': log,
    })
    const configurationSource = new RealAgentlessConfigurationSource(config, configuration => {
      resolveConfiguration(configuration)
    })
    sources.push(configurationSource)

    configurationSource.start()

    assert.deepStrictEqual(await applied, VALID_UFC)
    assert.ok(nock.isDone())
  })

  it('selects only data type and attributes without a payload-size cap', async () => {
    const expected = {
      ...VALID_UFC,
      flags: {
        large: {
          description: 'accepted',
        },
      },
    }
    responses.push({
      statusCode: 200,
      body: JSON.stringify({
        ignored: 'x'.repeat(5 * 1024 * 1024 + 1),
        data: {
          ignored: { nested: 'value' },
          attributes: expected,
          type: 'universal-flag-configuration',
        },
      }),
    })

    source().start()
    await flush()

    sinon.assert.calledOnceWithExactly(applyConfiguration, expected)
  })

  it('matches JSON.parse object order and duplicate-key last-wins behavior', async () => {
    const expected = {
      environment: { name: 'last' },
      createdAt: '2026-07-21T00:00:00.000Z',
      flags: { enabled: { enabled: true } },
    }
    const body = '{"data":{"attributes":{"createdAt":"first"},"type":"wrong",' +
      `"type":"universal-flag-configuration","attributes":${JSON.stringify(expected)}}}`
    responses.push({ statusCode: 200, body })

    source().start()
    await flush()

    sinon.assert.calledOnce(applyConfiguration)
    const configuration = applyConfiguration.firstCall.args[0]
    assert.deepStrictEqual(configuration, expected)
    assert.deepStrictEqual(Object.keys(configuration), Object.keys(expected))
  })

  it('treats duplicate data members with JSON.parse last-wins behavior', async () => {
    responses.push({
      statusCode: 200,
      body: `{"data":${JSON.stringify({
        type: 'universal-flag-configuration',
        attributes: VALID_UFC,
      })},"data":{"attributes":${JSON.stringify(VALID_UFC)}}}`,
    })

    source().start()
    await flush()

    sinon.assert.notCalled(applyConfiguration)
    sinon.assert.calledOnce(log.debug)
  })

  it('rejects a primitive data member', async () => {
    responses.push({ statusCode: 200, body: '{"data":"invalid"}' })

    source().start()
    await flush()

    sinon.assert.notCalled(applyConfiguration)
    sinon.assert.calledOnce(log.debug)
  })

  it('preserves __proto__ as an own property like JSON.parse', async () => {
    const body = '{"data":{"type":"universal-flag-configuration","attributes":' +
      '{"createdAt":"2026-01-01T00:00:00.000Z","environment":{"name":"test"},' +
      '"flags":{"__proto__":{"enabled":true}}}}}'
    const expected = JSON.parse(body).data.attributes
    responses.push({ statusCode: 200, body })

    source().start()
    await flush()

    sinon.assert.calledOnce(applyConfiguration)
    const configuration = applyConfiguration.firstCall.args[0]
    assert.deepStrictEqual(configuration, expected)
    assert.strictEqual(Object.hasOwn(configuration.flags, '__proto__'), true)
    assert.strictEqual(Object.getPrototypeOf(configuration.flags), Object.prototype)
    assert.strictEqual(Object.prototype.enabled, undefined)
  })

  it('parses split UTF-8 and escaped JSON names and values', async () => {
    const expected = {
      createdAt: '2026-01-01T00:00:00.000Z',
      environment: { name: 'café 🚀' },
      flags: { escaped: { description: 'line\nbreak' } },
    }
    const body = '{"data":{"type":"universal-flag-configur\\u0061tion",' +
      `"attr\\u0069butes":${JSON.stringify(expected)}}}`
    const buffer = Buffer.from(body)
    const rocketByte = buffer.indexOf(Buffer.from('🚀'))
    responses.push({
      statusCode: 200,
      bodyChunks: [
        buffer.subarray(0, rocketByte + 1),
        buffer.subarray(rocketByte + 1, rocketByte + 3),
        buffer.subarray(rocketByte + 3),
      ],
    })

    source().start()
    await flush()

    sinon.assert.calledOnceWithExactly(applyConfiguration, expected)
  })

  it('preserves last-known-good state after malformed and truncated JSON', async () => {
    responses.push(
      { statusCode: 200, headers: { etag: '"good"' }, body: responseBody() },
      { statusCode: 200, headers: { etag: '"bad"' }, body: `${responseBody()} trailing` },
      { statusCode: 200, headers: { etag: '"bad"' }, body: '{"data":{"type":' },
      { statusCode: 304 }
    )
    const configurationSource = source()

    configurationSource.start()
    await flush()
    await tick(30_000)
    await tick(30_000)
    await tick(30_000)

    sinon.assert.calledOnce(applyConfiguration)
    sinon.assert.calledTwice(log.debug)
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
        body: JSON.stringify({
          data: {
            type: 'universal-flag-configuration',
            attributes: { ...VALID_UFC, environment: [] },
          },
        }),
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
    const configurationSource = source()

    configurationSource.start()
    await flush()
    await tick(30_000)
    await tick(30_000)

    sinon.assert.notCalled(applyConfiguration)
    sinon.assert.calledThrice(log.debug)
  })

  it('decompresses gzip responses before parsing', async () => {
    responses.push({
      statusCode: 200,
      headers: { 'content-encoding': ['GZip'] },
      body: zlib.gzipSync(responseBody()),
    })

    source().start()
    await flush()

    sinon.assert.calledOnceWithExactly(applyConfiguration, VALID_UFC)
  })

  it('preserves last-known-good state after gzip and response read errors', async () => {
    responses.push(
      { statusCode: 200, headers: { etag: '"good"' }, body: responseBody() },
      {
        statusCode: 200,
        headers: { etag: '"bad"', 'content-encoding': 'gzip' },
        body: 'not gzip',
      },
      {
        statusCode: 200,
        headers: { etag: '"bad"' },
        bodyError: new Error('read failed'),
      },
      { statusCode: 304 }
    )
    const configurationSource = source()

    configurationSource.start()
    await flush()
    await tick(30_000)
    await tick(30_000)
    await tick(30_000)

    sinon.assert.calledOnce(applyConfiguration)
    sinon.assert.calledTwice(log.debug)
    sinon.assert.calledOnceWithExactly(
      log.warn,
      'Feature Flagging agentless request failed: %s',
      'Feature Flagging agentless gzip response could not be decompressed'
    )
    assert.strictEqual(requests[3].options.headers['If-None-Match'], '"good"')
  })

  it('does not advance the ETag after an application failure', async () => {
    applyConfiguration.onSecondCall().throws(new Error('listener failed'))
    responses.push(
      { statusCode: 200, headers: { etag: '"good"' }, body: responseBody() },
      { statusCode: 200, headers: { etag: '"failed"' }, body: responseBody() },
      { statusCode: 304 }
    )
    const configurationSource = source()

    configurationSource.start()
    await flush()
    await tick(30_000)
    await tick(30_000)

    sinon.assert.calledTwice(applyConfiguration)
    sinon.assert.calledOnce(log.debug)
    assert.strictEqual(requests[2].options.headers['If-None-Match'], '"good"')
  })

  it('retries timeout, rate-limit, and server statuses with bounded delays', async () => {
    responses.push(
      { statusCode: 408 },
      { statusCode: 429 },
      { statusCode: 200, body: responseBody() }
    )
    const configurationSource = source()

    configurationSource.start()
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
    const configurationSource = source()

    configurationSource.start()
    await flush()
    await tick(5000)
    await tick(10_000)

    assert.strictEqual(requests.length, 3)
    for (const requestRecord of requests) assert.strictEqual(requestRecord.options.retry, false)
    sinon.assert.calledOnceWithExactly(applyConfiguration, VALID_UFC)
  })

  it('retries when the shared transport cannot send the request', async () => {
    responses.push(
      { pending: true },
      { statusCode: 200, body: responseBody() }
    )

    source().start()
    requests[0].callback(null)
    await flush()
    await tick(5000)

    assert.strictEqual(requests.length, 2)
    sinon.assert.calledOnceWithExactly(applyConfiguration, VALID_UFC)
  })

  it('warns after retryable failures exhaust all attempts', async () => {
    responses.push(
      { statusCode: 500 },
      { statusCode: 502 },
      { statusCode: 503 }
    )

    source().start()
    await flush()
    await tick(5000)
    await tick(10_000)

    sinon.assert.calledOnceWithExactly(
      log.warn,
      'Feature Flagging agentless endpoint returned HTTP %d after %d attempts',
      503,
      3
    )
  })

  it('warns after network failures exhaust all attempts', async () => {
    responses.push(
      { error: new Error('first') },
      { error: new Error('second') },
      { error: new Error('third') }
    )

    source().start()
    await flush()
    await tick(5000)
    await tick(10_000)

    sinon.assert.calledOnceWithExactly(
      log.warn,
      'Feature Flagging agentless request failed after %d attempts: %s',
      3,
      'Feature Flagging agentless request failed'
    )
  })

  it('does not retry authentication or other non-retryable statuses', async () => {
    responses.push(
      { statusCode: 401 },
      { statusCode: 404 }
    )
    const configurationSource = source()

    configurationSource.start()
    await flush()
    await tick(15_000)

    assert.strictEqual(requests.length, 1)
    sinon.assert.calledOnceWithExactly(
      log.warn,
      'Feature Flagging agentless endpoint returned HTTP %d; verify DD_API_KEY is configured and valid',
      401
    )

    await tick(15_000)

    assert.strictEqual(requests.length, 2)
    sinon.assert.calledOnce(log.warn)
    sinon.assert.notCalled(applyConfiguration)
  })

  it('rate-limits repeated authentication warnings', async () => {
    for (let i = 0; i < 11; i++) responses.push({ statusCode: i % 2 ? 403 : 401 })

    source().start()
    await flush()
    for (let i = 0; i < 10; i++) await tick(30_000)

    assert.strictEqual(requests.length, 11)
    sinon.assert.calledTwice(log.warn)
  })

  it('uses fixed-delay polling after a request completes', async () => {
    responses.push(
      { pending: true },
      { statusCode: 200, body: responseBody() }
    )
    const configurationSource = source()

    configurationSource.start()
    await tick(30_000)
    assert.strictEqual(requests.length, 1)

    requests[0].callback(null, createResponseStream({
      statusCode: 200,
      body: responseBody(),
    }), 200, {})
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

    requests[0].callback(null, createResponseStream({
      statusCode: 200,
      body: responseBody(),
    }), 200, {})
    await flush()
    configurationSource.start()

    assert.strictEqual(requests.length, 1)
  })

  it('stops and cancels an active request', async () => {
    responses.push({ pending: true })
    const configurationSource = source()

    configurationSource.start()
    configurationSource.stop()
    configurationSource.stop()
    configurationSource.start()
    await tick(60_000)

    sinon.assert.calledOnce(requests[0].activeRequest.destroy)
    assert.strictEqual(requests.length, 1)
  })

  it('stops and cancels an active response stream', async () => {
    responses.push({
      statusCode: 200,
      body: '{"data":',
      bodyPending: true,
    })
    const configurationSource = source()

    configurationSource.start()
    await flush()
    configurationSource.stop()
    await flush()

    sinon.assert.calledOnce(requests[0].activeRequest.destroy)
    sinon.assert.notCalled(applyConfiguration)
  })

  it('ignores a response that arrives while stopping', async () => {
    responses.push({ pending: true, ignoreDestroy: true })
    const configurationSource = source()

    configurationSource.start()
    configurationSource.stop()
    requests[0].callback(null, createResponseStream({
      statusCode: 200,
      body: responseBody(),
    }), 200, {})
    await flush()

    sinon.assert.notCalled(applyConfiguration)
  })

  it('stops a pending retry delay', async () => {
    responses.push(
      { error: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) },
      { statusCode: 200, body: responseBody() }
    )
    const configurationSource = source()

    configurationSource.start()
    await flush()
    configurationSource.stop()
    await tick(60_000)

    assert.strictEqual(requests.length, 1)
    sinon.assert.notCalled(applyConfiguration)
  })
})
