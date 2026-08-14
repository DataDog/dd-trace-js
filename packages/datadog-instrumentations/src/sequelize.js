'use strict'

const shimmer = require('../../datadog-shimmer')
const {
  channel,
  addHook,
} = require('./helpers/instrument')
const {
  wrapPoolRelease,
  wrapPromisePoolAcquire,
  wrapPromisePoolQueryMethod,
} = require('./helpers/pool-acquire')

addHook({
  name: 'sequelize',
  versions: ['>=4'],
  file: 'lib/dialects/abstract/connection-manager.js',
}, ConnectionManager => {
  shimmer.wrap(ConnectionManager.prototype, 'getConnection', getConnection => wrapPromisePoolAcquire(
    getConnection,
    resolveSequelizeDriver,
    resolveSequelizeConfig,
    sequelizeHasIdleConnection
  ))
  shimmer.wrap(ConnectionManager.prototype, 'releaseConnection', wrapPoolRelease)
  if (typeof ConnectionManager.prototype.destroyConnection === 'function') {
    shimmer.wrap(ConnectionManager.prototype, 'destroyConnection', wrapPoolRelease)
  }

  return ConnectionManager
})

addHook({ name: 'sequelize', versions: ['>=4'], file: 'lib/sequelize.js' }, Sequelize => {
  const startCh = channel('datadog:sequelize:query:start')
  const finishCh = channel('datadog:sequelize:query:finish')

  shimmer.wrap(Sequelize.prototype, 'query', query => {
    const queryWithPool = wrapPromisePoolQueryMethod(
      query,
      (sequelize, args) => args[1]?.transaction ? undefined : sequelize.connectionManager,
      sequelize => resolveSequelizeDriver(sequelize.connectionManager)
    )

    return function (sql, options) {
      if (!startCh.hasSubscribers) {
        return queryWithPool.apply(this, arguments)
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
        const promise = queryWithPool.apply(this, arguments)
        promise.then(onFinish, () => { onFinish() })

        return promise
      })
    }
  })

  return Sequelize
})

addHook({ name: 'sequelize', versions: ['>=4'], file: 'lib/transaction.js' }, Transaction => {
  shimmer.wrap(Transaction.prototype, 'prepareEnvironment', prepareEnvironment => wrapPromisePoolQueryMethod(
    prepareEnvironment,
    transaction => transaction.parent ? undefined : transaction.sequelize.connectionManager,
    transaction => resolveSequelizeDriver(transaction.sequelize.connectionManager)
  ))

  return Transaction
})

/**
 * @typedef {{
 *   available: number,
 *   pending?: number,
 *   waiting?: number,
 * }} SequelizePool
 */

/**
 * @param {{ pool: SequelizePool & { read?: SequelizePool, write?: SequelizePool } }} manager
 * @param {[{ type?: string, useMaster?: boolean }?]} args
 * @returns {boolean}
 */
function sequelizeHasIdleConnection (manager, args) {
  const pool = manager.pool
  const options = args[0]
  const selected = pool?.read === undefined
    ? pool
    : options?.type === 'SELECT' && !options?.useMaster ? pool.read : pool.write
  const waiting = selected.waiting ?? selected.pending
  return selected.available > waiting
}

/**
 * @param {{ dialectName?: string }|undefined} manager
 * @returns {'mariadb'|'mysql2'|'pg'|undefined}
 */
function resolveSequelizeDriver (manager) {
  switch (manager?.dialectName) {
    case 'mariadb':
      return 'mariadb'
    case 'mysql':
      return 'mysql2'
    case 'postgres':
      return 'pg'
  }
}

/**
 * @param {{ config: Record<string, unknown> & { username?: string } }} manager
 * @returns {Record<string, unknown>}
 */
function resolveSequelizeConfig (manager) {
  const config = manager.config
  return {
    database: config.database,
    host: config.host,
    port: config.port,
    user: config.username,
  }
}
