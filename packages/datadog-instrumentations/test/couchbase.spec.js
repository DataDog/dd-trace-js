'use strict'

const assert = require('node:assert/strict')
const EventEmitter = require('node:events')

const { tracingChannel } = require('dc-polyfill')
const { afterEach, before, describe, it } = require('mocha')

require('../src/couchbase')

const COUCHBASE_HOOKS = globalThis[Symbol.for('_ddtrace_instrumentations')].couchbase

const queryChannel = tracingChannel('apm:couchbase:query')
const upsertChannel = tracingChannel('apm:couchbase:upsert')

// Mirror of the SDK's `StreamablePromise` in v3.2.x / v4.0-v4.4: lazy
// internal Promise that only constructs on first `.then`. No depromisify
// override on `.on` — that surfaced later (v4.5.0+, JSCBC-1301). The
// orchestrator wrap relies on calling `.then(...)` synchronously to
// trigger the lazy listener attachment before libcouchbase emits.
class FakeStreamablePromise extends EventEmitter {
  #promise = null
  #promiseifyFn

  constructor (promiseifyFn) {
    super()
    this.#promiseifyFn = promiseifyFn
  }

  get promise () {
    this.#promise ??= new Promise((resolve, reject) => this.#promiseifyFn(this, resolve, reject))
    return this.#promise
  }

  then (onfulfilled, onrejected) { return this.promise.then(onfulfilled, onrejected) }
  catch (onrejected) { return this.promise.catch(onrejected) }
  finally (onfinally) { return this.promise.finally(onfinally) }
}

// Mirror of the SDK's `StreamablePromise` in v4.5.0+. Eager listener
// attachment via a proxy `emitter` that bypasses the `.on` override,
// plus the JSCBC-1301 depromisify behaviour: external `.on()` /
// `.addListener()` calls remove the SDK's internal listeners and null
// `_promise`. Subsequent `.then` / `.catch` / `.finally` then throw
// `Cannot await a promise that is already registered for events`. This
// is the v4.5.0+ contract: API must be either awaited or used with
// events, never both. The orchestrator wrap therefore must NEVER call
// `.on()` on the SDK's return value.
class FakeStreamablePromiseV45 extends EventEmitter {
  #promise = null
  #promiseOns = []
  #depromisified = false

  constructor (promiseifyFn) {
    super()
    const eeOn = EventEmitter.prototype.on
    this.#promise = new Promise((resolve, reject) => {
      const proxy = {
        on: (eventName, listener) => {
          this.#promiseOns.push([eventName, listener])
          eeOn.call(this, eventName, listener)
        },
      }
      promiseifyFn(proxy, resolve, reject)
    })
  }

  #depromisify () {
    for (const [eventName, listener] of this.#promiseOns) this.off(eventName, listener)
    this.#promiseOns = []
    this.#promise = null
    this.#depromisified = true
  }

  get promise () {
    if (this.#depromisified) {
      throw new Error('Cannot await a promise that is already registered for events')
    }
    return this.#promise
  }

  on (eventName, listener) {
    this.#depromisify()
    return super.on(eventName, listener)
  }

  addListener (eventName, listener) {
    this.#depromisify()
    return super.addListener(eventName, listener)
  }

  then (onfulfilled, onrejected) { return this.promise.then(onfulfilled, onrejected) }
  catch (onrejected) { return this.promise.catch(onrejected) }
  finally (onfinally) { return this.promise.finally(onfinally) }
}

function rowsPromiseifyFn (rowsToResultFn) {
  return (emitter, resolve, reject) => {
    let err
    const rows = []
    let meta
    emitter.on('row', r => rows.push(r))
    emitter.on('meta', m => { meta = m })
    emitter.on('error', e => { err = e })
    emitter.on('end', () => {
      if (err) return reject(err)
      resolve(rowsToResultFn(rows, meta))
    })
  }
}

class FakeStreamableRowPromise extends FakeStreamablePromise {
  constructor (rowsToResultFn) { super(rowsPromiseifyFn(rowsToResultFn)) }
}

class FakeStreamableRowPromiseV45 extends FakeStreamablePromiseV45 {
  constructor (rowsToResultFn) { super(rowsPromiseifyFn(rowsToResultFn)) }
}

