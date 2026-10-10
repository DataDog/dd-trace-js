'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, before, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const poolAcquireStartChannel = dc.channel('apm:oracledb:pool:acquire:start')
const poolAcquireErrorChannel = dc.channel('apm:oracledb:pool:acquire:error')
const poolAcquireFinishChannel = dc.channel('apm:oracledb:pool:acquire:finish')
const poolAcquireUserChannel = dc.channel('apm:oracledb:pool:acquire:user')

describe('oracledb instrumentation', () => {
  let transform
  const subscriptions = []

  before(() => {
    const realInstrument = require('../../datadog-instrumentations/src/helpers/instrument')
    const addHookSpy = sinon.spy()

    proxyquire('../../datadog-instrumentations/src/oracledb', {
      './helpers/instrument': { ...realInstrument, addHook: addHookSpy },
    })

    transform = addHookSpy.firstCall.args[1]
  })

  afterEach(() => {
    while (subscriptions.length > 0) {
      const [channel, listener] = subscriptions.pop()
      channel.unsubscribe(listener)
    }
  })

  /**
   * @param {import('dc-polyfill').Channel} channel
   * @param {(ctx: object) => void} listener
   */
  function subscribe (channel, listener) {
    channel.subscribe(listener)
    subscriptions.push([channel, listener])
  }

  /**
   * @param {{ homogeneous?: boolean, poolUser?: string, legacy?: boolean }} options
   */
  function createOracledb (options) {
    class Connection {
      /** @type {string | undefined} */
      user

      execute () {}
    }

    class Pool {
      constructor (poolAttrs) {
        if (options.homogeneous !== undefined) this.homogeneous = options.homogeneous
        this.user = options.poolUser
        this.poolAttrs = poolAttrs
        if (options.legacy) {
          this.getConnection = nativeGetConnection
        } else {
          this._pendingRequestQueue = new Set()
        }
      }

      /** @param {{ options: { user?: string } }} request */
      _processRequest (request) {
        const connection = new Connection()
        connection.user = request.options.user
        return Promise.resolve(connection)
      }

      /**
       * @param {{ user?: string } | ((error?: Error, connection?: Connection) => void)} [connectionOptions]
       * @param {(error?: Error, connection?: Connection) => void} [callback]
       */
      getConnection (connectionOptions, callback) {
        if (typeof connectionOptions === 'function') {
          callback = connectionOptions
          connectionOptions = undefined
        }

        const promise = (async () => {
          const normalized = { user: connectionOptions?.user }
          return this._processRequest({ options: normalized })
        })()
        if (callback) {
          promise.then(connection => callback(undefined, connection), callback)
          return
        }
        return promise
      }
    }

    const nativeGetConnection = Pool.prototype.getConnection
    const oracledb = {
      Connection,
      Pool,
      createPool: poolAttrs => Promise.resolve(new Pool(poolAttrs)),
      getConnection: () => Promise.resolve(new Connection()),
    }
    return transform(oracledb)
  }

  /**
   * @param {{ getConnection: Function }} pool
   * @returns {Promise<object>}
   */
  function getConnectionWithCallback (pool) {
    return new Promise((resolve, reject) => {
      pool.getConnection({ username: 'proxy' }, (error, connection) => {
        if (error) {
          reject(error)
        } else {
          resolve(connection)
        }
      })
    })
  }

  /**
   * @param {{ homogeneous?: boolean, poolUser?: string, legacy?: boolean }} options
   * @param {{ homogeneous?: boolean, user?: string, username?: string }} poolAttrs
   * @param {(pool: { getConnection: Function }) => Promise<unknown>} acquire
   * @returns {Promise<string | undefined>}
   */
  async function getStartUser (options, poolAttrs, acquire) {
    let startUser
    subscribe(poolAcquireStartChannel, ctx => { startUser = ctx.user })
    const pool = await createOracledb(options).createPool(poolAttrs)

    await acquire(pool)

    return startUser
  }

  it('publishes a heterogeneous Promise acquisition user override at start', async () => {
    const user = await getStartUser(
      { homogeneous: false, poolUser: 'base' },
      { homogeneous: false, user: 'base' },
      pool => pool.getConnection({ user: 'proxy' })
    )

    assert.strictEqual(user, 'proxy')
  })

  it('uses the pool user path when a legacy pool has no request queue', async () => {
    const user = await getStartUser(
      { homogeneous: false, poolUser: 'base', legacy: true },
      { homogeneous: false, user: 'base' },
      async pool => {
        await pool.getConnection({ user: 'proxy' })
        await pool.getConnection({ user: 'proxy' })
      }
    )

    assert.strictEqual(user, 'proxy')
  })

  it('publishes a heterogeneous callback acquisition username override at start', async () => {
    const user = await getStartUser(
      { homogeneous: false, poolUser: 'base' },
      { homogeneous: false, user: 'base' },
      getConnectionWithCallback
    )

    assert.strictEqual(user, 'proxy')
  })

  it('falls back to the pool user for a heterogeneous acquisition without credentials', async () => {
    const user = await getStartUser(
      { homogeneous: false, poolUser: 'base' },
      { homogeneous: false, user: 'base' },
      pool => pool.getConnection({ tag: '' })
    )

    assert.strictEqual(user, 'base')
  })

  it('falls back to the pool user for a heterogeneous callback-only acquisition', async () => {
    const user = await getStartUser(
      { homogeneous: false, poolUser: 'base' },
      { homogeneous: false, user: 'base' },
      pool => new Promise((resolve, reject) => {
        pool.getConnection((error, connection) => error ? reject(error) : resolve(connection))
      })
    )

    assert.strictEqual(user, 'base')
  })

  it('publishes the pool user for a homogeneous pool', async () => {
    const user = await getStartUser(
      { homogeneous: true, poolUser: 'base' },
      { homogeneous: true, user: 'base' },
      pool => pool.getConnection()
    )

    assert.strictEqual(user, 'base')
  })

  it('uses the username pool option when OracleDB 5 does not expose the pool user', async () => {
    const user = await getStartUser(
      { homogeneous: true },
      { homogeneous: true, username: 'alias' },
      pool => pool.getConnection()
    )

    assert.strictEqual(user, 'alias')
  })

  it('uses the pool options when public homogeneous metadata is unavailable', async () => {
    const user = await getStartUser(
      { poolUser: 'base' },
      { homogeneous: false, user: 'base' },
      pool => pool.getConnection({ user: 'proxy' })
    )

    assert.strictEqual(user, 'proxy')
  })

  it('defaults to a homogeneous pool when metadata is unavailable', async () => {
    const user = await getStartUser(
      { poolUser: 'base' },
      { user: 'base' },
      pool => pool.getConnection({ user: 'proxy' })
    )

    assert.strictEqual(user, 'base')
  })

  it('preserves Promise and callback errors from acquisition option getters', async () => {
    const errors = []
    subscribe(poolAcquireStartChannel, () => {})
    subscribe(poolAcquireErrorChannel, ctx => { errors.push(ctx.error) })
    const oracledb = createOracledb({ homogeneous: false, poolUser: 'base' })
    const pool = await oracledb.createPool({ homogeneous: false, user: 'base' })
    const getterError = new Error('getter failed')
    const connectionOptions = {
      get user () { throw getterError },
    }

    const promise = pool.getConnection(connectionOptions)
    assert.ok(promise instanceof Promise)
    await assert.rejects(promise, getterError)

    await new Promise((resolve, reject) => {
      const result = pool.getConnection(connectionOptions, error => {
        try {
          assert.strictEqual(error, getterError)
          resolve(undefined)
        } catch (assertionError) {
          reject(assertionError)
        }
      })
      assert.strictEqual(result, undefined)
    })

    assert.deepStrictEqual(errors, [getterError, getterError])
  })

  it('does not evaluate acquisition option getters before OracleDB', async () => {
    let calls = 0
    const resolvedUsers = []
    const oracledb = createOracledb({ homogeneous: false, poolUser: 'base' })
    const pool = await oracledb.createPool({ homogeneous: false, user: 'base' })
    const connectionOptions = {
      get user () {
        calls++
        return 'proxy'
      },
    }

    await pool.getConnection(connectionOptions)
    const nativeCalls = calls
    subscribe(poolAcquireStartChannel, () => {})
    subscribe(poolAcquireUserChannel, ctx => { resolvedUsers.push(ctx.user) })
    await pool.getConnection(connectionOptions)

    assert.strictEqual(calls, nativeCalls * 2)
    assert.deepStrictEqual(resolvedUsers, ['proxy'])
  })

  it('does not inspect proxy descriptors before OracleDB', async () => {
    const resolvedUsers = []
    subscribe(poolAcquireStartChannel, () => {})
    subscribe(poolAcquireUserChannel, ctx => { resolvedUsers.push(ctx.user) })
    const oracledb = createOracledb({ homogeneous: false, poolUser: 'base' })
    const pool = await oracledb.createPool({ homogeneous: false, user: 'base' })
    const connectionOptions = new Proxy({ user: 'proxy' }, {
      getOwnPropertyDescriptor () { throw new Error('descriptor inspected') },
    })

    const connection = await pool.getConnection(connectionOptions)

    assert.strictEqual(connection.user, 'proxy')
    assert.deepStrictEqual(resolvedUsers, ['proxy'])
  })

  it('does not publish an inactive callback acquisition', async () => {
    let finishContext
    subscribe(poolAcquireFinishChannel, ctx => { finishContext = ctx })
    const oracledb = createOracledb({ homogeneous: true, poolUser: 'base' })
    const pool = await oracledb.createPool({ homogeneous: true, user: 'base' })

    const connection = await getConnectionWithCallback(pool)

    assert.ok(connection)
    assert.strictEqual(finishContext, undefined)
  })
})
