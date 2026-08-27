'use strict'

const { createDatabaseIntegration } = require('../../dd-trace/src/events/database')
const poolAcquireSource = require('./pool-acquire-source')
const querySource = require('./query-source')

module.exports = createDatabaseIntegration({
  id: 'mariadb',
  system: 'mariadb',
  operations: [{
    operation: 'db.query',
    adapter: 'query',
    source: querySource,
  }, {
    operation: 'db.pool.acquire',
    adapter: 'pool.acquire',
    source: poolAcquireSource,
  }],
})
