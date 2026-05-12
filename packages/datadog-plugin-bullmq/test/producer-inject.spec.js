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

  it('skips Queue.add producer instrumentation when the filter rejects the job', () => {
    const instance = buildPluginInstance()
    const filter = sinon.stub().returns(false)
    const ctx = { arguments: ['skip', { id: 1 }, { attempts: 1 }] }

    instance.config = { filter }

    assert.deepStrictEqual(instance.bindStart(ctx), { noop: true })
    sinon.assert.calledOnceWithExactly(filter, {
      name: 'skip', data: { id: 1 }, opts: { attempts: 1 }, queueName: undefined,
    })
    sinon.assert.notCalled(instance.tracer.inject)
  })

  it('logs an error and uses the default filter when filter is not a function', () => {
    const [QueueAddPlugin] = plugins
    const baseBullmqProto = Object.getPrototypeOf(QueueAddPlugin.prototype)
    const parentProto = Object.getPrototypeOf(baseBullmqProto)
    const superConfigure = sinon.stub(parentProto, 'configure')

    try {
      const instance = Object.create(QueueAddPlugin.prototype)
      instance.configure({ filter: 'not-a-function' })

      sinon.assert.calledOnce(log.error)
      assert.match(log.error.firstCall.args[0], /Expected `filter` to be a function/)
      const passedConfig = superConfigure.firstCall.args[0]
      assert.strictEqual(typeof passedConfig.filter, 'function')
      assert.strictEqual(passedConfig.filter(), true)
    } finally {
      superConfigure.restore()
    }
  })

  it('only handles Queue.addBulk jobs allowed by the filter', () => {
    const [, QueueAddBulkPlugin] = plugins
    const tracer = {
      inject: sinon.stub().callsFake((span, format, carrier) => {
        carrier['x-datadog-trace-id'] = '1'
      }),
    }
    const instance = new QueueAddBulkPlugin(tracer, {})
    const firstJob = { name: 'skip', data: { id: 1 }, opts: {} }
    const secondJob = { name: 'keep', data: { id: 2 }, opts: {} }
    const filter = sinon.stub().callsFake(({ name }) => name !== 'skip')
    const ctx = {
      self: { name: 'test-queue' },
      arguments: [[firstJob, secondJob]],
    }

    instance.config = { filter }
    instance.startSpan = sinon.stub().callsFake((options, ctx) => {
      ctx.currentStore = { span: {} }
      return ctx.currentStore.span
    })

    assert.deepStrictEqual(instance.bindStart(ctx), ctx.currentStore)

    assert.strictEqual(firstJob.opts.telemetry, undefined)
    assert.deepStrictEqual(JSON.parse(secondJob.opts.telemetry.metadata), {
      _datadog: { 'x-datadog-trace-id': '1' },
    })
    sinon.assert.calledWithExactly(filter.firstCall, {
      name: 'skip', data: { id: 1 }, opts: firstJob.opts, queueName: 'test-queue',
    })
    sinon.assert.calledWithExactly(filter.secondCall, {
      name: 'keep', data: { id: 2 }, opts: secondJob.opts, queueName: 'test-queue',
    })
    sinon.assert.calledTwice(filter)
    assert.strictEqual(instance.startSpan.firstCall.args[0].meta['messaging.batch.message_count'], 1)
  })
})
