'use strict'

const DatabasePlugin = require('../../dd-trace/src/plugins/database')
const {
  configuredService,
  configuredSystemService,
  optionServiceSource,
  storageServiceSource,
} = require('../../dd-trace/src/service-naming/helpers')
const CASSANDRA_CONTACT_POINTS_KEY = 'db.cassandra.contact.points'

/** @type {import('../../dd-trace/src/plugins/tracing').NamingSchema} */
const namingSchema = {
  v0: {
    operationName: () => 'cassandra.query',
    serviceName: configuredSystemService,
    serviceSource: storageServiceSource('cassandra-driver'),
  },
  v1: {
    operationName: () => 'cassandra.query',
    serviceName: configuredService,
    serviceSource: optionServiceSource,
  },
}

class CassandraDriverPlugin extends DatabasePlugin {
  static id = 'cassandra-driver'
  static system = 'cassandra'
  static peerServicePrecursors = [CASSANDRA_CONTACT_POINTS_KEY]

  /** @override */
  getNamingSchema () {
    return namingSchema
  }

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
        [CASSANDRA_CONTACT_POINTS_KEY]: contactPoints.join(',') || null,
      },
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
