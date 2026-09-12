'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach, afterEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')
const { joinEVPProxyPath } = require('../../../src/evp_proxy/path')
const tracerVersion = require('../../../../../package.json').version

const FLAG_EVALUATIONS_ENDPOINT = '/api/v2/flagevaluation'

describe('OpenFeature Base FFE Writer transport', () => {
  let FlagEvaluationWriter
  let clock
  let config
  let log
  let request
  let writer

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    config = { url: new URL('http://localhost:8126') }
    log = {
      debug: sinon.spy(),
      error: sinon.spy(),
      warn: sinon.spy(),
    }
    request = sinon.stub().yieldsAsync(null, 'OK', 202)
    const BaseFFEWriter = proxyquire('../../../src/openfeature/writers/base', {
      '../../exporters/common/request': request,
      '../../log': log,
    })

    FlagEvaluationWriter = class extends BaseFFEWriter {
      /** Creates a minimal future signal writer against the shared transport seam. */
      constructor () {
        super({ config, endpoint: FLAG_EVALUATIONS_ENDPOINT })
      }

      /**
       * @param {object} route - Selected event route
       * @returns {void}
       */
      setRoute (route) {
        const mapRoute = selectedRoute => ({
          url: selectedRoute.url,
          endpoint: joinEVPProxyPath(selectedRoute.basePath, FLAG_EVALUATIONS_ENDPOINT),
          headers: selectedRoute.headers ?? {},
          onFallback: selectedRoute.onFallback,
          onUnavailable: selectedRoute.onUnavailable,
        })

        this._setRoutes(mapRoute(route), route.fallback && mapRoute(route.fallback))
      }

      /**
       * @param {string} payload - Encoded aggregate payload
       * @param {number} eventCount - Aggregate event count
       * @returns {void}
       */
      send (payload, eventCount) {
        this._sendPayload(payload, eventCount)
      }
    }

    writer = new FlagEvaluationWriter()
  })

  afterEach(() => {
    writer?.destroy()
    clock.restore()
  })

  it('provides a send-once shared path with logical SDK identity', () => {
    const directUrl = new URL('https://event-platform-intake.datadoghq.com')
    writer.setRoute({
      url: directUrl,
      basePath: '',
      headers: { 'DD-API-KEY': 'test-api-key' },
    })

    writer.send('{"flag":"checkout","count":2}', 2)

    sinon.assert.calledOnce(request)
    const [payload, options] = request.firstCall.args
    assert.strictEqual(payload, '{"flag":"checkout","count":2}')
    assert.strictEqual(options.url, directUrl)
    assert.strictEqual(options.path, FLAG_EVALUATIONS_ENDPOINT)
    assert.strictEqual(options.retry, false)
    assert.strictEqual(options.headers['DD-API-KEY'], 'test-api-key')
    assert.strictEqual(options.headers['DD-EVP-ORIGIN'], 'dd-trace-js')
    assert.strictEqual(options.headers['DD-EVP-ORIGIN-VERSION'], tracerVersion)
    assert.strictEqual(options.headers['X-Datadog-EVP-Subdomain'], undefined)
  })

  it('replays a proven pre-connect local failure once through direct intake', async () => {
    const localUrl = new URL('http://localhost:8126')
    const directUrl = new URL('https://event-platform-intake.datadoghq.com')
    const onFallback = sinon.spy()
    request.onFirstCall().yieldsAsync(Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }))
    writer.setRoute({
      url: localUrl,
      basePath: '/evp_proxy/v4',
      headers: { 'X-Datadog-EVP-Subdomain': 'event-platform-intake' },
      onFallback,
      fallback: {
        url: directUrl,
        basePath: '',
        headers: { 'DD-API-KEY': 'test-api-key' },
      },
    })

    writer.send('{"flag":"checkout","count":2}', 2)
    await clock.tickAsync(0)

    sinon.assert.calledTwice(request)
    assert.strictEqual(request.firstCall.args[1].url, localUrl)
    assert.strictEqual(request.secondCall.args[1].url, directUrl)
    sinon.assert.calledOnce(onFallback)
  })

  it('does not replay an ambiguous local failure but replaces the future route', async () => {
    const localUrl = new URL('http://localhost:8126')
    const directUrl = new URL('https://event-platform-intake.datadoghq.com')
    const onFallback = sinon.spy()
    request.onFirstCall().yieldsAsync(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }))
    writer.setRoute({
      url: localUrl,
      basePath: '/evp_proxy/v4',
      headers: { 'X-Datadog-EVP-Subdomain': 'event-platform-intake' },
      onFallback,
      fallback: {
        url: directUrl,
        basePath: '',
        headers: { 'DD-API-KEY': 'test-api-key' },
      },
    })

    writer.send('{"flag":"ambiguous","count":1}', 1)
    await clock.tickAsync(0)

    sinon.assert.calledOnce(request)
    sinon.assert.calledOnce(onFallback)

    writer.send('{"flag":"next","count":1}', 1)
    sinon.assert.calledTwice(request)
    assert.strictEqual(request.secondCall.args[1].url, directUrl)
  })
})
