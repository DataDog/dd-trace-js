'use strict'

const assert = require('node:assert/strict')

const { OpenFeature } = require('@openfeature/server-sdk')
const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')
const { testBooleanAndStringFlags: configuration } =
  require('../../../../integration-tests/openfeature/fixtures/ufc-payloads')
const tracerVersion = require('../../../../package.json').version

describe('Feature Flags shared event delivery', () => {
  let clock, config, discover, requests, provider, exposures, evaluations, handlers, client

  beforeEach(async () => {
    clock = sinon.useFakeTimers()
    handlers = new Set(globalThis[Symbol.for('dd-trace')].beforeExitHandlers)
    requests = []
    config = {
      url: new URL('http://localhost:8126/prefix/'),
      site: 'datadoghq.com',
      DD_API_KEY: 'direct-only-key',
      service: 'checkout',
      featureFlags: {
        DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless',
        DD_FLAGGING_EVALUATION_COUNTS_ENABLED: true,
        DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS: 1000,
      },
    }
    const Base = proxyquire('../../src/openfeature/writers/base', {
      '../../exporters/common/request': (body, options, callback) => {
        requests.push({ body: JSON.parse(body), options, callback })
      },
    })
    const Consumer = proxyquire('../../src/openfeature/writers/flag-evaluation-consumer', { './base': Base })
    // Exercise the real provider, hook, exposure module, selector and sender.
    // Only worker scheduling is replaced by its consumer under deterministic fake time;
    // the existing real-process suite covers worker routing and shutdown separately.
    class Writer extends Consumer {
      constructor (config) {
        super(config)
        evaluations = this
      }

      getUnavailableReason () { return this.hasCapacity() ? undefined : 'unavailable' }
    }
    Writer['@noCallThru'] = true
    discover = sinon.stub()
    const strategy = proxyquire('../../src/openfeature/writers/util', {
      '../../evp_proxy/discovery': { discoverEVPProxy: discover },
    })
    const Hook = proxyquire('../../src/openfeature/writers/flag-eval-evp-hook', {
      './flag-evaluations': Writer,
      './util': strategy,
    })
    const Provider = proxyquire('../../src/openfeature/flagging_provider', {
      './writers/flag-eval-evp-hook': Hook,
      './configuration_source': { create: sinon.stub() },
    })
    exposures = proxyquire('../../src/openfeature', {
      './writers/exposures': proxyquire('../../src/openfeature/writers/exposures', { './base': Base }),
      './writers/util': strategy,
    })
    // This is the same construction order and config identity as tracer.openfeature.
    provider = new Provider({}, config)
    exposures.enable(config)
    provider.setConfiguration(configuration)
    await OpenFeature.setProviderAndWait('shared-delivery', provider)
    client = OpenFeature.getClient('shared-delivery')
  })

  afterEach(async () => {
    provider.onClose()
    exposures.disable()
    for (const request of requests) {
      if (!request.completed) request.callback(null, '', 202)
    }
    await OpenFeature.clearProviders()
    assert.deepStrictEqual(globalThis[Symbol.for('dd-trace')].beforeExitHandlers, handlers)
    clock.runMicrotasks()
    assert.strictEqual(clock.countTimers(), 0)
    clock.restore()
  })

  async function evaluate (targetingKey) {
    assert.strictEqual(await client.getBooleanValue('test-boolean-flag', false, { targetingKey }), true)
    channel('ffe:writers:flush').publish()
    evaluations.flush()
  }

  function respond (request, error, status) {
    request.completed = true
    request.callback(error, '', status)
  }

  for (const failedSignal of ['exposures', 'flagevaluation']) {
    for (const failure of [404, 503, 'ECONNRESET']) {
      it(`shares ${failedSignal} fallback after ${failure} without unsafe replay`, async () => {
        sinon.assert.calledOnce(discover)
        discover.firstCall.args[2](null, { url: config.url, basePath: '/prefix/evp_proxy/v4' })
        await evaluate('before-fallback')
        assert.strictEqual(requests.length, 2)
        for (const { options } of requests) {
          assert.match(options.path, /^\/prefix\/evp_proxy\/v4\/api\/v2\//)
          assert.strictEqual(options.headers['DD-API-KEY'], undefined)
          assert.strictEqual(options.headers['X-Datadog-EVP-Subdomain'], 'event-platform-intake')
          assert.strictEqual(options.headers['DD-EVP-ORIGIN'], 'dd-trace-js')
          assert.strictEqual(options.headers['DD-EVP-ORIGIN-VERSION'], tracerVersion)
          assert.strictEqual(options.retry, false)
        }
        const failed = requests.find(({ options }) => options.path.endsWith('/' + failedSignal))
        const other = requests.find(request => request !== failed)
        respond(other, null, 202)
        respond(failed, typeof failure === 'string' ? Object.assign(new Error('reset'), { code: failure }) : null,
          typeof failure === 'number' ? failure : undefined)
        assert.strictEqual(requests.length, failure === 404 ? 3 : 2)
        if (failure === 404) {
          assert.deepStrictEqual(requests[2].body, failed.body)
          respond(requests[2], null, 202)
        }

        await evaluate('after-fallback')
        const next = requests.slice(-2)
        assert.deepStrictEqual(new Set(next.map(({ options }) => options.path)),
          new Set(['/api/v2/exposures', '/api/v2/flagevaluation']))
        for (const { options } of next) {
          assert.strictEqual(options.url.href, 'https://event-platform-intake.datadoghq.com/')
          assert.strictEqual(options.headers['DD-API-KEY'], 'direct-only-key')
          assert.strictEqual(options.headers['X-Datadog-EVP-Subdomain'], undefined)
          assert.strictEqual(options.headers['DD-EVP-ORIGIN'], 'dd-trace-js')
          assert.strictEqual(options.headers['DD-EVP-ORIGIN-VERSION'], tracerVersion)
          assert.strictEqual(options.retry, false)
        }
        assert.strictEqual(requests.length, failure === 404 ? 5 : 4)
        sinon.assert.calledOnce(discover)
      })
    }
  }

  it('keeps exposure routing alive when the provider closes', async () => {
    sinon.assert.calledOnce(discover)
    provider.onClose()
    discover.firstCall.args[2](null, { url: config.url, basePath: '/prefix/evp_proxy/v4' })
    channel('ffe:exposure:submit').publish({ flag: { key: 'remaining-consumer' }, subject: { id: 'customer' } })
    channel('ffe:writers:flush').publish()
    assert.strictEqual(requests.length, 1)
    assert.strictEqual(requests[0].options.path, '/prefix/evp_proxy/v4/api/v2/exposures')
  })
})
