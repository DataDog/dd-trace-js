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
   * @param {{ homogeneous?: boolean, poolUser?: string }} options
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

  /**
   * @param {{ homogeneous?: boolean, poolUser?: string }} options
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
