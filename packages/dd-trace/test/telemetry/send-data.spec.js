'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire')

const { assertObjectContains } = require('../../../../integration-tests/helpers')
require('../setup/core')

describe('sendData', () => {
  const application = {
    language_name: 'nodejs',
    tracer_version: 'version',
  }
  const host = { hostname: 'test-host' }

  let sendDataModule
  let request

  beforeEach(() => {
    request = sinon.stub()
    sendDataModule = proxyquire('../../src/telemetry/send-data', {
      '../exporters/common/request': request,
    })
  })

  it('sends telemetry to the agent using hostname and port', () => {
    sendDataModule.sendData({
      hostname: '',
      port: '12345',
      tags: { 'runtime-id': '123' },
    }, application, host, 'req-type')

    sinon.assert.calledOnce(request)
    const options = request.getCall(0).args[1]

    assertObjectContains(options, {
      method: 'POST',
      path: '/telemetry/proxy/api/v2/apmtelemetry',
      headers: {
        'content-type': 'application/json',
        'dd-telemetry-api-version': 'v2',
        'dd-telemetry-request-type': 'req-type',
        'DD-Client-Library-Language': application.language_name,
        'DD-Client-Library-Version': application.tracer_version,
        'dd-session-id': '123',
      },
      url: undefined,
      hostname: '',
      port: '12345',
    })
  })

  it('sends telemetry to the configured socket url', () => {
    sendDataModule.sendData({
      url: 'unix:/foo/bar/baz',
      tags: { 'runtime-id': '123' },
    }, application, host, 'req-type')

    sinon.assert.calledOnce(request)
    const options = request.getCall(0).args[1]

    assertObjectContains(options, {
      method: 'POST',
      path: '/telemetry/proxy/api/v2/apmtelemetry',
      headers: {
        'content-type': 'application/json',
        'dd-telemetry-api-version': 'v2',
        'dd-telemetry-request-type': 'req-type',
        'DD-Client-Library-Language': application.language_name,
        'DD-Client-Library-Version': application.tracer_version,
        'dd-session-id': '123',
      },
      url: 'unix:/foo/bar/baz',
      hostname: undefined,
      port: undefined,
    })
  })

  it('adds the debug header when telemetry debug mode is enabled', () => {
    sendDataModule.sendData({
      url: '/test',
      tags: { 'runtime-id': '123' },
      telemetry: { DD_TELEMETRY_DEBUG: true },
    }, application, host, 'req-type')

    sinon.assert.calledOnce(request)
    const options = request.getCall(0).args[1]

    assert.strictEqual(options.headers['dd-telemetry-debug-enabled'], 'true')
  })

  it('includes both child and root session ids when provided', () => {
    sendDataModule.sendData({
      url: '/test',
      tags: { 'runtime-id': 'child-runtime-id' },
      DD_ROOT_JS_SESSION_ID: 'root-runtime-id',
    }, application, host, 'req-type')

    sinon.assert.calledOnce(request)
    const options = request.getCall(0).args[1]

    assert.strictEqual(options.headers['dd-session-id'], 'child-runtime-id')
    assert.strictEqual(options.headers['dd-root-session-id'], 'root-runtime-id')
  })

  it('removes internal-only fields from object payloads before sending them', () => {
    const payload = {
      message: 'test',
      logger: {},
      tags: {},
      serviceMapping: {},
    }
    sendDataModule.sendData({ tags: { 'runtime-id': '123' } }, application, host, 'req-type', payload)

    sinon.assert.calledOnce(request)
    const data = JSON.parse(request.getCall(0).args[0])

    const { logger, tags, serviceMapping, ...trimmedPayload } = payload
    assert.deepStrictEqual(data.payload, trimmedPayload)
  })

  it('preserves batch payload items when sending message batches', () => {
    const retryObjData = { payload: { foo: 'bar' }, request_type: 'req-type-1' }
    const payload = [{
      request_type: 'req-type-2',
      payload: {
        integrations: [
          { name: 'foo2', enabled: true, auto_enabled: true },
          { name: 'bar2', enabled: false, auto_enabled: true },
        ],
      },

    }, retryObjData]

    sendDataModule.sendData({ tags: { 'runtime-id': '123' } },
      application, host, 'message-batch', payload)

    sinon.assert.calledOnce(request)

    const data = JSON.parse(request.getCall(0).args[0])
    const expectedPayload = [{
      request_type: 'req-type-2',
      payload: {
        integrations: [
          { name: 'foo2', enabled: true, auto_enabled: true },
          { name: 'bar2', enabled: false, auto_enabled: true },
        ],
      },
    }, {
      request_type: 'req-type-1',
      payload: { foo: 'bar' },
    }]
    assert.strictEqual(data.request_type, 'message-batch')
    assert.deepStrictEqual(data.payload, expectedPayload)
  })

  it('uses the CI Visibility agentless intake when agentless mode is enabled', () => {
    sendDataModule.sendData(
      {
        isCiVisibility: true,
        testOptimization: { DD_CIVISIBILITY_AGENTLESS_ENABLED: true },
        tags: { 'runtime-id': '123' },
        site: 'datadoghq.eu',
      },
      application,
      host,
      'req-type'
    )

    sinon.assert.calledOnce(request)
    const options = request.getCall(0).args[1]
    assertObjectContains(options, {
      method: 'POST',
      path: '/api/v2/apmtelemetry',
    })
    const { url } = options
    assert.deepStrictEqual(url, new URL('https://instrumentation-telemetry-intake.datadoghq.eu'))
  })

  it('uses DD_CIVISIBILITY_AGENTLESS_URL for telemetry when the agentless intake is overridden', () => {
    sendDataModule.sendData(
      {
        isCiVisibility: true,
        testOptimization: {
          DD_CIVISIBILITY_AGENTLESS_ENABLED: true,
          DD_CIVISIBILITY_AGENTLESS_URL: new URL('https://my-intake.example/'),
        },
        tags: { 'runtime-id': '123' },
        site: 'datadoghq.eu',
      },
      application,
      host,
      'req-type'
    )

    sinon.assert.calledOnce(request)
    const options = request.getCall(0).args[1]
    const { url } = options
    assert.deepStrictEqual(url, new URL('https://my-intake.example/'))
  })

  it('reports an invalid CI Visibility agentless telemetry URL without sending', () => {
    const callback = sinon.spy()

    sendDataModule.sendData(
      {
        isCiVisibility: true,
        testOptimization: { DD_CIVISIBILITY_AGENTLESS_ENABLED: true },
        tags: { 'runtime-id': '123' },
        site: 'x:notaport',
      },
      application,
      host,
      'req-type',
      {},
      callback
    )

    sinon.assert.notCalled(request)
    sinon.assert.calledOnce(callback)
    assert.ok(callback.firstCall.args[0] instanceof Error)
    assert.deepStrictEqual(callback.firstCall.args[1], { payload: {}, reqType: 'req-type' })
  })

  it('sends the agentless backend telemetry with a URL object when the agent request fails', () => {
    request.yields(new Error('agent unreachable'))

    sendDataModule.sendData(
      {
        DD_API_KEY: 'secret-key',
        site: 'datadoghq.eu',
        tags: { 'runtime-id': '123' },
      },
      application,
      host,
      'req-type'
    )

    assert.strictEqual(request.callCount, 2)
    const backendOptions = request.getCall(1).args[1]
    assert.deepStrictEqual(backendOptions.url, new URL('https://instrumentation-telemetry-intake.datadoghq.eu'))
    assert.strictEqual(backendOptions.headers['DD-API-KEY'], 'secret-key')
  })

  it('waits for an agentless fallback active at the flush boundary', () => {
    sendDataModule.sendData(
      {
        DD_API_KEY: 'secret-key',
        site: 'datadoghq.eu',
        tags: { 'runtime-id': '123' },
      },
      application,
      host,
      'req-type'
    )
    const done = sinon.spy()

    sendDataModule.flush(done)
    request.firstCall.args[2](new Error('agent unreachable'))

    sinon.assert.notCalled(done)
    request.secondCall.args[2]()
    sinon.assert.calledOnce(done)
  })

  it('detaches a cancelled request flush boundary', () => {
    sendDataModule.sendData(
      { tags: { 'runtime-id': '123' } },
      application,
      host,
      'req-type'
    )
    const done = sinon.spy()

    const cancel = sendDataModule.flush(done)
    assert.strictEqual(typeof cancel, 'function')
    cancel()
    request.firstCall.args[2]()

    sinon.assert.notCalled(done)
  })

  it('completes once when the primary transport responds more than once', () => {
    const callback = sinon.spy()
    sendDataModule.sendData(
      { tags: { 'runtime-id': '123' } },
      application,
      host,
      'req-type',
      {},
      callback
    )
    const respond = request.firstCall.args[2]

    respond(null)
    respond(new Error('late response'))
    const done = sinon.spy()
    sendDataModule.flush(done)

    sinon.assert.calledOnceWithExactly(callback, null, { payload: {}, reqType: 'req-type' })
    sinon.assert.calledOnce(done)
  })

  it('completes once when the fallback transport responds more than once', () => {
    sendDataModule.sendData(
      {
        DD_API_KEY: 'secret-key',
        site: 'datadoghq.eu',
        tags: { 'runtime-id': '123' },
      },
      application,
      host,
      'req-type'
    )

    request.firstCall.args[2](new Error('agent unreachable'))
    const respond = request.secondCall.args[2]
    respond(null)
    respond(new Error('late fallback response'))
    const done = sinon.spy()
    sendDataModule.flush(done)

    sinon.assert.calledOnce(done)
  })

  it('rethrows when the primary transport throws after responding', () => {
    const error = new Error('post-response failure')
    request.callsFake((data, options, callback) => {
      callback(null)
      throw error
    })

    assert.throws(() => sendDataModule.sendData(
      { tags: { 'runtime-id': '123' } },
      application,
      host,
      'req-type'
    ), error)

    const done = sinon.spy()
    sendDataModule.flush(done)
    sinon.assert.calledOnce(done)
  })

  it('rethrows when the fallback transport throws after responding', () => {
    const error = new Error('post-fallback-response failure')
    request.onFirstCall().callsFake((data, options, callback) => callback(new Error('agent unreachable')))
    request.onSecondCall().callsFake((data, options, callback) => {
      callback(null)
      throw error
    })

    assert.throws(() => sendDataModule.sendData(
      {
        DD_API_KEY: 'secret-key',
        site: 'datadoghq.eu',
        tags: { 'runtime-id': '123' },
      },
      application,
      host,
      'req-type'
    ), error)

    const done = sinon.spy()
    sendDataModule.flush(done)
    sinon.assert.calledOnce(done)
  })

  it('releases the request flush boundary when the transport throws synchronously', () => {
    const error = new Error('request failed synchronously')
    const callback = sinon.spy()
    request.throws(error)

    sendDataModule.sendData(
      { tags: { 'runtime-id': '123' } },
      application,
      host,
      'req-type',
      {},
      callback
    )

    const done = sinon.spy()
    sendDataModule.flush(done)

    sinon.assert.calledOnceWithExactly(callback, error, { payload: {}, reqType: 'req-type' })
    sinon.assert.calledOnce(done)
  })

  it('releases the request flush boundary when the fallback transport throws synchronously', () => {
    request.onSecondCall().throws(new Error('fallback failed synchronously'))
    sendDataModule.sendData(
      {
        DD_API_KEY: 'secret-key',
        site: 'datadoghq.eu',
        tags: { 'runtime-id': '123' },
      },
      application,
      host,
      'req-type'
    )

    request.firstCall.args[2](new Error('agent unreachable'))
    const done = sinon.spy()
    sendDataModule.flush(done)

    assert.strictEqual(request.callCount, 2)
    sinon.assert.calledOnce(done)
  })

  it('skips the agentless backend request when the endpoint URL is invalid', () => {
    request.yields(new Error('agent unreachable'))

    sendDataModule.sendData(
      {
        DD_API_KEY: 'secret-key',
        site: 'x:notaport',
        tags: { 'runtime-id': '123' },
      },
      application,
      host,
      'req-type'
    )

    assert.strictEqual(request.callCount, 1)
  })
})
