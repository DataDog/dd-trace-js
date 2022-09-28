'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')

class CassandraDriverPlugin extends DatabasePlugin {
  static get name () { return 'cassandra-driver' }
  static get system () { return 'cassandra' }

  start ({ keyspace, query, connectionOptions = {} }) {
    if (Array.isArray(query)) {
      query = combine(query)
    }

    this.startSpan('cassandra.query', {
      service: this.config.service,
      resource: trim(query, 5000),
      type: 'cassandra',
      kind: 'client',
      meta: {
        'db.type': 'cassandra',
        'cassandra.query': query,
        'cassandra.keyspace': keyspace,
        'out.host': connectionOptions.host,
        'out.port': connectionOptions.port
      }
    })
  }
}

function combine (queries) {
  return queries
    .map(query => (query.query || query).replace(/;?$/, ';'))
    .join(' ')
}

function trim (str, size) {
  if (!str || str.length <= size) return str

  return `${str.substr(0, size - 3)}...`
}

module.exports = CassandraDriverPlugin
