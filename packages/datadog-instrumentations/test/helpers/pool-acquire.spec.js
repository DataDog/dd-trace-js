'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { performance } = require('node:perf_hooks')

const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

const {
  dispatchesAcquireSynchronously,
  isPoolQueryAcquire,
  takePoolWaitTime,
  wrapPoolAcquireCarrier,
  wrapPoolClusterGetConnection,
  wrapPoolClusterMethod,
  wrapPoolClusterQueryMethod,
  wrapPoolGetConnection,
  wrapPoolQueryMethod,
} = require('../../src/helpers/pool-acquire')

const inactiveChannel = { hasSubscribers: false }
const inactiveChannels = {
  connectionStartCh: inactiveChannel,
  connectionFinishCh: inactiveChannel,
  acquireStartCh: inactiveChannel,
  acquireFinishCh: inactiveChannel,
}

describe('helpers/pool-acquire', () => {
  afterEach(() => sinon.restore())

  describe('acquire dispatch detection', () => {
    it('distinguishes synchronous, deferred, async, and unprobeable methods', async () => {
      assert.strictEqual(dispatchesAcquireSynchronously(function () {
        this.getConnection()
      }, {}, 'getConnection', []), true)

      assert.strictEqual(dispatchesAcquireSynchronously(function () {
        setImmediate(() => this.getConnection())
      }, {}, 'getConnection', []), false)

      let advanced = false
      assert.strictEqual(dispatchesAcquireSynchronously(async function () {
        await this.getConnection()
        advanced = true
      }, {}, 'getConnection', []), false)
      assert.strictEqual(dispatchesAcquireSynchronously(() => {
        throw new Error('unsupported receiver')
      }, {}, 'getConnection', []), false)

      await waitImmediates(2)
      assert.strictEqual(advanced, false)
    })
  })

  describe('subscriber-off fast paths', () => {
    it('forwards every wrapper without changing the call', () => {
      const wrappers = [
        method => wrapPoolQueryMethod(method, inactiveChannel),
        method => wrapPoolQueryMethod(method, inactiveChannel, true),
        method => wrapPoolAcquireCarrier(noop, method, inactiveChannel, true),
        method => wrapPoolClusterQueryMethod(method, inactiveChannels),
        method => wrapPoolClusterMethod(method, inactiveChannel),
        method => wrapPoolClusterGetConnection(method, inactiveChannels),
        method => wrapPoolGetConnection(method, inactiveChannels),
        method => wrapPoolGetConnection(method, inactiveChannels, true),
      ]

      for (const wrap of wrappers) assertInactiveFastPath(wrap)
    })
  })

  it('preserves the getConnection callback contract and reports internal errors', () => {
    const callbackReceiver = {}
    const connection = {}
    const error = new Error('acquire failed')
    const thirdArgument = {}
    const now = sinon.stub(performance, 'now')
    now.onFirstCall().returns(100)
    now.onSecondCall().returns(125)

    for (const [expectedArguments, internal, reportsError] of [
      [[error], false, false],
      [[undefined, connection, thirdArgument], false, false],
      [[], true, false],
      [[error, undefined, thirdArgument], true, true],
    ]) {
      const expectedReturn = {}
      const contexts = []
      const channels = activeChannels()
      if (reportsError) {
        channels.acquireStartCh = {
          hasSubscribers: true,
          publish: ctx => contexts.push(ctx),
        }
        channels.acquireFinishCh = { publish: ctx => contexts.push(ctx) }
      }
      const wrapped = wrapPoolGetConnection(function (callback) {
        return callback.apply(callbackReceiver, expectedArguments)
      }, channels)

      const pool = {
        config: { connectionConfig: {} },
        _freeConnections: reportsError ? [] : [{}],
      }
      const invoke = () => wrapped.call(pool, function () {
        assert.strictEqual(this, callbackReceiver)
        assert.strictEqual(arguments.length, expectedArguments.length)
        for (let i = 0; i < arguments.length; i++) {
          assert.strictEqual(arguments[i], expectedArguments[i])
        }
        return expectedReturn
      })
      const query = internal ? wrapPoolQueryMethod(invoke, channels.connectionStartCh) : invoke
      const actualReturn = query()

      assert.strictEqual(actualReturn, expectedReturn)
      assert.strictEqual(contexts.length, reportsError ? 2 : 0)
      if (reportsError) {
        assert.strictEqual(contexts[0], contexts[1])
        assert.strictEqual(contexts[0].error, error)
        assert.strictEqual(contexts[0].poolWaitTime, 25)
        assert.strictEqual(contexts[0].startTime, performance.timeOrigin + 100)
      }
    }
  })

  it('does not finish an explicit acquire twice when its callback throws', () => {
    const failure = new Error('callback failed')
    const channels = activeChannels()
    channels.acquireStartCh = { hasSubscribers: true, publish: noop }
    channels.acquireFinishCh = { publish: sinon.stub() }
    const pool = { config: { connectionConfig: {} } }
    const getConnection = wrapPoolGetConnection(callback => callback(), channels)

    assert.throws(() => getConnection.call(pool, () => { throw failure }), failure)
    sinon.assert.calledOnce(channels.acquireFinishCh.publish)
    assert.strictEqual(channels.acquireFinishCh.publish.firstCall.args[0].error, undefined)
  })

  it('does not retain cluster state in unrelated acquires or final callbacks', () => {
    const error = new Error('acquire failed')
    const callbackReceiver = {}
    const thirdArgument = {}
    const expectedReturn = {}
    const channels = activeChannels()
    let acquireStarts = 0
    channels.acquireStartCh = {
      hasSubscribers: true,
      publish: () => { acquireStarts++ },
    }
    channels.acquireFinishCh = { publish: noop }
    const pool = { config: { connectionConfig: {} } }
    const fallbackPool = { config: { connectionConfig: {} } }
    const poolGetConnection = wrapPoolGetConnection(function (callback) {
      return callback(error)
    }, channels)
    const fallbackGetConnection = wrapPoolGetConnection(callback => callback(undefined, {}), channels)
    let insideNestedAcquire = false

    /**
     * @param {Function} callback
     * @returns {unknown}
     */
    function getConnection (callback) {
      return poolGetConnection.call(pool, function (error) {
        if (insideNestedAcquire) return callback(error)

        insideNestedAcquire = true
        retryingNamespaceGetConnection(() => {})
        return fallbackGetConnection.call(fallbackPool, noop)
      })
    }
    const retryingNamespaceGetConnection = wrapPoolClusterGetConnection(getConnection, channels)
    const query = wrapPoolClusterMethod(
      () => retryingNamespaceGetConnection(() => {}),
      channels.connectionStartCh
    )

    query()

    assert.strictEqual(acquireStarts, 2)

    const finalNamespaceGetConnection = wrapPoolClusterGetConnection(function (callback) {
      return callback.call(callbackReceiver, error, undefined, thirdArgument)
    }, channels)
    const finalQuery = wrapPoolClusterMethod(() => {
      return finalNamespaceGetConnection(function () {
        assert.strictEqual(this, callbackReceiver)
        assert.strictEqual(arguments.length, 3)
        assert.strictEqual(arguments[0], error)
        assert.strictEqual(arguments[2], thirdArgument)
        fallbackGetConnection.call(fallbackPool, noop)
        return expectedReturn
      })
    }, channels.connectionStartCh)

    assert.strictEqual(finalQuery(), expectedReturn)

    assert.strictEqual(acquireStarts, 4)
  })

  it('keeps concurrent mysql2 cluster query acquires isolated', async () => {
    const now = sinon.stub(performance, 'now')
    now.onCall(0).returns(100)
    now.onCall(1).returns(200)
    now.onCall(2).returns(250)
    now.onCall(3).returns(700)

    const firstConnection = {}
    const secondConnection = {}
    const channels = activeChannels()
    const pool = { config: { connectionConfig: {} } }
    const physicalCallbacks = []
    const poolGetConnection = wrapPoolGetConnection(function (callback) {
      physicalCallbacks.push(callback)
    }, channels)

    /**
     * @param {Function} callback
     */
    function getConnection (callback) {
      poolGetConnection.call(pool, function (error, connection) {
        if (error) return setImmediate(namespaceGetConnection, callback)
        callback(undefined, connection)
      })
    }
    const namespaceGetConnection = wrapPoolClusterGetConnection(getConnection, channels)
    const query = wrapPoolClusterMethod(
      callback => namespaceGetConnection(callback),
      channels.connectionStartCh
    )
    const waits = []
    const first = new Promise(resolve => {
      query((error, connection) => {
        assert.strictEqual(error, undefined)
        waits[0] = takePoolWaitTime(connection)
        resolve()
      })
    })
    const second = new Promise(resolve => {
      query((error, connection) => {
        assert.strictEqual(error, undefined)
        waits[1] = takePoolWaitTime(connection)
        resolve()
      })
    })

    physicalCallbacks[1](undefined, secondConnection)
    physicalCallbacks[0](new Error('acquire failed'))
    await waitImmediates(1)
    physicalCallbacks[2](undefined, firstConnection)
    await Promise.all([first, second])

    assert.deepStrictEqual(waits, [600, 50])
  })

  it('does not report a query execution error as a cluster acquire error', () => {
    const channels = activeChannels()
    let acquireStarts = 0
    channels.acquireStartCh = {
      hasSubscribers: true,
      publish: () => { acquireStarts++ },
    }
    channels.acquireFinishCh = { publish: noop }
    for (const usesCallback of [true, false]) {
      const pool = { config: { connectionConfig: {} } }
      let physicalCallback
      const poolGetConnection = wrapPoolGetConnection(callback => {
        physicalCallback = callback
      }, channels)
      const queryResult = new EventEmitter()
      queryResult.once('error', noop)
      if (usesCallback) queryResult._callback = noop
      const query = wrapPoolClusterQueryMethod(function () {
        poolGetConnection.call(pool, noop)
        return queryResult
      }, channels)

      query()
      physicalCallback(undefined, {})
      const error = new Error('invalid query')
      if (usesCallback) queryResult._callback(error)
      else queryResult.emit('error', error)
    }

    assert.strictEqual(acquireStarts, 0)
  })

  it('skips idle clock reads and transfers waits only when consumed', () => {
    const now = sinon.stub(performance, 'now')
    const channels = activeChannels()
    const connection = {}
    const pool = { config: { connectionConfig: {} }, _freeConnections: [connection] }
    let consumeWait = false
    let waitTime
    const getConnection = wrapPoolGetConnection(callback => callback(undefined, connection), channels)
    const query = wrapPoolQueryMethod(() => getConnection.call(pool, (error, connection) => {
      assert.strictEqual(error, undefined)
      if (consumeWait) waitTime = takePoolWaitTime(connection)
    }), channels.connectionStartCh)

    query()
    sinon.assert.notCalled(now)

    pool._freeConnections.length = 0
    now.returns(100)
    query()
    assert.strictEqual(typeof takePoolWaitTime(connection), 'number')
    query()
    consumeWait = true
    query()

    assert.strictEqual(typeof waitTime, 'number')
  })

  it('classifies only the deferred pool query acquire as internal', async () => {
    const connection = {}
    const connectionStartCh = { hasSubscribers: true, publish: noop }
    let acquireStarts = 0
    const pool = { config: { connectionConfig: {} } }
    const getConnection = wrapPoolGetConnection(function (callback) {
      return callback(undefined, connection)
    }, {
      connectionStartCh,
      connectionFinishCh: { runStores },
      acquireStartCh: {
        hasSubscribers: true,
        publish: () => { acquireStarts++ },
      },
      acquireFinishCh: { publish: noop },
    }, true)
    let waitTime
    const query = wrapPoolQueryMethod(function () {
      setImmediate(() => {
        getConnection.call(this, () => {
          waitTime = takePoolWaitTime(connection)
          setImmediate(() => getConnection.call(this, noop))
        })
      })
    }, connectionStartCh, true)

    query.call(pool)
    await waitImmediates(2)

    assert.strictEqual(acquireStarts, 1)
    assert.strictEqual(typeof waitTime, 'number')
  })

  it('selects deferred carriers without retaining the context after the internal acquire', async () => {
    const channel = { hasSubscribers: true }
    const pool = {}
    let internalAcquires = 0
    const acquire = wrapPoolAcquireCarrier(
      () => {
        if (isPoolQueryAcquire()) internalAcquires++
      },
      () => {},
      channel,
      true
    )
    const query = wrapPoolQueryMethod(function () {
      setImmediate(() => {
        acquire.call(this, noop)
        acquire.call(this, noop)
      })
    }, channel, true)

    query.call(pool)
    await waitImmediates(1)

    assert.strictEqual(internalAcquires, 1)
  })
})

