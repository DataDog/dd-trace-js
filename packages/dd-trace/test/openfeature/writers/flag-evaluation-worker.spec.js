'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

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

  beforeEach(() => {
    clock = sinon.useFakeTimers()
    workers = []
    startupError = false
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
    Writer = proxyquire('../../../src/openfeature/writers/flag-evaluations', { 'node:worker_threads': { Worker } })
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
    assert.strictEqual(workers.length, 1)
    enqueue(17)
    const batches = () => workers[0].messages.filter(message => message.type === 'batch')
    assert.deepStrictEqual(batches().map(message => message.events.length), [8, 8])
    clock.tick(0)
    assert.deepStrictEqual(batches().map(message => message.events.length), [8, 8, 1])
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
    workers[0].postMessage = () => { throw new Error('post failure') }
    enqueue(8)
    assert.strictEqual(writer.hasCapacity(), false)
    writer.setEnabled(true)
    assert.strictEqual(workers.length, 1)
    assert.strictEqual(writer.enqueue({ flagKey: 'later', timestamp: 100 }), false)
    assert.strictEqual(dropped('worker_failure'), 8)
  })

  it('flushes partial work before close and forces a bounded drain', () => {
    writer.setEnabled(true)
    enqueue(1)
    const exit = sinon.spy()
    workers[0].on('exit', exit)
    writer.destroy()
    assert.deepStrictEqual(workers[0].messages.map(message => message.type), ['batch', 'close'])
    clock.tick(5000)
    sinon.assert.calledOnce(exit)
    assert.strictEqual(writer.hasCapacity(), false)
    assert.strictEqual(dropped('shutdown_timeout'), 1)
  })

  it('fails closed on startup errors and unsupported live route agents without restarting', () => {
    startupError = true
    writer.setEnabled(true)
    assert.strictEqual(writer.isAvailable(), false)
    startupError = false
    writer.setEnabled(true)
    assert.strictEqual(workers.length, 0)
    writer.destroy()
    writer = new Writer({ url: new URL('http://localhost:8126') })
    writer.setEnabled(true, { url: new URL('http://localhost:8126'), basePath: '', agent: {} })
    assert.strictEqual(writer.isAvailable(), false)
    assert.strictEqual(workers.length, 0)
  })

  it('accounts for aggregated observations even after worker input credits were released', () => {
    writer.setEnabled(true)
    enqueue(8)
    const state = new Int32Array(workers[0].options.workerData.state)
    Atomics.sub(state, 0, 8)
    workers[0].emit('error', new Error('worker failed after aggregation'))
    assert.strictEqual(writer.isAvailable(), false)
    assert.strictEqual(dropped('worker_failure'), 8)
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
})
