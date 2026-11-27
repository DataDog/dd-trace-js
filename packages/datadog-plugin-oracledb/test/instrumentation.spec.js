'use strict'

const assert = require('node:assert/strict')

const dc = require('dc-polyfill')
const { afterEach, before, describe, it } = require('mocha')
const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')

const log = require('../../dd-trace/src/log')

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
   * @param {{ homogeneous?: boolean, poolUser?: string, legacy?: boolean, thin?: boolean, version?: number }} options
   */
  function createOracledb (options) {
    class Connection {
      constructor () {
        this.thin = options.thin
      }

      execute () {
        return Promise.resolve({ rows: [[1]] })
      }
    }

    class Pool {
      constructor (poolAttrs) {
        this.homogeneous = options.homogeneous ?? poolAttrs.homogeneous ?? true
        this.connectString = poolAttrs.connectString ?? poolAttrs.connectionString
        this.user = options.poolUser
        this.thin = options.thin
        this.poolAttrs = poolAttrs
        if (options.legacy) {
          this.getConnection = nativeGetConnection
        }
      }

      /**
       * @param {{ user?: string } | ((error?: Error, connection?: Connection) => void)} [connectionOptions]
       * @param {(error?: Error, connection?: Connection) => void} [callback]
       */
      getConnection (connectionOptions, callback) {
        if (typeof connectionOptions === 'function') {
          callback = connectionOptions
        }

        const promise = Promise.resolve(new Connection())
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
      version: options.version ?? 61000,
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

  it('does not publish an inactive callback acquisition', async () => {
    let finishContext
    subscribe(poolAcquireFinishChannel, ctx => { finishContext = ctx })
    const oracledb = createOracledb({ homogeneous: true, poolUser: 'base' })
    const pool = await oracledb.createPool({ homogeneous: true, user: 'base' })

    const connection = await getConnectionWithCallback(pool)

    assert.ok(connection)
    assert.strictEqual(finishContext, undefined)
  })

  for (const useCallback of [false, true]) {
    for (const [version, thin, allowBareHostname] of [
      [50000, undefined, true],
      [60000, true, true],
      [60100, true, true],
      [60200, true, false],
      [61000, true, false],
      [61000, false, true],
    ]) {
      it(`publishes bare-hostname support for ${version}/${thin} ${useCallback ? 'callback' : 'Promise'} calls`,
        async () => {
          let startMode
          let queryMode
          subscribe(poolAcquireStartChannel, ctx => { startMode = ctx.allowBareHostname })
          subscribe(dc.channel('apm:oracledb:query:start'), ctx => { queryMode = ctx.allowBareHostname })
          const oracledb = createOracledb({ thin, version })
          const pool = await oracledb.createPool({ connectString: 'db.example' })

          const connection = useCallback ? await getConnectionWithCallback(pool) : await pool.getConnection()
          await connection.execute('select 1 from dual')

          assert.strictEqual(startMode, allowBareHostname)
          assert.strictEqual(queryMode, allowBareHostname)
        })
    }

    it(`preserves ${useCallback ? 'callback' : 'Promise'} results without logging metadata failures`, async () => {
      let finishContext
      subscribe(poolAcquireStartChannel, () => {})
      subscribe(poolAcquireFinishChannel, ctx => { finishContext = ctx })
      const oracledb = createOracledb({})
      const failure = new Error('metadata unavailable')
      Object.defineProperty(oracledb.Connection.prototype, 'serviceName', {
        get () { throw failure },
      })
      const pool = await oracledb.createPool({ user: 'test' })
      const logged = sinon.stub(log, 'error')
      try {
        for (let i = 0; i < 3; i++) {
          const connection = useCallback ? await getConnectionWithCallback(pool) : await pool.getConnection()
          assert.strictEqual(logged.callCount, 0)
          assert.ok(connection instanceof oracledb.Connection)
          assert.strictEqual(finishContext.error, undefined)
        }
      } finally {
        logged.restore()
      }
    })
  }
})
