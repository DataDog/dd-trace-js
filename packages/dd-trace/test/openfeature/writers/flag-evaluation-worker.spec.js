'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/core')
const telemetryMetrics = require('../../../src/telemetry/metrics')

function dropped (reason) {
  const series = telemetryMetrics.manager.namespace('general').toJSON().metrics?.series ?? []
  return series.find(metric => metric.metric === 'flagevaluation.rows.dropped' &&
    metric.tags.includes('reason:' + reason))?.points[0][1] ?? 0
}

describe('flag evaluation worker producer', () => {
  let clock
  let writer
  let workers
  let Writer
  let startupError
  let log

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    workers = []
    startupError = false
    log = { warn: sinon.spy(), debug: sinon.spy() }
    class Worker extends EventEmitter {
      constructor (path, options) {
        super()
        if (startupError) throw new Error('worker startup failed')
        this.options = options
        this.messages = []
        workers.push(this)
      }

      postMessage (message) { this.messages.push(structuredClone(message)) }
      unref () {}
      ref () {}
      terminate () { this.emit('exit', 1) }
    }
    Writer = proxyquire('../../../src/openfeature/writers/flag-evaluations', {
      'node:worker_threads': { Worker }, '../../log': log,
    })
    writer = new Writer({ url: new URL('http://localhost:8126'), service: 'test' })
  })

  afterEach(() => {
    writer.destroy()
    clock.runAll()
    clock.restore()
    telemetryMetrics.manager.namespace('general').reset()
  })

  function enqueue (count) {
    for (let i = 0; i < count; i++) {
      assert.strictEqual(writer.enqueue({ flagKey: 'flag', timestamp: 100, observeFullEvaluationData: false }), true)
    }
  }

  it('starts lazily and posts full batches synchronously with one deferred partial batch', () => {
    assert.strictEqual(workers.length, 0)
    writer.setEnabled(true)
    assert.strictEqual(workers.length, 0)
    enqueue(129)
    assert.strictEqual(workers.length, 1)
    const batches = () => workers[0].messages.filter(message => message.type === 'batch')
    assert.deepStrictEqual(batches().map(message => message.events.length), [64, 64])
    clock.tick(19)
    assert.deepStrictEqual(batches().map(message => message.events.length), [64, 64])
    clock.tick(1)
    assert.deepStrictEqual(batches().map(message => message.events.length), [64, 64, 1])
    assert.deepStrictEqual(workers[0].options.execArgv, [])
    assert.strictEqual(workers[0].options.env.NODE_OPTIONS, undefined)
  })

  it('counts local and posted observations together and accepts worker-released credit without messages', () => {
    writer.setEnabled(true)
    enqueue(4096)
    assert.strictEqual(writer.hasCapacity(), false)
    assert.strictEqual(writer.enqueue({ flagKey: 'overflow', timestamp: 100 }), false)
    const state = new Int32Array(workers[0].options.workerData.state)
    Atomics.sub(state, 0, 8)
    assert.strictEqual(writer.hasCapacity(), true)
    enqueue(8)
    assert.strictEqual(writer.hasCapacity(), false)
  })

  it('contains post failures and never restarts a failed writer', () => {
    writer.setEnabled(true)
    enqueue(1)
    writer.flush()
    workers[0].postMessage = () => { throw new Error('post failure') }
    enqueue(64)
    assert.strictEqual(writer.hasCapacity(), false)
    writer.setEnabled(true)
    assert.strictEqual(workers.length, 1)
    assert.strictEqual(writer.enqueue({ flagKey: 'later', timestamp: 100 }), false)
    assert.strictEqual(dropped('worker_failure'), 66)
    assert.strictEqual(dropped('unavailable'), 0)
  })

  it('flushes partial work before close and forces a bounded drain', () => {
    writer.setEnabled(true)
    enqueue(1)
    const exit = sinon.spy()
    writer.destroy()
    workers[0].on('exit', exit)
    assert.deepStrictEqual(workers[0].messages.map(message => message.type), ['batch', 'close'])
    clock.tick(5000)
    sinon.assert.calledOnce(exit)
    assert.strictEqual(writer.hasCapacity(), false)
    assert.strictEqual(dropped('shutdown_timeout'), 1)
  })

  it('fails closed on startup errors and unsupported live route agents without restarting', () => {
    startupError = true
    writer.setEnabled(true)
    enqueue(1)
    writer.flush()
    assert.strictEqual(writer.getUnavailableReason(), 'worker_failure')
    assert.strictEqual(dropped('worker_failure'), 1)
    startupError = false
    writer.setEnabled(true)
    assert.strictEqual(workers.length, 0)
    writer.destroy()
    writer = new Writer({ url: new URL('http://localhost:8126') })
    writer.setEnabled(true, { url: new URL('http://localhost:8126'), basePath: '', agent: {} })
    assert.strictEqual(writer.getUnavailableReason(), 'worker_failure')
    assert.strictEqual(workers.length, 0)
  })

  it('accounts for aggregated observations even after worker input credits were released', () => {
    writer.setEnabled(true)
    enqueue(64)
    const state = new Int32Array(workers[0].options.workerData.state)
    Atomics.sub(state, 0, 64)
    workers[0].emit('error', new Error('worker failed after aggregation'))
    assert.strictEqual(writer.getUnavailableReason(), 'worker_failure')
    assert.strictEqual(dropped('worker_failure'), 64)
  })

  it('does not start a worker or shutdown deadline without admitted work', () => {
    writer.setEnabled(true)
    writer.flush()
    writer.destroy()
    assert.strictEqual(workers.length, 0)
    assert.strictEqual(clock.countTimers(), 0)
  })

  it('uses the latest route at first use and discards a disabled partial batch without starting', () => {
    writer.setEnabled(true)
    enqueue(1)
    writer.setEnabled(false)
    clock.tick(0)
    assert.strictEqual(workers.length, 0)
    assert.strictEqual(dropped('unavailable'), 1)
    writer.setEnabled(true, { url: new URL('http://localhost:8127'), basePath: '/new-route' })
    enqueue(1)
    clock.tick(20)
    assert.strictEqual(workers.length, 1)
    assert.strictEqual(workers[0].options.workerData.route.url, 'http://localhost:8127/')
    assert.strictEqual(workers[0].options.workerData.route.basePath, '/new-route')
    assert.strictEqual(workers[0].messages[0].events.length, 1)
  })

  it('does not re-enable a writer after a failed route update', () => {
    writer.setEnabled(true)
    enqueue(1)
    writer.flush()
    workers[0].postMessage = () => { throw new Error('route update failed') }
    writer.setEnabled(true, { url: new URL('http://localhost:8127'), basePath: '' })
    assert.strictEqual(writer.getUnavailableReason(), 'worker_failure')
    assert.strictEqual(writer.hasCapacity(), false)
    assert.strictEqual(dropped('worker_failure'), 1)
  })

  it('collects worker metrics before the app-closing send and does not collect them twice', () => {
    writer.setEnabled(true)
    enqueue(64)
    const state = new Int32Array(workers[0].options.workerData.state)
    const telemetry = proxyquire('../../../src/openfeature/writers/flag-evaluation-telemetry', {})
    telemetry.configureWorkerTelemetry(state)
    Atomics.sub(state, 0, 1)
    telemetry.recordDropped('serialization_error')
    assert.strictEqual(dropped('serialization_error'), 0)
    // telemetry.appClosing publishes this channel immediately before sending/resetting metrics.
    channel('datadog:telemetry:app-closing').publish()
    assert.strictEqual(dropped('serialization_error'), 1)
    telemetryMetrics.manager.namespace('general').reset()
    writer.destroy()
    assert.strictEqual(dropped('serialization_error'), 0)
  })

  it('never reads protected attrs and posts only normalized scalar fields', () => {
    writer.setEnabled(true)
    writer.enqueue({
      flagKey: 'flag',
      timestamp: 100,
      observeFullEvaluationData: false,
      targetingKey: { toString () { throw new Error('must not coerce') } },
      errorCode: { secret: 'raw-error-canary' },
      get attrs () { throw new Error('must not touch protected context') },
    })
    writer.flush()
    const [event] = workers[0].messages[0].events
    assert.strictEqual(event.targetingKey, undefined)
    assert.strictEqual(event.errorCode, 'GENERAL')
    assert.strictEqual(event.attrs, undefined)
    assert.strictEqual(JSON.stringify(workers[0].messages).includes('raw-error-canary'), false)
  })

  for (const [code, reason] of [['MODULE_NOT_FOUND', 'missing_module'], ['PII-code-canary', 'worker_error']]) {
    it(`warns once with bounded ${reason} diagnostics and no raw error details`, () => {
      writer.setEnabled(true)
      enqueue(64)
      const worker = workers[0]
      worker.emit('error', Object.assign(new Error('PII-message-canary'), { code }))
      worker.emit('error', new Error('PII-second-canary'))
      sinon.assert.calledOnceWithExactly(log.warn,
        'Flag evaluation counts disabled after worker failure (%s)', reason)
      assert.strictEqual(JSON.stringify(log.warn.args).includes('PII-'), false)
      assert.strictEqual(writer.hasCapacity(), false)
      assert.strictEqual(dropped('worker_failure'), 64)
    })
  }

  it('bounds consented snapshots in mixed batches and flushes a sparse event after 20 ms', () => {
    writer.setEnabled(true)
    const consented = () => writer.enqueue({
      flagKey: 'flag', timestamp: 100, observeFullEvaluationData: true, attrs: { user: 'consented' },
    })
    for (let i = 0; i < 7; i++) assert.strictEqual(consented(), true)
    enqueue(56)
    assert.strictEqual(workers.length, 0)
    assert.strictEqual(consented(), true)
    const batches = () => workers[0].messages.filter(message => message.type === 'batch')
    assert.strictEqual(batches()[0].events.length, 64)
    assert.strictEqual(batches()[0].events.filter(event => event.observeFullEvaluationData).length, 8)
    for (let i = 0; i < 8; i++) assert.strictEqual(consented(), true)
    assert.strictEqual(batches()[1].events.length, 8)
    enqueue(1)
    clock.tick(19)
    assert.strictEqual(batches().length, 2)
    clock.tick(1)
    assert.strictEqual(batches()[2].events.length, 1)
    assert.ok(batches().every(batch => batch.events.length <= 64 &&
      batch.events.filter(event => event.observeFullEvaluationData).length <= 8))
  })
})