/**
 * @param {(method: Function) => Function} wrap
 * @returns {void}
 */
function assertInactiveFastPath (wrap) {
  const receiver = {}
  const firstArgument = {}
  const secondArgument = {}
  const expectedReturn = {}
  const wrapped = wrap(function () {
    assert.strictEqual(this, receiver)
    assert.strictEqual(arguments.length, 2)
    assert.strictEqual(arguments[0], firstArgument)
    assert.strictEqual(arguments[1], secondArgument)
    return expectedReturn
  })

  assert.strictEqual(wrapped.call(receiver, firstArgument, secondArgument), expectedReturn)
}

/**
 * @returns {void}
 */
function noop () {}

/**
 * @param {object} _ctx
 * @param {Function} callback
 * @param {unknown} thisArg
 * @param {...unknown} args
 * @returns {unknown}
 */
function runStores (_ctx, callback, thisArg, ...args) {
  return callback.apply(thisArg, args)
}

/**
 * @returns {object}
 */
function activeChannels () {
  return {
    connectionStartCh: { hasSubscribers: true, publish: noop },
    connectionFinishCh: { runStores },
    acquireStartCh: inactiveChannel,
    acquireFinishCh: inactiveChannel,
  }
}

/**
 * @param {number} count
 * @returns {Promise<void>}
 */
async function waitImmediates (count) {
  while (count-- > 0) await new Promise(resolve => setImmediate(resolve))
}
