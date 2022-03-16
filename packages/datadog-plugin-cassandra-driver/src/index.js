'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')

class CassandraDriverPlugin extends Plugin {
  static get name () {
    return 'cassandra-driver'
  }
  constructor (...args) {
    super(...args)

    this.addSub(`apm:cassandra:query:start`, ({ keyspace, query }) => {
      if (Array.isArray(query)) {
        query = combine(query)
      }

      this.startSpan('cassandra.query', {
        resource: trim(query, 5000),
        service: this.config.service || `${this.tracer.config.service}-cassandra`,
        kind: 'client',
        type: 'cassandra',
        meta: {
          'db.type': 'cassandra',
          'cassandra.query': query,
          'cassandra.keyspace': keyspace,
          'out.host': '',
          'out.port': ''
        }
      })
    })

    this.addSub(`apm:cassandra:query:end`, () => {
      this.exit()
    })

    this.addSub(`apm:cassandra:query:error`, err => {
      this.addError(err)
    })

    this.addSub(`apm:cassandra:query:async-end`, () => {
      this.finishSpan()
    })

    this.addSub(`apm:cassandra:query:addConnection`, connectionOptions => {
      const span = this.activeSpan

      // TODO: this should not be needed if the context is propagated properly
      if (!span) return

      span.meta['out.host'] = connectionOptions.address
      span.meta['out.port'] = connectionOptions.port
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
