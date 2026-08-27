'use strict'

const { createDatabaseIntegration } = require('../../dd-trace/src/events/database')
const querySource = require('./query-source')

module.exports = createDatabaseIntegration({
  id: 'azure-cosmos',
  system: 'cosmosdb',
  schema: false,
  operations: [{
    operation: 'db.query',
    adapter: 'query',
    source: querySource,
  }],
})
