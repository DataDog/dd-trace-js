'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const https = require('node:https')

const { describe, it, afterEach, beforeEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')

const OtlpHttpExporterBase = require('../../../src/opentelemetry/otlp/otlp_http_exporter_base')
const { version: tracerVersion } = require('../../../../../package.json')
const serverless = require('../../../src/serverless')

function getOtlpHttpExporterBase (isMicroVm) {
  const request = sinon.stub()
  const loadBase = proxyquire.noPreserveCache()
  const OtlpHttpExporterBase = loadBase('../../../src/opentelemetry/otlp/otlp_http_exporter_base', {
    'node:http': { ...http, request },
    'node:https': { ...https, request },
    '../../serverless': { ...serverless, IS_AWS_LAMBDA_MICROVM: isMicroVm },
  })
  return { OtlpHttpExporterBase, request }
}

function makePendingRequest () {
  return {
    write: sinon.stub(),
    end: sinon.stub(),
    on: sinon.stub().returnsThis(),
    once: sinon.stub().returnsThis(),
    setTimeout: sinon.stub().returnsThis(),
    destroy: sinon.spy(),
  }
}

const proxyEnvironmentNames = [
  'ALL_PROXY',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'all_proxy',
  'https_proxy',
  'http_proxy',
  'no_proxy',
]

describe('OtlpHttpExporterBase', () => {
  let originalEnvironment

  beforeEach(() => {
    originalEnvironment = new Map()
    for (const name of proxyEnvironmentNames) {
      originalEnvironment.set(name, process.env[name])
      delete process.env[name]
    }
  })

  afterEach(() => {
    for (const [name, value] of originalEnvironment) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  })

  it('sends a User-Agent header identifying the tracer version', () => {
    const exporter = new OtlpHttpExporterBase('https://intake.example/path', undefined, 1000, 'http/protobuf', 'traces')

    assert.strictEqual(exporter.options.headers['User-Agent'], `dd-trace-js/${tracerVersion}`)
  })

  it('does not track requests outside MicroVM', () => {
    const { OtlpHttpExporterBase, request } = getOtlpHttpExporterBase(false)
    const pendingRequest = makePendingRequest()
    request.returns(pendingRequest)
    const exporter = new OtlpHttpExporterBase(
      'http://intake.example/path', undefined, 1000, 'http/protobuf', 'metrics'
    )
    const done = sinon.spy()

    exporter.sendPayload(Buffer.from('payload'), done)
    exporter.resetPendingState()

    assert.strictEqual(request.firstCall.args[0].signal, undefined)
    sinon.assert.notCalled(pendingRequest.destroy)
    sinon.assert.notCalled(done)
  })

  it('cancels a request if identity refresh happens before transport returns it', () => {
    const { OtlpHttpExporterBase, request } = getOtlpHttpExporterBase(true)
    const pendingRequest = makePendingRequest()
    let exporter
    request.callsFake(() => {
      exporter.resetPendingState()
      return pendingRequest
    })
    const done = sinon.spy()
    exporter = new OtlpHttpExporterBase(
      'http://intake.example/path', undefined, 1000, 'http/protobuf', 'metrics'
    )

    exporter.sendPayload(Buffer.from('payload'), done)

    sinon.assert.calledOnce(pendingRequest.destroy)
    sinon.assert.calledOnce(done)
    assert.strictEqual(done.firstCall.args[0].code, 1)
  })

  it('does not set an agent for an HTTPS endpoint when no proxy is configured', () => {
    const exporter = new OtlpHttpExporterBase('https://intake.example/path', undefined, 1000, 'http/protobuf', 'traces')

    assert.strictEqual(exporter.options.agent, undefined)
  })

  it('does not set an agent for an HTTP endpoint even when a proxy is configured', () => {
    process.env.https_proxy = 'http://127.0.0.1:9999'

    const exporter = new OtlpHttpExporterBase('http://intake.example/path', undefined, 1000, 'http/protobuf', 'traces')

    assert.strictEqual(exporter.options.agent, undefined)
  })

  it('routes an HTTPS endpoint through the configured proxy agent', () => {
    process.env.https_proxy = 'http://127.0.0.1:9999'

    const exporter = new OtlpHttpExporterBase('https://intake.example/path', undefined, 1000, 'http/protobuf', 'traces')

    assert.ok(exporter.options.agent)
    assert.strictEqual(exporter.options.agent.proxy.hostname, '127.0.0.1')
    assert.strictEqual(exporter.options.agent.proxy.port, '9999')
  })

  describe('setUrl', () => {
    it('picks up a proxy agent when re-targeted to an HTTPS endpoint', () => {
      const exporter = new OtlpHttpExporterBase(
        'http://intake.example/path', undefined, 1000, 'http/protobuf', 'traces'
      )
      assert.strictEqual(exporter.options.agent, undefined)

      process.env.https_proxy = 'http://127.0.0.1:9999'
      exporter.setUrl('https://intake.example/other-path')

      assert.ok(exporter.options.agent)
      assert.strictEqual(exporter.options.agent.proxy.hostname, '127.0.0.1')
      assert.strictEqual(exporter.options.agent.proxy.port, '9999')
    })

    it('clears the agent when re-targeted from HTTPS to HTTP', () => {
      process.env.https_proxy = 'http://127.0.0.1:9999'
      const exporter = new OtlpHttpExporterBase(
        'https://intake.example/path', undefined, 1000, 'http/protobuf', 'traces'
      )
      assert.ok(exporter.options.agent)

      exporter.setUrl('http://intake.example/other-path')

      assert.strictEqual(exporter.options.agent, undefined)
    })
  })
})
