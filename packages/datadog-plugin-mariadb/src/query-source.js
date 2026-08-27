'use strict'

/**
 * @typedef {object} MariaDBQueryContext
 * @property {string | {sql?: string}} sql
 * @property {object} [conf]
 * @property {number} [poolWaitTime]
 */

module.exports = {
  parentChannels: ['apm:mariadb:command:add'],
  targets: [{
    channels: {
      error: 'apm:mariadb:query:error',
      finish: 'apm:mariadb:query:finish',
      start: 'apm:mariadb:query:start',
    },
  }],

  /**
   * Normalize a MariaDB query lifecycle into shared database facts.
   *
   * @param {MariaDBQueryContext} context Raw MariaDB instrumentation context.
   * @returns {object} Shared database query facts.
   */
  start (context) {
    const conf = context.conf || {}
    const statement = typeof context.sql === 'string' ? context.sql : context.sql?.sql
    const facts = {
      connection: {
        database: conf.database,
        host: conf.host,
        port: conf.port,
        user: conf.user,
      },
      statement,
    }

    if (context.poolWaitTime !== undefined) {
      facts.tags = { 'mariadb.pool.wait_time': context.poolWaitTime }
    }

    return facts
  },

  /**
   * Write a processor-updated SQL statement back to the driver-owned query shape.
   *
   * @param {MariaDBQueryContext} context Raw MariaDB instrumentation context.
   * @param {object} _facts Original normalized database facts.
   * @param {{statement: string}} updates Processor-owned source updates.
   * @returns {void}
   */
  updateSource (context, _facts, updates) {
    if (context.sql !== null && typeof context.sql === 'object') {
      context.sql.sql = updates.statement
    } else {
      context.sql = updates.statement
    }
  },
}
