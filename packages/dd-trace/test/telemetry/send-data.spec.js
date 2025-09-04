'use strict'

const { expect } = require('chai')
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

    expect(request).to.have.been.calledOnce
    const options = request.getCall(0).args[1]

    expect(options).to.deep.equal({
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

    expect(request).to.have.been.calledOnce
    const options = request.getCall(0).args[1]

    expect(options).to.deep.equal({
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

    expect(request).to.have.been.calledOnce
    const options = request.getCall(0).args[1]

    expect(options).to.deep.equal({
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

    expect(request).to.have.been.calledOnce
    const data = JSON.parse(request.getCall(0).args[0])

    const { logger, tags, serviceMapping, ...trimmedPayload } = payload
    expect(data.payload).to.deep.equal(trimmedPayload)
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

    expect(request).to.have.been.calledOnce

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
    expect(data.request_type).to.equal('message-batch')
    expect(data.payload).to.deep.equal(expectedPayload)
  })

  it('should also work in CI Visibility agentless mode', () => {
    process.env.DD_CIVISIBILITY_AGENTLESS_ENABLED = '1'

    sendDataModule.sendData(
      {
        isCiVisibility: true,
        tags: { 'runtime-id': '123' },
        site: 'datadoghq.eu'
      },
      application,
      'test', 'req-type'
    )

    expect(request).to.have.been.calledOnce
    const options = request.getCall(0).args[1]
    expect(options).to.include({
      method: 'POST',
      path: '/api/v2/apmtelemetry'
    })
    const { url } = options
    expect(url).to.eql(new URL('https://instrumentation-telemetry-intake.datadoghq.eu'))
    delete process.env.DD_CIVISIBILITY_AGENTLESS_ENABLED
  })
})
