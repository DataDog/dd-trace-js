'use strict'

const assert = require('node:assert/strict')
const { performance } = require('node:perf_hooks')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const {
  dispatchesAcquireSynchronously,
  takePoolWaitTime,
  wrapPoolAcquireCarrier,
  wrapPoolClusterGetConnection,
  wrapPoolClusterMethod,
  wrapPoolClusterQueryMethod,
  wrapPoolGetConnection,
  wrapPoolQueryCarrier,
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
  describe('acquire dispatch detection', () => {
    it('detects an acquire dispatched before the method returns', () => {
      const receiver = {}

      const synchronous = dispatchesAcquireSynchronously(function () {
        this.getConnection()
      }, receiver, 'getConnection', [])

      assert.strictEqual(synchronous, true)
    })

    it('detects an acquire deferred beyond the method return', async () => {
      const receiver = {}

      const synchronous = dispatchesAcquireSynchronously(function () {
        setImmediate(() => this.getConnection())
      }, receiver, 'getConnection', [])

      assert.strictEqual(synchronous, false)
      await new Promise(resolve => setImmediate(resolve))
    })

    it('uses the deferred path without executing an async method', async () => {
      let advanced = false

      const synchronous = dispatchesAcquireSynchronously(async function () {
        await this.getConnection()
        advanced = true
      }, {}, 'getConnection', [])

      assert.strictEqual(synchronous, false)
      await new Promise(resolve => setImmediate(resolve))
      assert.strictEqual(advanced, false)
    })

    it('uses the deferred path when the probe cannot execute the method', () => {
      const synchronous = dispatchesAcquireSynchronously(() => {
        throw new Error('unsupported receiver')
      }, {}, 'getConnection', [])

      assert.strictEqual(synchronous, false)
    })
  })

  describe('subscriber-off fast paths', () => {
    it('forwards an ordinary pool method unchanged', () => {
      assertInactiveFastPath(method => wrapPoolQueryMethod(method, inactiveChannel))
    })

    it('forwards a deferred pool query carrier unchanged', () => {
      assertInactiveFastPath(method => wrapPoolQueryCarrier(method, inactiveChannel, true))
    })

    it('forwards a deferred pool acquire carrier unchanged', () => {
      assertInactiveFastPath(method => wrapPoolAcquireCarrier(noop, method, inactiveChannel, true, noop))
    })

    it('forwards a mysql cluster query unchanged', () => {
      assertInactiveFastPath(method => wrapPoolClusterQueryMethod(method, inactiveChannel))
    })

    it('forwards a mysql2 cluster method unchanged', () => {
      assertInactiveFastPath(method => wrapPoolClusterMethod(method, inactiveChannel))
    })

    it('forwards a mysql2 cluster acquire unchanged', () => {
      assertInactiveFastPath(method => wrapPoolClusterGetConnection(method, inactiveChannel))
    })

    it('forwards a pool acquire unchanged', () => {
      assertInactiveFastPath(method => wrapPoolGetConnection(method, inactiveChannels))
    })

    it('forwards a deferred pool acquire unchanged', () => {
      assertInactiveFastPath(method => wrapPoolGetConnection(method, inactiveChannels, true))
    })
  })

  it('preserves the getConnection callback arguments and receiver', () => {
    const callbackReceiver = {}
    const connection = {}
    const error = new Error('acquire failed')
    const thirdArgument = {}

    for (const expectedArguments of [[error], [undefined, connection, thirdArgument]]) {
      const expectedReturn = {}
      const wrapped = wrapPoolGetConnection(function (callback) {
        return callback.apply(callbackReceiver, expectedArguments)
      }, {
        connectionStartCh: { hasSubscribers: true, publish: noop },
        connectionFinishCh: { runStores },
        acquireStartCh: inactiveChannel,
        acquireFinishCh: inactiveChannel,
      })

      const actualReturn = wrapped.call({ config: { connectionConfig: {} } }, function () {
        assert.strictEqual(this, callbackReceiver)
        assert.strictEqual(arguments.length, expectedArguments.length)
        for (let i = 0; i < arguments.length; i++) {
          assert.strictEqual(arguments[i], expectedArguments[i])
        }
        return expectedReturn
      })

      assert.strictEqual(actualReturn, expectedReturn)
    }
  })

  it('does not classify a different acquire in an internal error callback as part of the query', () => {
    const error = new Error('acquire failed')
    const connectionStartCh = { hasSubscribers: true, publish: noop }
    const connectionFinishCh = { runStores }
    let acquireStarts = 0
    const acquireStartCh = {
      hasSubscribers: true,
      publish: () => { acquireStarts++ },
    }
    const acquireFinishCh = { publish: noop }
    const pool = { config: { connectionConfig: {} } }
    const poolGetConnection = wrapPoolGetConnection(function (callback) {
      return callback(error)
    }, {
      connectionStartCh,
      connectionFinishCh,
      acquireStartCh,
      acquireFinishCh,
    })
    let insideNestedAcquire = false

    /**
     * @param {Function} callback
     * @returns {unknown}
     */
    function getConnection (callback) {
      return poolGetConnection.call(pool, function (error) {
        if (insideNestedAcquire) return callback(error)

        insideNestedAcquire = true
        return namespaceGetConnection(() => {})
      })
    }
    const namespaceGetConnection = wrapPoolClusterGetConnection(getConnection, connectionStartCh)
    const query = wrapPoolClusterMethod(() => namespaceGetConnection(() => {}), connectionStartCh)

    query()

    assert.strictEqual(acquireStarts, 1)
  })

  it('retains a mysql cluster query acquire across a deferred retry', async () => {
    const now = sinon.stub(performance, 'now')
    now.onFirstCall().returns(100)
    now.onSecondCall().returns(600)

    try {
      const connection = {}
      const error = new Error('acquire failed')
      const channels = activeChannels()
      const pool = { config: { connectionConfig: {} } }
      let attempts = 0
      const getConnection = wrapPoolGetConnection(function (callback) {
        if (++attempts === 1) return setImmediate(callback, error)
        return callback(undefined, connection)
      }, channels)
      const rawQuery = queryObject => {
        getConnection.call(pool, acquireError => {
          if (acquireError) return setImmediate(query, queryObject)
          queryObject.resolve(takePoolWaitTime(connection))
        })
        return queryObject
      }
      const query = wrapPoolClusterQueryMethod(rawQuery, channels.connectionStartCh)

      const waitTime = await new Promise(resolve => query({ resolve }))

      assert.strictEqual(attempts, 2)
      assert.strictEqual(waitTime, 500)
    } finally {
      now.restore()
    }
  })

  it('retains a mysql2 cluster query acquire across a deferred retry', async () => {
    const now = sinon.stub(performance, 'now')
    now.onFirstCall().returns(100)
    now.onSecondCall().returns(600)

    try {
      const connection = {}
      const error = new Error('acquire failed')
      const channels = activeChannels()
      const pool = { config: { connectionConfig: {} } }
      let attempts = 0
      const poolGetConnection = wrapPoolGetConnection(function (callback) {
        if (++attempts === 1) return callback(error)
        return callback(undefined, connection)
      }, channels)

      /**
       * @param {Function} callback
       * @returns {unknown}
       */
      function getConnection (callback) {
        return poolGetConnection.call(pool, function (error) {
          if (error) return setImmediate(namespaceGetConnection, callback)
          return callback(undefined, connection)
        })
      }
      const namespaceGetConnection = wrapPoolClusterGetConnection(getConnection, channels.connectionStartCh)
      const query = wrapPoolClusterMethod(
        callback => namespaceGetConnection(callback),
        channels.connectionStartCh
      )

      const waitTime = await new Promise((resolve, reject) => {
        query((error, connection) => {
          if (error) return reject(error)
          resolve(takePoolWaitTime(connection))
        })
      })

      assert.strictEqual(attempts, 2)
      assert.strictEqual(waitTime, 500)
    } finally {
      now.restore()
    }
  })

  it('keeps concurrent mysql2 cluster query acquires isolated', async () => {
    const now = sinon.stub(performance, 'now')
    now.onCall(0).returns(100)
    now.onCall(1).returns(200)
    now.onCall(2).returns(250)
    now.onCall(3).returns(700)

    try {
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
      const namespaceGetConnection = wrapPoolClusterGetConnection(getConnection, channels.connectionStartCh)
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
      await new Promise(resolve => setImmediate(resolve))
      physicalCallbacks[2](undefined, firstConnection)
      await Promise.all([first, second])

      assert.deepStrictEqual(waits, [600, 50])
    } finally {
      now.restore()
    }
  })

  it('clears an unconsumed pool wait when the connection is acquired again', async () => {
    const connection = {}
    const connectionStartCh = { hasSubscribers: true, publish: noop }
    const pool = { config: { connectionConfig: {} } }
    const getConnection = wrapPoolGetConnection(function (callback) {
      return callback(undefined, connection)
    }, {
      connectionStartCh,
      connectionFinishCh: { runStores },
      acquireStartCh: inactiveChannel,
      acquireFinishCh: inactiveChannel,
    })
    const query = wrapPoolQueryMethod(() => getConnection.call(pool, noop), connectionStartCh)

    query()
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    getConnection.call(pool, noop)

    assert.strictEqual(takePoolWaitTime(connection), undefined)
  })

  it('switches a pool implementation to deferred wait transfers after detecting one', async () => {
    const connection = {}
    const connectionStartCh = { hasSubscribers: true, publish: noop }
    const pool = { config: { connectionConfig: {} } }
    const waitTimes = []
    const getConnection = wrapPoolGetConnection(function (callback) {
      return callback(undefined, connection)
    }, {
      connectionStartCh,
      connectionFinishCh: { runStores },
      acquireStartCh: inactiveChannel,
      acquireFinishCh: inactiveChannel,
    })

    /**
     * @param {unknown} error
     * @param {object} connection
     */
    const onConnection = (error, connection) => {
      assert.strictEqual(error, undefined)
      setImmediate(() => {
        setImmediate(() => {
          setImmediate(() => waitTimes.push(takePoolWaitTime(connection)))
        })
      })
    }
    const query = wrapPoolQueryMethod(() => getConnection.call(pool, onConnection), connectionStartCh)

    query()
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    query()
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(waitTimes.length, 2)
    assert.strictEqual(typeof waitTimes[0], 'number')
    assert.strictEqual(typeof waitTimes[1], 'number')
  })

  it('classifies a synchronous reentrant acquire as explicit', () => {
    const connectionStartCh = { hasSubscribers: true, publish: noop }
    let acquireStarts = 0
    let reentered = false
    const pool = { config: { connectionConfig: {} } }

    const getConnection = wrapPoolGetConnection(function (callback) {
      if (!reentered) {
        reentered = true
        getConnection.call(pool, noop)
      }
      return callback(new Error('acquire failed'))
    }, {
      connectionStartCh,
      connectionFinishCh: { runStores },
      acquireStartCh: {
        hasSubscribers: true,
        publish: () => { acquireStarts++ },
      },
      acquireFinishCh: { publish: noop },
    })
    const query = wrapPoolQueryMethod(() => getConnection.call(pool, noop), connectionStartCh)

    query()

    assert.strictEqual(acquireStarts, 1)
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
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(acquireStarts, 1)
    assert.strictEqual(typeof waitTime, 'number')
  })

  it('selects deferred carriers without retaining the context after the internal acquire', async () => {
    const channel = { hasSubscribers: true }
    const pool = {}
    let internalAcquires = 0
    const acquire = wrapPoolAcquireCarrier(
      noop,
      noop,
      channel,
      true,
      (method, receiver, args) => {
        internalAcquires++
        return method.apply(receiver, args)
      }
    )
    const query = wrapPoolQueryCarrier(function () {
      setImmediate(() => {
        acquire.call(this, noop)
        acquire.call(this, noop)
      })
    }, channel, true)

    query.call(pool)
    await new Promise(resolve => setImmediate(resolve))

    assert.strictEqual(internalAcquires, 1)
  })

  it('keeps synchronous methods unchanged when deferred carriers are not needed', () => {
    assert.strictEqual(wrapPoolQueryCarrier(noop, inactiveChannel, false), noop)
    assert.strictEqual(wrapPoolAcquireCarrier(noop, noop, inactiveChannel, false, noop), noop)
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
