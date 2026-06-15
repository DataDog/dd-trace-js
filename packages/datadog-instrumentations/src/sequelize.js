'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')
const { wrapPoolAcquire } = require('./helpers/promise-pool-acquire')

const startPoolAcquireCh = channel('apm:sequelize:pool:acquire:start')
const finishPoolAcquireCh = channel('apm:sequelize:pool:acquire:finish')

addHook({
  name: 'sequelize',
  versions: ['>=4'],
  file: 'lib/dialects/abstract/connection-manager.js',
}, ConnectionManager => {
  // `getConnection` pulls a connection from sequelize-pool before every query. Wrap it so a caller
  // that waits for a busy pool gets a span reporting that wait; an available connection takes the
  // fast path with no span. See helpers/promise-pool-acquire.js.
  shimmer.wrap(ConnectionManager.prototype, 'getConnection', getConnection => wrapPoolAcquire(
    getConnection,
    startPoolAcquireCh,
    finishPoolAcquireCh,
    manager => {
      const config = manager.config ?? {}
      return {
        conf: { host: config.host, port: config.port, user: config.username, database: config.database },
        dialect: manager.dialectName,
      }
    },
    sequelizeHasIdleConnection
  ))

  return ConnectionManager
})

addHook({ name: 'sequelize', versions: ['>=4'], file: 'lib/sequelize.js' }, Sequelize => {
  const startCh = channel('datadog:sequelize:query:start')
  const finishCh = channel('datadog:sequelize:query:finish')

  shimmer.wrap(Sequelize.prototype, 'query', query => {
    return function (sql, options) {
      if (!startCh.hasSubscribers) {
        return query.apply(this, arguments)
      }

      let dialect
      if (this.options && this.options.dialect) {
        dialect = this.options.dialect
      } else if (this.dialect && this.dialect.name) {
        dialect = this.dialect.name
      }

      function onFinish (result) {
        const type = options?.type || 'RAW'
        if (type === 'RAW' && result?.length > 1) {
          result = result[0]
        }

        finishCh.runStores({ result }, () => {})
      }

      return startCh.runStores({ sql, dialect }, () => {
        const promise = query.apply(this, arguments)
        promise.then(onFinish, () => { onFinish() })

        return promise
      })
    }
  })

  return Sequelize
})

/**
 * An available connection in sequelize-pool is handed back without waiting, so no span is opened.
 * Replication uses a `{ read, write }` facade whose sub-pool depends on the query type. A pool that
 * does not expose `available` (older sequelize) also takes the fast path, limiting the span to
 * versions where a real wait can be detected rather than risking one span per query.
 *
 * @param {{ pool?: { available?: number, read?: { available?: number }, write?: { available?: number } } }} manager
 * @param {[{ type?: string, useMaster?: boolean }?]} args
 * @returns {boolean}
 */
function sequelizeHasIdleConnection (manager, args) {
  const pool = manager.pool
  if (typeof pool?.available === 'number') {
    return pool.available > 0
  }
  const options = args[0]
  const sub = options?.type === 'SELECT' && !options?.useMaster ? pool?.read : pool?.write
  return typeof sub?.available === 'number' ? sub.available > 0 : true
}
