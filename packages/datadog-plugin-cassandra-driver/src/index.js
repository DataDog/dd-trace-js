'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const CASSANDRA_CONTACT_POINTS_KEY = 'db.cassandra.contact.points'

class CassandraDriverPlugin extends DatabasePlugin {
  static id = 'cassandra-driver'
  static system = 'cassandra'
  static peerServicePrecursors = [CASSANDRA_CONTACT_POINTS_KEY]

  bindStart (ctx) {
    let { keyspace, query, contactPoints = {} } = ctx

    if (Array.isArray(query)) {
      query = combine(query)
    }

    this.startSpan(this.operationName(), {
      service: this.serviceName({ pluginConfig: this.config, system: this.system }),
      resource: trim(query, 5000),
      type: 'cassandra',
      kind: 'client',
      meta: {
        'db.type': 'cassandra',
        'cassandra.query': query,
        'cassandra.keyspace': keyspace,
        [CASSANDRA_CONTACT_POINTS_KEY]: contactPoints.join(',') || null
      }
    }, ctx)

    return ctx.currentStore
  }
}

function combine (queries) {
  return queries
    .map(query => (query.query || query).replace(/;?$/, ';'))
    .join(' ')
}

function trim (str, size) {
  if (!str || str.length <= size) return str

  return `${str.slice(0, size - 3)}...`
}

module.exports = CassandraDriverPlugin
