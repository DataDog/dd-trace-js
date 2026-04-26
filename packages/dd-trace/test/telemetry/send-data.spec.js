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
        'dd-client-library-language': application.language_name,
        'dd-client-library-version': application.tracer_version,
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
        'dd-client-library-language': application.language_name,
        'dd-client-library-version': application.tracer_version,
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
      telemetry: { debug: true },
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
        DD_CIVISIBILITY_AGENTLESS_ENABLED: true,
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
})
