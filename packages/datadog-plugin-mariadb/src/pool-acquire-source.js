'use strict'

/**
 * @typedef {object} MariaDBPoolAcquireContext
 * @property {object} [conf]
 * @property {unknown} [error]
 * @property {number} [poolWaitTime]
 * @property {number} [startTime]
 */

module.exports = {
  connection: {
    finish: 'apm:mariadb:connection:finish',
    skip: 'apm:mariadb:pool:skip',
    start: 'apm:mariadb:connection:start',
  },
  targets: [{
    channels: {
      finish: 'apm:mariadb:pool:acquire:finish',
      start: 'apm:mariadb:pool:acquire:start',
    },
  }],

  /**
   * Normalize MariaDB pool configuration into shared database acquisition facts.
   *
   * @param {MariaDBPoolAcquireContext} context Raw MariaDB pool-acquire context.
   * @returns {object} Shared database pool-acquire facts.
   */
  start (context) {
    const conf = context.conf || {}

    return {
      connection: {
        database: conf.database,
        host: conf.host,
        port: conf.port,
        user: conf.user,
      },
      startTime: context.startTime,
    }
  },

  /**
   * Normalize MariaDB pool wait time into completion metadata.
   *
   * @param {MariaDBPoolAcquireContext} context Raw MariaDB pool-acquire context.
   * @returns {object | undefined} Pool-acquire completion tags.
   */
  complete (context) {
    if (context.poolWaitTime === undefined) return

    return { 'mariadb.pool.wait_time': context.poolWaitTime }
  },
}
