'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

describe('bullmq producer telemetry metadata injection', () => {
  let log
  let plugins

  beforeEach(() => {
    log = { warn: sinon.stub(), error: sinon.stub() }
    plugins = proxyquire('../src/producer', {
      '../../dd-trace/src/log': log,
    })
  })

  function buildPluginInstance () {
    const [QueueAddPlugin] = plugins
    const tracer = {
      inject: sinon.stub().callsFake((span, format, carrier) => {
        carrier['x-datadog-trace-id'] = '1'
      }),
    }
    return Object.create(QueueAddPlugin.prototype, {
      tracer: { value: tracer },
    })
  }

  it('keeps publishing when telemetry.metadata is malformed JSON', () => {
    const instance = buildPluginInstance()
    const opts = { telemetry: { metadata: '{not json' } }

    instance._injectIntoOpts({}, opts)

    const result = JSON.parse(opts.telemetry.metadata)
    assert.deepStrictEqual(result._datadog, { 'x-datadog-trace-id': '1' })
    assert.strictEqual(opts.telemetry.omitContext, true)
    sinon.assert.calledOnce(log.warn)
    assert.match(log.warn.firstCall.args[0], /malformed telemetry\.metadata/)
  })

  it('preserves existing metadata when telemetry.metadata is well-formed JSON', () => {
    const instance = buildPluginInstance()
    const opts = { telemetry: { metadata: JSON.stringify({ keep: 'me' }) } }

    instance._injectIntoOpts({}, opts)

    const result = JSON.parse(opts.telemetry.metadata)
    assert.deepStrictEqual(result, {
      keep: 'me',
      _datadog: { 'x-datadog-trace-id': '1' },
    })
    sinon.assert.notCalled(log.warn)
  })
})
