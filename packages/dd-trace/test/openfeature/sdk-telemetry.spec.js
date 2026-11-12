'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../setup/core')
const { VERSION } = require('../../../../version')
const { testBooleanAndStringFlags: configuration } =
  require('../../../../integration-tests/openfeature/fixtures/ufc-payloads')

const NOW = Date.UTC(2026, 10, 5)

describe('Feature Flags SDK diagnostics', () => {
  let clock, provider, Provider, config, request, selectRoute, stopDelivery, onFetchResult, onFetchStart
  let handlers, telemetryNow

  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: NOW })
    handlers = new Set(globalThis[Symbol.for('dd-trace')].beforeExitHandlers)
    config = {
      service: 'checkout',
      env: 'staging',
      version: 'app-version',
      url: new URL('http://localhost:8126'),
      featureFlags: {
        DD_FLAGGING_EVALUATION_COUNTS_ENABLED: false,
        DD_FEATURE_FLAGS_EXPOSURES_DATADOG_LOGGING_ENABLED: false,
        DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS: 30_000,
      },
    }
    request = sinon.stub().callsFake((body, options, callback) => callback(null, '', 202))
    stopDelivery = sinon.spy()
    selectRoute = sinon.stub().callsFake((config, notify) => {
      notify(true, { url: config.url, basePath: '/evp_proxy/v2' })
      return stopDelivery
    })
    const Base = proxyquire('../../src/openfeature/writers/base', {
      '../../exporters/common/request': request,
    })
    const Writer = proxyquire('../../src/openfeature/writers/sdk-diagnostics', {
      './base': Base,
      './util': { setEventDeliveryStrategy: selectRoute },
    })
    telemetryNow = sinon.spy(clock.performance.now)
    const Telemetry = proxyquire('../../src/openfeature/sdk-telemetry', {
      './writers/sdk-diagnostics': Writer,
      'node:perf_hooks': { performance: { now: telemetryNow } },
    })
    Provider = proxyquire('../../src/openfeature/flagging_provider', {
      './sdk-telemetry': Telemetry,
      './configuration_source': {
        create: (config, apply, observe, start) => {
          onFetchResult = observe
          onFetchStart = start
        },
      },
    })
  })

  afterEach(() => {
    provider?.onClose()
    assert.deepStrictEqual(globalThis[Symbol.for('dd-trace')].beforeExitHandlers, handlers)
    clock.restore()
  })

  function create () {
    provider = new Provider({}, config)
    return provider
  }

  function events () {
    return request.getCalls().flatMap(call => JSON.parse(call.args[0]).diagnostics.map(event => {
      assert.strictEqual(event.type, 'sdk_diagnostic')
      assert.strictEqual(event.schema_version, 1)
      assert.deepStrictEqual(Object.keys(event).sort(), ['payload', 'schema_version', 'type'])
      return event.payload
    }))
  }

  function identity () {
    return { sdk_name: 'dd-trace-js', sdk_version: VERSION, service_id: 'checkout', environment: 'staging' }
  }

  async function ready () {
    create().setConfiguration(configuration)
    await provider.initialize()
  }

  it('sends the exact initialization contract without evaluations or evaluation counts', async () => {
    const pending = create().initialize()
    await clock.tickAsync(20)
    provider.setConfiguration(configuration)
    await pending
    await clock.tickAsync(1000)

    assert.deepStrictEqual(JSON.parse(request.firstCall.args[0]), {
      context: { service: 'checkout', env: 'staging', version: 'app-version' },
      flagEvaluations: [],
      diagnostics: [{
        type: 'sdk_diagnostic',
        schema_version: 1,
        payload: {
          ...identity(),
          timestamp: NOW + 20,
          event_type: 'sdk_initialization',
          initialization: {
            outcome: 'ready',
            started_at_ms: NOW,
            duration_ms: 20,
            final: true,
            milestones: { configuration_received: { elapsed_ms: 20 }, provider_ready: { elapsed_ms: 20 } },
          },
        },
      }],
    })
    const options = request.firstCall.args[1]
    assert.strictEqual(options.path, '/evp_proxy/v2/api/v2/flagevaluation')
    assert.strictEqual(options.headers['Content-Type'], 'application/json')
    assert.strictEqual(options.headers['DD-EVP-ORIGIN'], 'dd-trace-js')
  })

  it('reports preloaded rules as ready, without a cached-fallback claim', async () => {
    await ready()
    provider.onClose()
    assert.deepStrictEqual(events(), [{
      ...identity(),
      timestamp: NOW,
      event_type: 'sdk_initialization',
      initialization: {
        outcome: 'ready',
        started_at_ms: NOW,
        duration_ms: 0,
        final: true,
        milestones: { configuration_received: { elapsed_ms: 0 }, provider_ready: { elapsed_ms: 0 } },
      },
    }])
  })

  for (const outcome of ['preloaded', 'ready', 'failed', 'rules removed']) {
    it(`preserves ${outcome} initialization when closed in the same turn`, async () => {
      create()
      if (outcome === 'preloaded') provider.setConfiguration(configuration)
      const pending = provider.initialize()
      const failed = outcome === 'failed' || outcome === 'rules removed'
      const error = new Error('initialization failed')
      const settled = failed
        ? assert.rejects(pending, outcome === 'failed' ? actual => actual === error : /configuration is unavailable/)
        : pending
      if (outcome === 'failed') provider.setError(error)
      else if (outcome !== 'preloaded') provider.setConfiguration(configuration)
      if (outcome === 'rules removed') provider.setConfiguration(undefined)
      provider.onClose()
      await settled
      assert.deepStrictEqual(events().map(event => event.initialization.outcome), [failed ? 'failed' : 'ready'])
      sinon.assert.calledOnce(stopDelivery)
    })
  }

  it('preserves a cache initialization failure when closed after receiving rules', async () => {
    const error = new Error('cache initialization failed')
    create()
    sinon.stub(provider.exposureCache, 'init').rejects(error)
    const pending = provider.initialize()
    const rejected = assert.rejects(pending, actual => actual === error)
    provider.setConfiguration(configuration)
    provider.onClose()
    await rejected
    assert.deepStrictEqual(events().map(event => event.initialization.outcome), ['failed'])
    sinon.assert.calledOnce(stopDelivery)
  })

  it('keeps a rate-limited outage suppressed after the cooldown expires', async () => {
    await ready()
    onFetchResult(false)
    await clock.tickAsync(59_999)
    onFetchResult(true)
    onFetchResult(false)
    await clock.tickAsync(1)
    onFetchResult(false)
    await clock.tickAsync(1000)
    assert.strictEqual(events().length, 2)
    onFetchResult(true)
    onFetchResult(false)
    provider.onClose()
    assert.strictEqual(events().length, 3)
  })

  it('reports the existing timeout once and never reports late configuration as recovery', async () => {
    const rejected = assert.rejects(create().initialize(), /Initialization timeout/)
    onFetchResult(false)
    await clock.tickAsync(30_000)
    await rejected
    provider.setConfiguration(configuration)
    onFetchResult(true)
    provider.onClose()
    assert.deepStrictEqual(events(), [{
      ...identity(),
      timestamp: NOW + 30_000,
      event_type: 'sdk_initialization',
      error_code: 'INIT_FAILED',
      initialization: {
        outcome: 'failed', started_at_ms: NOW, duration_ms: 30_000, final: true, milestones: {},
      },
    }])
  })

  it('preserves the original error and excludes its message from diagnostics', async () => {
    const error = new Error('credential-and-customer-data')
    const rejected = assert.rejects(create().initialize(), actual => actual === error)
    provider.setError(error)
    await rejected
    provider.onClose()
    assert.strictEqual(events()[0].error_code, 'INIT_FAILED')
    assert.doesNotMatch(request.firstCall.args[0], /credential-and-customer-data/)
  })

  it('reports a pending close once and ignores late initialization settlement', async () => {
    const pending = create().initialize()
    await clock.tickAsync(25)
    provider.onClose()
    provider.onClose()
    provider.setConfiguration(configuration)
    await pending
    onFetchResult(false)
    await clock.tickAsync(1000)
    assert.deepStrictEqual(events(), [{
      ...identity(),
      timestamp: NOW + 25,
      event_type: 'sdk_initialization',
      initialization: {
        outcome: 'incomplete',
        reason: 'provider_closed',
        started_at_ms: NOW,
        duration_ms: 25,
        final: false,
        milestones: {},
      },
    }])
    sinon.assert.calledOnce(stopDelivery)
  })

  it('does not emit for construction and close without initialization', () => {
    create().onClose()
    sinon.assert.notCalled(selectRoute)
    sinon.assert.notCalled(request)
  })

  it('bounds fetch errors, resets on success, and does not change the usable rules', async () => {
    await ready()
    onFetchResult(false)
    await clock.tickAsync(60_000)
    onFetchResult(false)
    assert.strictEqual(events().length, 2)
    onFetchResult(true)
    onFetchResult(false)
    onFetchResult(true)
    onFetchResult(false)
    await clock.tickAsync(1000)
    assert.strictEqual(events().length, 3)
    assert.deepStrictEqual(events().slice(1), [NOW, NOW + 60_000].map(timestamp => ({
      ...identity(), timestamp, event_type: 'provider_error', error_code: 'CONFIG_FETCH_FAILED',
    })))
    assert.strictEqual(provider.getConfiguration(), configuration)
    onFetchResult(true)
    provider.setConfiguration(configuration)
    provider.onClose()
    assert.strictEqual(events().length, 3)
  })

  for (const outcome of ['ready', 'failed']) {
    it(`does not report a startup fetch failure that completes after initialization is ${outcome}`, async () => {
      create()
      onFetchStart()
      const pending = provider.initialize()
      const settled = pending.catch(() => {})
      if (outcome === 'ready') {
        provider.setConfiguration(configuration)
        await pending
      } else {
        await clock.tickAsync(30_000)
        await assert.rejects(pending, /Initialization timeout/)
      }
      onFetchResult(false)
      await clock.tickAsync(1000)
      assert.deepStrictEqual(events().map(event => event.event_type), ['sdk_initialization'])

      // A new poll after initialization may report its own failure.
      onFetchStart()
      onFetchResult(false)
      provider.onClose()
      assert.deepStrictEqual(events().map(event => event.event_type), ['sdk_initialization', 'provider_error'])
      await settled
    })
  }

  it('does not turn arbitrary provider errors into configuration fetch errors', async () => {
    await ready()
    provider.setError(new Error('not a fetch failure'))
    provider.onClose()
    assert.strictEqual(events().length, 1)
  })

  for (const field of ['service', 'env']) {
    for (const value of [undefined, null, 42, '', ' ', ' leading', 'x'.repeat(201), 'contains\ncontrol']) {
      it(`skips diagnostics work with invalid ${field}: ${String(value).slice(0, 10)}`, async () => {
        config[field] = value
        await ready()
        provider.onClose()
        assert.strictEqual(onFetchResult, undefined)
        assert.strictEqual(onFetchStart, undefined)
        sinon.assert.notCalled(telemetryNow)
        sinon.assert.notCalled(selectRoute)
        sinon.assert.notCalled(request)
      })
    }

    for (const outcome of ['ready', 'failed', 'closed']) {
      it(`preserves ${outcome} initialization without ${field}`, async () => {
        delete config[field]
        const pending = create().initialize()
        const error = new Error('configuration failed')
        if (outcome === 'failed') {
          const rejected = assert.rejects(pending, actual => actual === error)
          provider.setError(error)
          await rejected
        } else {
          if (outcome === 'closed') provider.onClose()
          provider.setConfiguration(configuration)
          await pending
          assert.strictEqual(provider.getConfiguration(), configuration)
        }
        provider.onClose()
        assert.strictEqual(onFetchResult, undefined)
        assert.strictEqual(onFetchStart, undefined)
        sinon.assert.notCalled(telemetryNow)
        sinon.assert.notCalled(selectRoute)
        sinon.assert.notCalled(request)
      })
    }
  }

  it('accepts service and environment names at the schema length limit', async () => {
    config.service = 's'.repeat(200)
    config.env = 'e'.repeat(200)
    await ready()
    provider.onClose()
    assert.strictEqual(events()[0].service_id, config.service)
    assert.strictEqual(events()[0].environment, config.env)
  })

  it('skips an initialization report if the wall clock moves behind its start', async () => {
    const pending = create().initialize()
    clock.setSystemTime(NOW - 1)
    provider.setConfiguration(configuration)
    await pending
    provider.onClose()
    sinon.assert.notCalled(request)
  })

  for (const elapsed of [86_400_000, 86_400_001]) {
    it(`honors the initialization duration limit at ${elapsed}ms`, async () => {
      config.featureFlags.DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS = elapsed + 1
      const pending = create().initialize()
      // Exercise the duration boundary without running a day of periodic writer flushes.
      clock.jump(elapsed)
      provider.setConfiguration(configuration)
      await pending
      provider.onClose()
      assert.strictEqual(events().length, elapsed === 86_400_000 ? 1 : 0)
      if (events().length) assert.strictEqual(events()[0].initialization.duration_ms, elapsed)
    })
  }

  it('keeps initialization successful if diagnostics cannot select a route', async () => {
    selectRoute.throws(new Error('route failure'))
    await ready()
    provider.onClose()
    sinon.assert.notCalled(request)
  })

  it('buffers until discovery, then uses the selected direct route', async () => {
    selectRoute.returns(stopDelivery)
    await ready()
    await clock.tickAsync(1000)
    sinon.assert.notCalled(request)
    selectRoute.firstCall.args[1](true, {
      url: new URL('https://event-platform-intake.datadoghq.com'),
      basePath: '',
      headers: { 'DD-API-KEY': 'test-key' },
    })
    await clock.tickAsync(1000)
    assert.strictEqual(request.firstCall.args[1].path, '/api/v2/flagevaluation')
    assert.strictEqual(request.firstCall.args[1].headers['DD-API-KEY'], 'test-key')
    assert.strictEqual(events().length, 1)
  })

  for (const outcome of ['incomplete', 'ready', 'failed']) {
    it(`discovers a route during initialization before a close-time ${outcome} report`, async () => {
      const discover = sinon.stub()
      const strategy = proxyquire('../../src/openfeature/writers/util', {
        '../../evp_proxy/discovery': { discoverEVPProxy: discover },
      })
      selectRoute.callsFake(strategy.setEventDeliveryStrategy)
      const pending = create().initialize()
      const settled = pending.catch(() => {})
      sinon.assert.calledOnce(discover)
      sinon.assert.notCalled(request)

      // Complete real strategy discovery asynchronously, while initialization is still pending.
      setTimeout(() => discover.firstCall.args[2](null, { url: config.url, basePath: '/evp_proxy/v2' }), 10)
      await clock.tickAsync(10)
      if (outcome === 'ready') {
        provider.setConfiguration(configuration)
        await pending
      } else if (outcome === 'failed') {
        provider.setError(new Error('initialization failed'))
        await assert.rejects(pending, /initialization failed/)
      }
      provider.onClose()
      assert.strictEqual(events().length, 1)
      assert.strictEqual(events()[0].initialization.outcome, outcome)
      sinon.assert.calledOnce(discover)

      if (outcome === 'incomplete') provider.setConfiguration(configuration)
      await settled
    })
  }

  it('does not send through an unconfirmed route at shutdown or accept late discovery', async () => {
    selectRoute.returns(stopDelivery)
    await ready()
    provider.onClose()
    selectRoute.firstCall.args[1](true, { url: config.url, basePath: '/evp_proxy/v2' })
    await clock.tickAsync(1000)
    sinon.assert.notCalled(request)
    sinon.assert.calledOnce(stopDelivery)
  })

  it('bounds its unavailable queue and discards stale observations', async () => {
    selectRoute.returns(stopDelivery)
    await ready()
    for (let i = 0; i < 20; i++) {
      onFetchResult(true)
      onFetchResult(false)
      await clock.tickAsync(60_000)
    }
    selectRoute.firstCall.args[1](true, { url: config.url, basePath: '/evp_proxy/v2' })
    await clock.tickAsync(1000)
    assert.strictEqual(events().length, 16)
    selectRoute.firstCall.args[1](false)
    onFetchResult(true)
    onFetchResult(false)
    await clock.tickAsync(60 * 60 * 1000)
    selectRoute.firstCall.args[1](true, { url: config.url, basePath: '/evp_proxy/v2' })
    await clock.tickAsync(1000)
    assert.strictEqual(events().length, 16)
  })

  it('uses safe local rejection fallback without changing the payload', async () => {
    selectRoute.callsFake((config, notify) => {
      notify(true, {
        url: config.url,
        basePath: '/evp_proxy/v4',
        fallback: {
          url: new URL('https://event-platform-intake.datadoghq.com'),
          basePath: '',
          headers: { 'DD-API-KEY': 'test-key' },
        },
      })
      return stopDelivery
    })
    request.onFirstCall().callsFake((body, options, callback) => callback(null, '', 404))
    await ready()
    provider.onClose()
    assert.strictEqual(request.callCount, 2)
    assert.strictEqual(request.firstCall.args[0], request.secondCall.args[0])
    assert.strictEqual(request.secondCall.args[1].path, '/api/v2/flagevaluation')
  })
})
