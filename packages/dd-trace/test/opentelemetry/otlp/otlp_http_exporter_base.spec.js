'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const http = require('node:http')
const { promisify } = require('node:util')
const { describe, it, afterEach, beforeEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')

const log = require('../../../src/log')
const OtlpHttpExporterBase = require('../../../src/opentelemetry/otlp/otlp_http_exporter_base')
const TelemetryDeliveryTracker = require('../../../src/serverless/telemetry-delivery-tracker')
const { version: tracerVersion } = require('../../../../../package.json')

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
    sinon.restore()
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

  it('retains log delivery when serverless tracking is available', async () => {
    const createServerlessDeliveryTracker = sinon.stub().returns(new TelemetryDeliveryTracker())
    const loadBase = proxyquire.noPreserveCache()
    const ServerlessBase = loadBase('../../../src/opentelemetry/otlp/otlp_http_exporter_base', {
      '../../serverless': { createServerlessDeliveryTracker },
    })
    const loadExporter = proxyquire.noPreserveCache()
    const ServerlessLogExporter = loadExporter('../../../src/opentelemetry/logs/otlp_http_log_exporter', {
      '../otlp/otlp_http_exporter_base': ServerlessBase,
    })
    const receiver = http.createServer()
    receiver.listen(0, '127.0.0.1')
    await once(receiver, 'listening')

    try {
      const { port } = receiver.address()
      const exporter = new ServerlessLogExporter(`http://127.0.0.1:${port}/v1/logs`, undefined, 1000, 'http/json', {})
      const requestReceived = once(receiver, 'request')
      exporter.sendPayload(Buffer.from('log'), () => {})
      let settled = false
      const flushExporter = promisify(exporter.flush.bind(exporter))
      const flush = flushExporter().then(() => { settled = true })
      const [request, response] = await requestReceived

      request.resume()
      sinon.assert.calledOnce(createServerlessDeliveryTracker)
      assert.strictEqual(settled, false)
      response.end()
      await flush
      assert.strictEqual(settled, true)
    } finally {
      const closed = once(receiver, 'close')
      receiver.close()
      await closed
    }
  })

  it('completes a log exporter flush without serverless tracking', () => {
    const createServerlessDeliveryTracker = sinon.stub().returns(undefined)
    const loadBase = proxyquire.noPreserveCache()
    const NormalBase = loadBase('../../../src/opentelemetry/otlp/otlp_http_exporter_base', {
      '../../serverless': { createServerlessDeliveryTracker },
    })
    const loadExporter = proxyquire.noPreserveCache()
    const NormalLogExporter = loadExporter('../../../src/opentelemetry/logs/otlp_http_log_exporter', {
      '../otlp/otlp_http_exporter_base': NormalBase,
    })
    const exporter = new NormalLogExporter('http://intake.example/v1/logs', undefined, 1000, 'http/json', {})
    const done = sinon.spy()

    exporter.flush(done)
    exporter.flush()

    sinon.assert.calledOnceWithExactly(createServerlessDeliveryTracker)
    sinon.assert.calledOnceWithExactly(done)
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

    for (const url of ['not a URL', 'ftp://intake.example/other-path']) {
      it(`keeps the current target when re-targeted to ${url}`, () => {
        const exporter = new OtlpHttpExporterBase(
          'http://intake.example/path', undefined, 1000, 'http/protobuf', 'traces'
        )
        const error = sinon.stub(log, 'error')

        exporter.setUrl(url)

        assert.strictEqual(exporter.options.hostname, 'intake.example')
        assert.strictEqual(exporter.options.port, '')
        assert.strictEqual(exporter.options.path, '/path')
        assert.strictEqual(exporter.options.agent, undefined)
        assert.strictEqual(exporter.telemetryTags[0], 'protocol:http')
        sinon.assert.calledOnce(error)
      })
    }

    it('keeps the current target when proxy configuration is invalid', () => {
      const exporter = new OtlpHttpExporterBase(
        'http://intake.example/path', undefined, 1000, 'http/protobuf', 'traces'
      )
      const error = sinon.stub(log, 'error')
      process.env.HTTPS_PROXY = '://invalid'

      exporter.setUrl('https://other.example/other-path')

      assert.strictEqual(exporter.options.hostname, 'intake.example')
      assert.strictEqual(exporter.options.path, '/path')
      assert.strictEqual(exporter.options.agent, undefined)
      assert.strictEqual(exporter.telemetryTags[0], 'protocol:http')
      sinon.assert.calledOnce(error)
    })
  })
})
