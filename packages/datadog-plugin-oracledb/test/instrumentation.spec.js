'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, before, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const poolAcquireStartChannel = dc.channel('apm:oracledb:pool:acquire:start')
const poolAcquireFinishChannel = dc.channel('apm:oracledb:pool:acquire:finish')

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
   * @param {{ homogeneous?: boolean, poolUser?: string, connectionUser?: string | (() => string) }} options
   */
  function createOracledb (options) {
    class Connection {
      execute () {}
    }

    class Pool {
      constructor (poolAttrs) {
        if (options.homogeneous !== undefined) this.homogeneous = options.homogeneous
        this.user = options.poolUser
        this.poolAttrs = poolAttrs
      }

      getConnection (connectionOptions, callback) {
        if (typeof connectionOptions === 'function') {
          callback = connectionOptions
        }
        const connection = new Connection()
        if (options.connectionUser !== undefined) {
          Object.defineProperty(connection, 'user', {
            get: typeof options.connectionUser === 'function'
              ? options.connectionUser
              : () => options.connectionUser,
          })
        }
        if (callback) {
          callback(undefined, connection)
          return
        }
        return Promise.resolve(connection)
      }
    }

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

  it('publishes a heterogeneous Promise acquisition user override', async () => {
    let finishContext
    subscribe(poolAcquireStartChannel, () => {})
    subscribe(poolAcquireFinishChannel, ctx => { finishContext = ctx })
    const oracledb = createOracledb({ homogeneous: false, poolUser: 'base', connectionUser: 'proxy' })
    const pool = await oracledb.createPool({ homogeneous: false, user: 'base' })

    await pool.getConnection({ user: 'proxy' })

    assert.strictEqual(finishContext.user, 'proxy')
  })

  it('publishes a heterogeneous callback acquisition user override', async () => {
    let finishContext
    subscribe(poolAcquireStartChannel, () => {})
    subscribe(poolAcquireFinishChannel, ctx => { finishContext = ctx })
    const oracledb = createOracledb({ homogeneous: false, poolUser: 'base', connectionUser: 'proxy' })
    const pool = await oracledb.createPool({ homogeneous: false, user: 'base' })

    await getConnectionWithCallback(pool)

    assert.strictEqual(finishContext.user, 'proxy')
  })

  it('does not read the connection user for a homogeneous pool', async () => {
    let finishContext
    subscribe(poolAcquireStartChannel, () => {})
    subscribe(poolAcquireFinishChannel, ctx => { finishContext = ctx })
    const oracledb = createOracledb({
      homogeneous: true,
      poolUser: 'base',
      connectionUser: () => { throw new Error('user getter was read') },
    })
    const pool = await oracledb.createPool({ homogeneous: true, user: 'base' })

    await pool.getConnection()

    assert.strictEqual(finishContext.user, undefined)
  })

  it('publishes the acquired user for a heterogeneous pool', async () => {
    let finishContext
    subscribe(poolAcquireStartChannel, () => {})
    subscribe(poolAcquireFinishChannel, ctx => { finishContext = ctx })
    const oracledb = createOracledb({ homogeneous: false, poolUser: 'base', connectionUser: 'base' })
    const pool = await oracledb.createPool({ homogeneous: false, user: 'base' })

    await pool.getConnection()

    assert.strictEqual(finishContext.user, 'base')
  })

  it('does not publish a heterogeneous user when OracleDB does not expose it', async () => {
    let finishContext
    subscribe(poolAcquireStartChannel, () => {})
    subscribe(poolAcquireFinishChannel, ctx => { finishContext = ctx })
    const oracledb = createOracledb({ homogeneous: false, poolUser: 'base' })
    const pool = await oracledb.createPool({ homogeneous: false, user: 'base' })

    await pool.getConnection()

    assert.strictEqual(finishContext.user, undefined)
  })

  it('uses the pool options when public homogeneous metadata is unavailable', async () => {
    let finishContext
    subscribe(poolAcquireStartChannel, () => {})
    subscribe(poolAcquireFinishChannel, ctx => { finishContext = ctx })
    const oracledb = createOracledb({ poolUser: 'base', connectionUser: 'proxy' })
    const pool = await oracledb.createPool({ homogeneous: false, user: 'base' })

    await pool.getConnection()

    assert.strictEqual(finishContext.user, 'proxy')
  })

  it('defaults to a homogeneous pool when metadata is unavailable', async () => {
    let finishContext
    subscribe(poolAcquireStartChannel, () => {})
    subscribe(poolAcquireFinishChannel, ctx => { finishContext = ctx })
    const oracledb = createOracledb({
      poolUser: 'base',
      connectionUser: () => { throw new Error('user getter was read') },
    })
    const pool = await oracledb.createPool({ user: 'base' })

    await pool.getConnection()

    assert.strictEqual(finishContext.user, undefined)
  })

  it('does not publish an inactive callback acquisition', async () => {
    let finishContext
    subscribe(poolAcquireFinishChannel, ctx => { finishContext = ctx })
    const oracledb = createOracledb({ homogeneous: true, poolUser: 'base', connectionUser: 'base' })
    const pool = await oracledb.createPool({ homogeneous: true, user: 'base' })

    const connection = await getConnectionWithCallback(pool)

    assert.ok(connection)
    assert.strictEqual(finishContext, undefined)
  })
})
