'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { describe, it, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

require('../../setup/core')

describe('OpenFeature discovery retry policy', () => {
  let clock
  let random
  let writer
  let stop
  let ExposuresWriter
  let setExposureDeliveryStrategy
  let infoErrorsRemaining
  let errorCode
  let postError
  let gets
  let posts
  let updates

  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: 0 })
    random = sinon.stub(Math, 'random').returns(0)
    infoErrorsRemaining = 1
    errorCode = 'ECONNREFUSED'
    postError = undefined
    gets = []
    posts = []
    updates = []

    // Keep discovery, retry budgets, request handling and buffering real. Only
    // the HTTP boundary and time are faked; retry state is fresh for each test.
    const retry = proxyquire('../../../src/exporters/common/retry', {})
    const request = proxyquire('../../../src/exporters/common/request', {
      http: { request: makeRequest },
      https: { request: makeRequest },
      './retry': retry,
    })
    const info = proxyquire('../../../src/agent/info', { '../exporters/common/request': request })
    const discovery = proxyquire('../../../src/evp_proxy/discovery', { '../agent/info': info })
    ;({ setExposureDeliveryStrategy } = proxyquire('../../../src/openfeature/writers/util', {
      '../../evp_proxy/discovery': discovery,
    }))
    const BaseWriter = proxyquire('../../../src/openfeature/writers/base', {
      '../../exporters/common/request': request,
    })
    ExposuresWriter = proxyquire('../../../src/openfeature/writers/exposures', { './base': BaseWriter })
  })

  afterEach(() => {
    stop?.()
    writer?.destroy()
    stop = writer = undefined
    random.restore()
    clock.restore()
  })

  for (const [code, url] of [
    ['ECONNREFUSED', 'http://localhost:8126'],
    ['ENOENT', 'unix:///tmp/openfeature-agent.sock'],
  ]) {
    it(`delivers queued Remote Config exposures when the Agent starts after ${code}`, async () => {
      errorCode = code
      start('remote_config', url)

      await clock.tickAsync(999)
      assert.deepStrictEqual(updates, [])
      assert.strictEqual(posts.length, 0)

      await clock.tickAsync(119_001)
      assert.deepStrictEqual(gets.map(get => get.at), [0, 1000])
      assert.deepStrictEqual(updates, [true])
      assert.strictEqual(posts.length, 1)
      assert.strictEqual(posts[0].options.path, '/evp_proxy/v2/api/v2/exposures')
      assert.strictEqual(posts[0].body.exposures[0].subject.id, 'pending-at-startup')
      assert.strictEqual(posts[0].options.headers['DD-API-KEY'], undefined)
      if (code === 'ENOENT') {
        assert.ok(gets.every(get => get.options.socketPath === '/tmp/openfeature-agent.sock'))
        assert.strictEqual(posts[0].options.socketPath, '/tmp/openfeature-agent.sock')
      }
    })

    it(`bounds Remote Config discovery retries when ${code} persists`, async () => {
      errorCode = code
      infoErrorsRemaining = Infinity
      start('remote_config', url)

      await clock.tickAsync(14_999)
      assert.deepStrictEqual(updates, [])
      await clock.tickAsync(105_001)

      assert.deepStrictEqual(gets.map(get => get.at), [0, 1000, 3000, 7000, 15_000])
      assert.deepStrictEqual(updates, [false])
      assert.strictEqual(posts.length, 0)
    })
  }

  it('selects sticky direct intake after one failed Agentless discovery attempt', async () => {
    start('agentless')

    await clock.tickAsync(1)
    assert.deepStrictEqual(updates, [true])
    await clock.tickAsync(119_999)

    assert.strictEqual(gets.length, 1)
    assert.strictEqual(posts.length, 1)
    assert.strictEqual(posts[0].options.hostname, 'event-platform-intake.datadoghq.com')
    assert.strictEqual(posts[0].options.path, '/api/v2/exposures')
    assert.strictEqual(posts[0].options.headers['DD-API-KEY'], 'test-api-key')
    assert.strictEqual(posts[0].options.headers['X-Datadog-EVP-Subdomain'], undefined)
  })

  it('leaves unavailable Agentless recovery to the cooldown rather than HTTP retries', async () => {
    start('agentless', 'http://localhost:8126', '')

    await clock.tickAsync(59_999)
    assert.deepStrictEqual(updates, [false])
    assert.strictEqual(gets.length, 1)
    assert.strictEqual(posts.length, 0)

    await clock.tickAsync(60_001)
    assert.deepStrictEqual(gets.map(get => get.at), [0, 60_000])
    assert.deepStrictEqual(updates, [false, true])
    assert.strictEqual(posts.length, 1)
    assert.strictEqual(posts[0].options.path, '/evp_proxy/v2/api/v2/exposures')
  })

  for (const source of ['remote_config', 'agentless']) {
    it(`does not retry an ambiguous exposure POST failure for ${source}`, async () => {
      infoErrorsRemaining = source === 'remote_config' ? 0 : 1
      postError = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
      start(source)

      await clock.tickAsync(120_000)

      assert.deepStrictEqual(updates, [true])
      assert.strictEqual(gets.length, 1)
      assert.strictEqual(posts.length, 1)
      assert.strictEqual(posts[0].options.retry, false)
    })
  }

  function start (source, url = 'http://localhost:8126', apiKey = 'test-api-key') {
    const config = {
      url: new URL(url),
      site: 'datadoghq.com',
      DD_API_KEY: apiKey,
      featureFlags: { DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: source },
    }
    writer = new ExposuresWriter(config)
    stop = setExposureDeliveryStrategy(config, (enabled, route) => {
      updates.push(enabled)
      writer.setEnabled(enabled, route)
    })
    writer.append({
      timestamp: 1,
      allocation: { key: 'allocation' },
      flag: { key: 'flag' },
      variant: { key: 'on' },
      subject: { id: 'pending-at-startup' },
    })
  }

  function makeRequest (options, onResponse) {
    const req = new EventEmitter()
    const chunks = []
    req.setTimeout = () => req
    req.write = chunk => chunks.push(chunk)
    req.end = () => {
      const isInfo = options.path === '/info'
      if (isInfo) gets.push({ at: Date.now(), options })
      else posts.push({ options, body: JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString()) })
      Promise.resolve().then(() => {
        const error = isInfo
          ? infoErrorsRemaining-- > 0 && Object.assign(new Error(errorCode), { code: errorCode })
          : postError
        if (error) {
          req.emit('error', error)
        } else {
          const res = new EventEmitter()
          res.statusCode = isInfo ? 200 : 202
          res.headers = {}
          res.setTimeout = () => res
          onResponse(res)
          const body = isInfo
            ? JSON.stringify({
              endpoints: ['/evp_proxy/v2'],
              evp_proxy_allowed_headers: ['DD-EVP-ORIGIN', 'DD-EVP-ORIGIN-VERSION'],
            })
            : ''
          res.emit('data', Buffer.from(body))
          res.emit('end')
        }
        req.emit('close')
      })
    }
    return req
  }
})
