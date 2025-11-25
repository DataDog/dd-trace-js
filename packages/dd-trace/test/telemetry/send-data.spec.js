'use strict'

const assert = require('node:assert/strict')
const { assertObjectContains } = require('../../../../integration-tests/helpers')

const { describe, it, beforeEach } = require('tap').mocha
const sinon = require('sinon')
const proxyquire = require('proxyquire')

require('../setup/core')

describe('sendData', () => {
  const application = {
    language_name: 'nodejs',
    tracer_version: 'version'
  }

  let sendDataModule
  let request

  beforeEach(() => {
    request = sinon.stub()
    sendDataModule = proxyquire('../../src/telemetry/send-data', {
      '../exporters/common/request': request
    })
  })

  it('should call to request (TCP)', () => {
    sendDataModule.sendData({
      hostname: '',
      port: '12345',
      tags: { 'runtime-id': '123' }
    }, application, 'test', 'req-type')

    sinon.assert.calledOnce(request)
    const options = request.getCall(0).args[1]

    assert.deepStrictEqual(options, {
      method: 'POST',
      path: '/telemetry/proxy/api/v2/apmtelemetry',
      headers: {
        'content-type': 'application/json',
        'dd-telemetry-api-version': 'v2',
        'dd-telemetry-request-type': 'req-type',
        'dd-client-library-language': application.language_name,
        'dd-client-library-version': application.tracer_version
      },
      url: undefined,
      hostname: '',
      port: '12345'
    })
  })

  it('should call to request (UDP)', () => {
    sendDataModule.sendData({
      url: 'unix:/foo/bar/baz',
      tags: { 'runtime-id': '123' }
    }, application, 'test', 'req-type')

    sinon.assert.calledOnce(request)
    const options = request.getCall(0).args[1]

    assert.deepStrictEqual(options, {
      method: 'POST',
      path: '/telemetry/proxy/api/v2/apmtelemetry',
      headers: {
        'content-type': 'application/json',
        'dd-telemetry-api-version': 'v2',
        'dd-telemetry-request-type': 'req-type',
        'dd-client-library-language': application.language_name,
        'dd-client-library-version': application.tracer_version
      },
      url: 'unix:/foo/bar/baz',
      hostname: undefined,
      port: undefined
    })
  })

  it('should add debug header if DD_TELEMETRY_DEBUG is present', () => {
    sendDataModule.sendData({
      url: '/test',
      tags: { 'runtime-id': '123' },
      telemetry: { debug: true }
    }, application, 'test', 'req-type')

    sinon.assert.calledOnce(request)
    const options = request.getCall(0).args[1]

    assert.deepStrictEqual(options, {
      method: 'POST',
      path: '/telemetry/proxy/api/v2/apmtelemetry',
      headers: {
        'content-type': 'application/json',
        'dd-telemetry-api-version': 'v2',
        'dd-telemetry-request-type': 'req-type',
        'dd-telemetry-debug-enabled': 'true',
        'dd-client-library-language': application.language_name,
        'dd-client-library-version': application.tracer_version
      },
      url: '/test',
      hostname: undefined,
      port: undefined
    })
  })

  it('should remove not wanted properties from a payload with object type', () => {
    const payload = {
      message: 'test',
      logger: {},
      tags: {},
      serviceMapping: {}
    }
    sendDataModule.sendData({ tags: { 'runtime-id': '123' } }, 'test', 'test', 'req-type', payload)

    sinon.assert.calledOnce(request)
    const data = JSON.parse(request.getCall(0).args[0])

    const { logger, tags, serviceMapping, ...trimmedPayload } = payload
    assert.deepStrictEqual(data.payload, trimmedPayload)
  })

  it('should send batch request with retryPayload', () => {
    const retryObjData = { payload: { foo: 'bar' }, request_type: 'req-type-1' }
    const payload = [{
      request_type: 'req-type-2',
      payload: {
        integrations: [
          { name: 'foo2', enabled: true, auto_enabled: true },
          { name: 'bar2', enabled: false, auto_enabled: true }
        ]
      }

    }, retryObjData]

    sendDataModule.sendData({ tags: { 'runtime-id': '123' } },
      { language: 'js' }, 'test', 'message-batch', payload) /

    sinon.assert.calledOnce(request)

    const data = JSON.parse(request.getCall(0).args[0])
    const expectedPayload = [{
      request_type: 'req-type-2',
      payload: {
        integrations: [
          { name: 'foo2', enabled: true, auto_enabled: true },
          { name: 'bar2', enabled: false, auto_enabled: true }
        ]
      }
    }, {
      request_type: 'req-type-1',
      payload: { foo: 'bar' }
    }]
    assert.strictEqual(data.request_type, 'message-batch')
    assert.deepStrictEqual(data.payload, expectedPayload)
  })

  it('should also work in CI Visibility agentless mode', () => {
    process.env.DD_CIVISIBILITY_AGENTLESS_ENABLED = '1'
    // Reset ConfigEnvSources to pick up the DD_CIVISIBILITY_AGENTLESS_ENABLED
    const { resetConfigEnvSources } = require('../../src/config-env-sources')
    resetConfigEnvSources()

    sendDataModule.sendData(
      {
        isCiVisibility: true,
        tags: { 'runtime-id': '123' },
        site: 'datadoghq.eu'
      },
      application,
      'test', 'req-type'
    )

    sinon.assert.calledOnce(request)
    const options = request.getCall(0).args[1]
    assertObjectContains(options, {
      method: 'POST',
      path: '/api/v2/apmtelemetry'
    })
    const { url } = options
    assert.deepStrictEqual(url, new URL('https://instrumentation-telemetry-intake.datadoghq.eu'))
    delete process.env.DD_CIVISIBILITY_AGENTLESS_ENABLED
  })
})
