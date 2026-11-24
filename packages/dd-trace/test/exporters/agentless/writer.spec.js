'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const https = require('node:https')
const { URL } = require('node:url')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()

require('../../setup/core')

const { storage } = require('../../../../datadog-core')
const request = require('../../../src/exporters/common/request')
const id = require('../../../src/id')

describe('AgentlessWriter', () => {
  let AgentlessWriter
  let apiKey
  let bindingCompress
  let createAgentlessExporter
  let encoder
  let encoderArgs
  let exporter
  let getHttpsProxyAgent
  let log
  let prepare
  let proxyAgent
  let writer
  let zlib

  beforeEach(() => {
    apiKey = 'test-api-key'
    encoder = {
      count: sinon.stub().returns(1),
      encode: sinon.stub(),
      makePayload: sinon.stub().returns(Buffer.from('v0.4 payload')),
      reset: sinon.stub(),
    }
    exporter = {
      close: sinon.stub(),
      sendV04: sinon.stub().callsArg(1),
    }
    createAgentlessExporter = sinon.stub().returns(exporter)
    prepare = sinon.stub().returns(Buffer.from('{}'))
    bindingCompress = sinon.stub().returns(Buffer.from('binding zstd'))
    zlib = {
      constants: { ZSTD_c_compressionLevel: 100 },
      zstdCompressSync: sinon.stub().returns(Buffer.from('host zstd')),
    }
    proxyAgent = {}
    getHttpsProxyAgent = sinon.stub().returns(proxyAgent)
    log = {
      debug: sinon.stub(),
      error: sinon.stub(),
      warn: sinon.stub(),
    }
    const AgentEncoder = function (...args) {
      encoderArgs = args
      return encoder
    }

    AgentlessWriter = proxyquire('../../../src/exporters/agentless/writer', {
      '@datadog/libdatadog': { createAgentlessExporter, zstd_compress: bindingCompress },
      'node:zlib': zlib,
      '../../../../../package.json': { version: 'tracer-version' },
      '../../config': () => ({
        DD_API_KEY: apiKey,
        env: 'test-env',
        service: 'test-service',
        version: 'test-version',
      }),
      '../../encode/0.4': { AgentEncoder },
      '../../log': log,
      './generated/agentless-policy.cjs': () => () => ({ prepare }),
      '../common/proxy': { getHttpsProxyAgent },
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  function queueDirectTrace () {
    writer = new AgentlessWriter({
      url: new URL('http://127.0.0.1:1'),
      metadata: { hostname: 'test-host', runtimeID: 'runtime-id' },
      generatedObfuscation: true,
    })
    assert.strictEqual(writer.append([{
      duration: 1,
      error: 0,
      meta: {},
      metrics: {},
      name: 'request',
      parent_id: id('0'),
      resource: 'GET /test',
      service: 'test-service',
      span_id: id('1'),
      start: 1,
      trace_id: id('1'),
      type: 'web',
    }]), true)
  }

  for (const [name, setFailure, expected] of [
    ['Node rejects the API key header', () => { apiKey = 'invalid\nheader' }, /dd-api-key/],
    ['a custom HTTP client throws a string',
      () => sinon.stub(http, 'request').throws(() => 'custom request failure'), /custom request failure/],
  ]) {
    it(`completes a direct flush when ${name}`, () => {
      setFailure()
      const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        queueDirectTrace()
        const done = sinon.spy()
        writer.flush(done)
        sinon.assert.calledOnce(done)
        sinon.assert.calledOnceWithExactly(log.error, 'Failed to send %d trace(s) to the agentless intake: %s', 1,
          sinon.match(expected))
        sinon.assert.notCalled(createAgentlessExporter)
        assert.strictEqual(clock.countTimers(), 0)
      } finally {
        writer.setUrl(undefined)
        clock.restore()
      }
    })
  }

  it('does not repeat direct completion when an over-budget flush callback throws', async () => {
    queueDirectTrace()
    const controller = new AbortController()
    const chunk = Buffer.alloc(1024 * 1024)
    const body = Array(64).fill(chunk)
    body[0] = chunk.subarray(1)
    const pressure = new Promise(resolve => {
      request(body, {
        url: new URL('http://127.0.0.1:1'),
        method: 'POST',
        retry: false,
        signal: controller.signal,
      }, resolve)
    })

    try {
      assert.strictEqual(request.writable, true)
      const done = sinon.stub().throws(new Error('completion failed'))
      writer.flush(done)
      sinon.assert.calledOnce(done)
      sinon.assert.notCalled(log.error)
      sinon.assert.notCalled(createAgentlessExporter)
    } finally {
      writer.setUrl(undefined)
      controller.abort()
      await pressure
    }
    assert.strictEqual(request.writable, true)
  })

  it('uses the v0.4 encoder so dd-trace preprocessing is preserved', () => {
    writer = new AgentlessWriter({ metadata: { hostname: 'test-host' } })

    assert.strictEqual(encoderArgs[0], writer)
  })

  for (const rejected of ['batch', 'guest']) {
    it(`does not send a batch when the generated policy rejects the ${rejected}`, async () => {
      const payload = Buffer.from('encoded v0.4 batch')
      encoder.makePayload.returns(payload)
      const send = sinon.spy(http, 'request')
      if (rejected === 'guest') {
        prepare.throws(new Error('policy trap'))
      } else {
        prepare.returns(undefined)
      }
      queueDirectTrace()

      await new Promise(resolve => writer.flush(resolve))
      await new Promise(resolve => writer.flush(resolve))

      sinon.assert.notCalled(send)
      sinon.assert.notCalled(createAgentlessExporter)
      assert.equal(prepare.callCount, 2)
      assert.strictEqual(prepare.firstCall.args[0], payload)
    })
  }

  it('uses the configured HTTPS proxy for a prepared payload', async () => {
    const proxyUrl = 'http://127.0.0.1:8514/'
    sinon.stub(process, 'env').value({ ...process.env, https_proxy: proxyUrl, no_proxy: '127.0.0.1' })
    const send = sinon.stub(https, 'request').throws(new Error('test request failure'))
    writer = new AgentlessWriter({ url: new URL('https://intake.example'), generatedObfuscation: true })

    await new Promise(resolve => writer.flush(resolve))
    await new Promise(resolve => writer.flush(resolve))
    process.env.no_proxy = 'intake.example'
    await new Promise(resolve => writer.flush(resolve))

    sinon.assert.notCalled(getHttpsProxyAgent)
    sinon.assert.calledThrice(send)
    const proxy = send.firstCall.args[0].agent
    assert.strictEqual(proxy.proxy.href, proxyUrl)
    assert.strictEqual(proxy.keepAlive, https.globalAgent.keepAlive)
    assert.strictEqual(proxy.maxSockets, https.globalAgent.maxSockets)
    assert.strictEqual(send.secondCall.args[0].agent, proxy)
    assert.strictEqual(send.thirdCall.args[0].agent, false)
    sinon.assert.notCalled(createAgentlessExporter)
  })

  for (const hostZstd of [true, false]) {
    it(`compresses with ${hostZstd ? 'Node zstd' : 'the binding when host zstd is absent'}`, async () => {
      const { zstdCompressSync } = zlib
      if (!hostZstd) zlib.zstdCompressSync = undefined
      const send = sinon.stub(http, 'request').throws(new Error('test request failure'))
      queueDirectTrace()

      await new Promise(resolve => writer.flush(resolve))

      sinon.assert.calledOnce(send)
      sinon.assert.notCalled(createAgentlessExporter)
      if (hostZstd) {
        sinon.assert.notCalled(bindingCompress)
        sinon.assert.calledOnceWithExactly(zstdCompressSync, Buffer.from('{}'), { params: { 100: 1 } })
      } else {
        sinon.assert.notCalled(zstdCompressSync)
        sinon.assert.calledOnceWithExactly(bindingCompress, Buffer.from('{}'), 1)
      }
    })
  }

  it('sends the v0.4 payload through the data pipeline', async () => {
    writer = new AgentlessWriter({
      url: new URL('https://intake.example/custom-path'),
      metadata: {
        env: 'test-env',
        hostname: 'test-host',
        runtimeID: 'runtime-id',
        containerId: 'container-id',
      },
    })

    await new Promise(resolve => writer.flush(resolve))

    sinon.assert.calledOnceWithExactly(exporter.sendV04, Buffer.from('v0.4 payload'), sinon.match.func, log)
    sinon.assert.calledOnceWithExactly(createAgentlessExporter, {
      endpoint: 'https://intake.example/api/v2/spans',
      apiKey: 'test-api-key',
      hostname: 'test-host',
      env: 'test-env',
      service: 'test-service',
      version: 'test-version',
      runtimeId: 'runtime-id',
      containerId: 'container-id',
      tracerVersion: 'tracer-version',
      languageVersion: process.version,
      languageInterpreter: 'v8',
    }, {
      agent: proxyAgent,
    })
    sinon.assert.calledOnceWithExactly(getHttpsProxyAgent, new URL('https://intake.example/custom-path'))
  })

  it('suppresses instrumentation of the data-pipeline intake request', async () => {
    /**
     * @param {Buffer} data
     * @param {() => void} done
     */
    exporter.sendV04.callsFake((data, done) => {
      assert.strictEqual(storage('legacy').getHandle()?.noop, true)
      done()
    })
    writer = new AgentlessWriter({ url: new URL('https://intake.example') })

    await new Promise(resolve => writer.flush(resolve))
  })

  it('waits for the data-pipeline completion callback', async () => {
    exporter.sendV04.resetBehavior()
    writer = new AgentlessWriter({ url: new URL('https://intake.example') })
    let flushed = false
    const flush = new Promise(resolve => writer.flush(() => {
      flushed = true
      resolve()
    }))

    assert.strictEqual(flushed, false)
    const done = exporter.sendV04.firstCall.args[1]
    done()
    await flush
    assert.strictEqual(flushed, true)
  })

  it('contains synchronous data-pipeline construction failures', async () => {
    const error = { toString: () => 'exporter unavailable' }
    createAgentlessExporter.callsFake(() => { throw error })
    writer = new AgentlessWriter({ url: new URL('https://intake.example') })

    await new Promise(resolve => writer.flush(resolve))

    sinon.assert.calledWithExactly(
      log.error,
      'Failed to send %d trace(s) to the agentless intake: %s',
      1,
      'exporter unavailable'
    )
  })

  it('contains proxy configuration failures before constructing the data pipeline', async () => {
    const error = new Error('invalid proxy URL')
    getHttpsProxyAgent.throws(error)
    writer = new AgentlessWriter({ url: new URL('https://intake.example') })

    await new Promise(resolve => writer.flush(resolve))

    sinon.assert.notCalled(createAgentlessExporter)
    sinon.assert.calledWithExactly(
      log.error,
      'Failed to send %d trace(s) to the agentless intake: %s',
      1,
      'invalid proxy URL'
    )
  })

  it('contains synchronous data-pipeline send failures', async () => {
    exporter.sendV04.throws(new Error('send failed'))
    writer = new AgentlessWriter({ url: new URL('https://intake.example') })

    await new Promise(resolve => writer.flush(resolve))

    sinon.assert.calledWithExactly(
      log.error,
      'Failed to send %d trace(s) to the agentless intake: %s',
      1,
      'send failed'
    )
  })

  it('does not give the API key to a non-loopback HTTP receiver', async () => {
    writer = new AgentlessWriter({ url: new URL('http://intake.example') })

    await new Promise(resolve => writer.flush(resolve))

    sinon.assert.notCalled(createAgentlessExporter)
    sinon.assert.notCalled(getHttpsProxyAgent)
    sinon.assert.notCalled(exporter.sendV04)
    sinon.assert.calledWithExactly(
      log.warn,
      'DD_API_KEY will not be sent because the configured receiver is neither HTTPS nor loopback.'
    )
  })

  it('keeps loopback HTTP receivers direct', async () => {
    writer = new AgentlessWriter({ url: new URL('http://127.0.0.1:8126') })

    await new Promise(resolve => writer.flush(resolve))

    sinon.assert.notCalled(getHttpsProxyAgent)
    assert.strictEqual(createAgentlessExporter.firstCall.args[1].agent, undefined)
  })

  it('reuses the pipeline exporter while its endpoint and API key are unchanged', async () => {
    writer = new AgentlessWriter({ url: new URL('https://intake.example') })

    await new Promise(resolve => writer.flush(resolve))
    await new Promise(resolve => writer.flush(resolve))

    sinon.assert.calledOnce(createAgentlessExporter)
    sinon.assert.calledTwice(exporter.sendV04)
  })

  it('recreates the pipeline exporter when the intake URL changes', async () => {
    writer = new AgentlessWriter({ url: new URL('https://intake.example') })

    await new Promise(resolve => writer.flush(resolve))
    writer.setUrl(new URL('https://other-intake.example'))
    await new Promise(resolve => writer.flush(resolve))

    sinon.assert.calledTwice(createAgentlessExporter)
    sinon.assert.calledOnce(exporter.close)
    assert.strictEqual(createAgentlessExporter.secondCall.args[0].endpoint,
      'https://other-intake.example/api/v2/spans')
  })

  it('recreates the pipeline exporter when the API key changes', async () => {
    writer = new AgentlessWriter({ url: new URL('https://intake.example') })

    await new Promise(resolve => writer.flush(resolve))
    apiKey = 'other-api-key'
    await new Promise(resolve => writer.flush(resolve))

    sinon.assert.calledTwice(createAgentlessExporter)
    sinon.assert.calledOnce(exporter.close)
    assert.strictEqual(createAgentlessExporter.secondCall.args[0].apiKey, 'other-api-key')
  })

  for (const [metadataName, optionName] of [
    ['env', 'env'],
    ['runtimeID', 'runtimeId'],
  ]) {
    it(`recreates the pipeline exporter when ${metadataName} changes`, async () => {
      const metadata = {
        env: 'old-value',
        runtimeID: 'old-value',
      }
      writer = new AgentlessWriter({
        url: new URL('https://intake.example'),
        metadata,
      })

      await new Promise(resolve => writer.flush(resolve))
      metadata[metadataName] = 'new-value'
      await new Promise(resolve => writer.flush(resolve))

      sinon.assert.calledTwice(createAgentlessExporter)
      sinon.assert.calledOnce(exporter.close)
      assert.strictEqual(createAgentlessExporter.secondCall.args[0][optionName], 'new-value')
    })
  }

  it('drops traces without constructing a pipeline exporter when the API key is unavailable', async () => {
    apiKey = undefined
    writer = new AgentlessWriter({ url: new URL('https://intake.example') })

    await new Promise(resolve => writer.flush(resolve))

    sinon.assert.notCalled(createAgentlessExporter)
    sinon.assert.notCalled(exporter.sendV04)
  })

  it('drops traces without constructing a pipeline exporter when the intake URL is unavailable', async () => {
    writer = new AgentlessWriter({ site: 'invalid site' })

    await new Promise(resolve => writer.flush(resolve))

    sinon.assert.notCalled(createAgentlessExporter)
    sinon.assert.notCalled(exporter.sendV04)
  })
})
