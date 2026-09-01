'use strict'

const assert = require('node:assert/strict')
const { URL } = require('node:url')

const { describe, it, beforeEach, afterEach } = require('mocha')
const sinon = require('sinon')
const proxyquire = require('proxyquire').noCallThru()

require('../../setup/core')

const { storage } = require('../../../../datadog-core')

describe('AgentlessWriter', () => {
  let AgentlessWriter
  let apiKey
  let createAgentlessExporter
  let encoder
  let encoderArgs
  let exporter
  let log
  let writer

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
    log = {
      debug: sinon.stub(),
      error: sinon.stub(),
    }
    const AgentEncoder = function (...args) {
      encoderArgs = args
      return encoder
    }

    AgentlessWriter = proxyquire('../../../src/exporters/agentless/writer', {
      '@datadog/libdatadog': { createAgentlessExporter },
      '../../../../../package.json': { version: 'tracer-version' },
      '../../config': () => ({
        DD_API_KEY: apiKey,
        env: 'test-env',
        service: 'test-service',
        version: 'test-version',
      }),
      '../../encode/0.4': { AgentEncoder },
      '../../log': log,
    })
  })

  afterEach(() => {
    sinon.restore()
  })

  it('uses the v0.4 encoder so dd-trace preprocessing is preserved', () => {
    writer = new AgentlessWriter({ metadata: { hostname: 'test-host' } })

    assert.strictEqual(encoderArgs[0], writer)
  })

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
    })
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
