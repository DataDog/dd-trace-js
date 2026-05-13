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
    // Chain proxyquire so log.error calls from filter.js are also captured.
    const filterModule = proxyquire('../src/filter', {
      '../../dd-trace/src/log': log,
    })
    plugins = proxyquire('../src/producer', {
      '../../dd-trace/src/log': log,
      './filter': filterModule,
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

  it('passes a user-supplied producerFilter through configure()', () => {
    const [QueueAddPlugin] = plugins
    const baseProto = Object.getPrototypeOf(QueueAddPlugin.prototype)
    const parentProto = Object.getPrototypeOf(baseProto)
    const superConfigure = sinon.stub(parentProto, 'configure')

    try {
      const userFilter = () => false
      const instance = Object.create(QueueAddPlugin.prototype)
      instance.configure({ producerFilter: userFilter })

      const passed = superConfigure.firstCall.args[0]
      assert.strictEqual(passed.producerFilter, userFilter)
      sinon.assert.notCalled(log.error)
    } finally {
      superConfigure.restore()
    }
  })

  it('logs an error and uses the default filter when producerFilter is not a function', () => {
    const [QueueAddPlugin] = plugins
    const baseProto = Object.getPrototypeOf(QueueAddPlugin.prototype)
    const parentProto = Object.getPrototypeOf(baseProto)
    const superConfigure = sinon.stub(parentProto, 'configure')

    try {
      const instance = Object.create(QueueAddPlugin.prototype)
      instance.configure({ producerFilter: 'not-a-function' })

      sinon.assert.calledOnce(log.error)
      assert.match(log.error.firstCall.args[0], /Expected `producerFilter` to be a function/)
      const passed = superConfigure.firstCall.args[0]
      assert.strictEqual(typeof passed.producerFilter, 'function')
      assert.strictEqual(passed.producerFilter(), true)
    } finally {
      superConfigure.restore()
    }
  })

  it('skips Queue.add producer instrumentation when producerFilter rejects the job', () => {
    const instance = buildPluginInstance()
    const producerFilter = sinon.stub().returns(false)
    const ctx = { arguments: ['skip', { id: 1 }, { attempts: 1 }] }

    instance.config = { producerFilter }

    assert.deepStrictEqual(instance.bindStart(ctx), { noop: true })
    sinon.assert.calledOnceWithExactly(producerFilter, {
      name: 'skip', data: { id: 1 }, opts: { attempts: 1 }, queueName: undefined,
    })
    sinon.assert.notCalled(instance.tracer.inject)
  })

  it('instruments anyway and logs when Queue.add producerFilter throws', () => {
    const [QueueAddPlugin] = plugins
    const tracer = {
      inject: sinon.stub().callsFake((span, format, carrier) => {
        carrier['x-datadog-trace-id'] = '1'
      }),
    }
    const instance = new QueueAddPlugin(tracer, {})
    const producerFilter = sinon.stub().throws(new Error('bad filter'))
    const ctx = { arguments: ['job', { id: 1 }] }

    instance.config = { producerFilter }
    instance.startSpan = sinon.stub().callsFake((options, ctx) => {
      ctx.currentStore = { span: {} }
      return ctx.currentStore.span
    })

    assert.deepStrictEqual(instance.bindStart(ctx), ctx.currentStore)
    sinon.assert.calledOnce(log.error)
    assert.match(log.error.firstCall.args[0], /filtering is disabled/)
    sinon.assert.calledOnce(instance.startSpan)
  })

  it('instruments all jobs and logs when Queue.addBulk producerFilter throws', () => {
    const [, QueueAddBulkPlugin] = plugins
    const tracer = {
      inject: sinon.stub().callsFake((span, format, carrier) => {
        carrier['x-datadog-trace-id'] = '1'
      }),
    }
    const instance = new QueueAddBulkPlugin(tracer, {})
    const producerFilter = sinon.stub().throws(new Error('boom'))
    const job1 = { name: 'a', data: { id: 1 }, opts: {} }
    const job2 = { name: 'b', data: { id: 2 }, opts: {} }
    const ctx = {
      self: { name: 'q' },
      arguments: [[job1, job2]],
    }

    instance.config = { producerFilter }
    instance.startSpan = sinon.stub().callsFake((options, ctx) => {
      ctx.currentStore = { span: {} }
      return ctx.currentStore.span
    })

    assert.deepStrictEqual(instance.bindStart(ctx), ctx.currentStore)
    sinon.assert.calledOnce(log.error)
    assert.match(log.error.firstCall.args[0], /filtering is disabled/)
    sinon.assert.calledOnce(instance.startSpan)
    // Both jobs are instrumented since filter is broken
    assert.strictEqual(instance.startSpan.firstCall.args[0].meta['messaging.batch.message_count'], 2)
    assert.ok(job1.opts.telemetry)
    assert.ok(job2.opts.telemetry)
  })

  it('only handles Queue.addBulk jobs allowed by producerFilter', () => {
    const [, QueueAddBulkPlugin] = plugins
    const tracer = {
      inject: sinon.stub().callsFake((span, format, carrier) => {
        carrier['x-datadog-trace-id'] = '1'
      }),
    }
    const instance = new QueueAddBulkPlugin(tracer, {})
    const firstJob = { name: 'skip', data: { id: 1 }, opts: {} }
    const secondJob = { name: 'keep', data: { id: 2 }, opts: {} }
    const producerFilter = sinon.stub().callsFake(({ name }) => name !== 'skip')
    const ctx = {
      self: { name: 'test-queue' },
      arguments: [[firstJob, secondJob]],
    }

    instance.config = { producerFilter }
    instance.startSpan = sinon.stub().callsFake((options, ctx) => {
      ctx.currentStore = { span: {} }
      return ctx.currentStore.span
    })

    assert.deepStrictEqual(instance.bindStart(ctx), ctx.currentStore)

    assert.strictEqual(firstJob.opts.telemetry, undefined)
    assert.deepStrictEqual(JSON.parse(secondJob.opts.telemetry.metadata), {
      _datadog: { 'x-datadog-trace-id': '1' },
    })
    sinon.assert.calledWithExactly(producerFilter.firstCall, {
      name: 'skip', data: { id: 1 }, opts: firstJob.opts, queueName: 'test-queue',
    })
    sinon.assert.calledWithExactly(producerFilter.secondCall, {
      name: 'keep', data: { id: 2 }, opts: secondJob.opts, queueName: 'test-queue',
    })
    sinon.assert.calledTwice(producerFilter)
    assert.strictEqual(instance.startSpan.firstCall.args[0].meta['messaging.batch.message_count'], 1)
  })
})