/**
 * @param {string} file File suffix to match against the registered addHook entries.
 * @returns {(mod: unknown) => unknown}
 */
function findHook (file) {
  for (const entry of COUCHBASE_HOOKS) {
    if (entry.file === file) return entry.hook
  }
  throw new Error(`couchbase hook for ${file} not registered`)
}

const wrapClusterQuery = findHook('dist/cluster.js')
const wrapBucket = findHook('dist/bucket.js')
const wrapCollection = findHook('dist/collection.js')

function makeFakeSdk ({ emit }) {
  class FakeCluster {
    constructor () {
      this._connStr = 'couchbase://localhost'
    }

    query (statement) {
      const emitter = new FakeStreamableRowPromise(rows => ({ rows }))
      emit(emitter)
      return emitter
    }
  }

  class FakeCollection {
    constructor (bucket, name) {
      this._scope = { _bucket: { _name: bucket._name } }
      this._name = name
    }

    upsert (key, value, ...rest) { return this.#kv(emit, rest) }
    insert (key, value, ...rest) { return this.#kv(emit, rest) }
    replace (key, value, ...rest) { return this.#kv(emit, rest) }

    // Mirrors the real SDK's `PromiseHelper.wrapAsync(...)` (cluster.ts /
    // collection.ts on every traced op): when a callback is provided, it
    // synchronously calls `.then(...)` on the StreamablePromise to forward
    // resolve / reject to the callback. That `.then` is what triggers the
    // lazy listener attachment in `StreamablePromise.get promise` for v3.2.x
    // and v4.0-v4.4, so an `'error'` listener exists by the time
    // libcouchbase fires.
    #kv (emit, rest) {
      const callback = typeof rest.at(-1) === 'function' ? rest.at(-1) : undefined
      const emitter = new FakeStreamableRowPromise(rows => ({ rows }))
      emit(emitter)
      if (callback) {
        emitter.then(
          (result) => callback(undefined, result),
          (error) => callback(error, undefined)
        )
        setImmediate(() => emitter.emit('end'))
      }
      return emitter
    }
  }

  FakeCollection.DEFAULT_NAME = '_default'

  class FakeBucket {
    constructor (cluster, name) {
      this._cluster = cluster
      this._name = name
    }

    collection (name) { return new FakeCollection(this, name) }
  }

  wrapClusterQuery({ Cluster: FakeCluster })
  wrapBucket({ Bucket: FakeBucket })
  wrapCollection({ Collection: FakeCollection })

  const cluster = new FakeCluster()
  const bucket = new FakeBucket(cluster, 'datadog-test')
  const collection = bucket.collection('_default')
  return { cluster, bucket, collection }
}

describe('couchbase instrumentation: v3.2.x StreamableRowPromise', () => {
  /** @type {Array<() => void>} */
  const cleanups = []

  before(() => {
    assert.equal(Array.isArray(COUCHBASE_HOOKS), true, 'couchbase hooks must register on require')
  })

  afterEach(() => {
    while (cleanups.length) cleanups.pop()()
  })

  function subscribe (ch, names = ['start', 'asyncStart', 'asyncEnd', 'error', 'end']) {
    const events = []
    const handlers = {}
    for (const name of names) {
      handlers[name] = ctx => events.push({ name, ctx })
    }
    ch.subscribe(handlers)
    cleanups.push(() => ch.unsubscribe(handlers))
    return events
  }

  it('does not crash when libcouchbase emits "error" on the StreamableRowPromise asynchronously', async () => {
    const events = subscribe(queryChannel)
    let pendingEmitter
    const { cluster } = makeFakeSdk({ emit: e => { pendingEmitter = e } })

    const promise = cluster.query('SELECT 1+1')

    await new Promise(resolve => setImmediate(resolve))

    pendingEmitter.emit('error', new Error('libcouchbase: request canceled'))

    await new Promise(resolve => setImmediate(resolve))

    assert.equal(events.some(e => e.name === 'start'), true, 'start event must fire')
    assert.equal(typeof promise.on, 'function', 'wrap returns the original EventEmitter surface')
  })

  it('does not crash when the SDK emits "error" before any caller awaits the promise', async () => {
    subscribe(queryChannel)
    let pendingEmitter
    const { cluster } = makeFakeSdk({ emit: e => { pendingEmitter = e } })

    cluster.query('SELECT 1+1')

    await new Promise(resolve => setImmediate(resolve))

    pendingEmitter.emit('error', new Error('libcouchbase: request canceled'))

    await new Promise(resolve => setImmediate(resolve))
  })

  it('drives asyncStart/asyncEnd/error sub-channels for the promise path', async () => {
    const events = subscribe(queryChannel)
    let pendingEmitter
    const { cluster } = makeFakeSdk({ emit: e => { pendingEmitter = e } })

    const promise = cluster.query('SELECT 1+1').catch(() => {})

    pendingEmitter.emit('error', new Error('libcouchbase: query failed'))
    pendingEmitter.emit('end')

    await promise

    const eventNames = events.map(e => e.name)
    assert.deepEqual(eventNames, ['start', 'end', 'error', 'asyncStart', 'asyncEnd'])
    const errorEvent = events.find(e => e.name === 'error')
    assert.equal(errorEvent.ctx.error.message, 'libcouchbase: query failed')
  })

  it('drives asyncStart/asyncEnd on a successful resolution', async () => {
    const events = subscribe(queryChannel)
    let pendingEmitter
    const { cluster } = makeFakeSdk({ emit: e => { pendingEmitter = e } })

    const rows = [{ a: 1 }, { a: 2 }]
    const promise = cluster.query('SELECT *')

    for (const row of rows) pendingEmitter.emit('row', row)
    pendingEmitter.emit('end')

    const result = await promise

    assert.deepEqual(result, { rows })
    const eventNames = events.map(e => e.name)
    assert.deepEqual(eventNames, ['start', 'end', 'asyncStart', 'asyncEnd'])
  })

  it('publishes :error and rethrows when the wrapped operation throws synchronously', () => {
    const events = subscribe(queryChannel)

    class ThrowingCluster {
      constructor () { this._connStr = 'couchbase://localhost' }
      query () { throw new Error('libcouchbase: invalid argument') }
    }

    wrapClusterQuery({ Cluster: ThrowingCluster })
    const cluster = new ThrowingCluster()

    assert.throws(() => cluster.query('SELECT bad'), /invalid argument/)

    const eventNames = events.map(e => e.name)
    assert.deepEqual(eventNames, ['start', 'error', 'end'])
    const errorEvent = events.find(e => e.name === 'error')
    assert.equal(errorEvent.ctx.error.message, 'libcouchbase: invalid argument')
  })

  it('does not call .on() on the SDK return value (v4.5.0+ depromisify regression guard)', async () => {
    subscribe(queryChannel)
    let pendingEmitter

    class V45Cluster {
      constructor () { this._connStr = 'couchbase://localhost' }

      query (statement) {
        const emitter = new FakeStreamableRowPromiseV45(rows => ({ rows }))
        pendingEmitter = emitter
        return emitter
      }
    }

    wrapClusterQuery({ Cluster: V45Cluster })
    const cluster = new V45Cluster()

    const result = cluster.query('SELECT 1')

    setImmediate(() => pendingEmitter.emit('end'))

    // If the wrap calls `.on()` on the return value, JSCBC-1301
    // depromisifies and `await result` throws. The contract has been part
    // of the SDK since v4.5.0.
    await result
  })

  it('drives the callback path through traceCallback without losing the EE surface', async () => {
    const events = subscribe(upsertChannel)
    let pendingEmitter
    const { collection } = makeFakeSdk({ emit: e => { pendingEmitter = e } })

    const result = collection.upsert('k', 'v', () => {})

    assert.equal(typeof result.on, 'function', 'callback path must keep the EventEmitter surface')

    pendingEmitter.emit('error', new Error('libcouchbase: timeout'))

    await new Promise(resolve => setImmediate(resolve))

    const startEvent = events.find(e => e.name === 'start')
    assert.notEqual(startEvent, undefined, 'start must fire under the callback path')
  })
})
