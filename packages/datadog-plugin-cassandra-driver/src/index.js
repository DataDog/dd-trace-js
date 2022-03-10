'use strict'

const Plugin = require('../../dd-trace/src/plugins/plugin')
const { storage } = require('../../datadog-core')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

class CassandraDriverPlugin extends Plugin {
  static get name () {
    return 'cassandra-driver'
  }
  constructor (...args) {
    super(...args)

    this.addSub(`apm:cassandra:query:start`, ({ keyspace, query, connectionOptions }) => {
      const store = storage.getStore()
      const childOf = store ? store.span : store

      if (Array.isArray(query)) {
        query = combine(query)
      }

      const span = this.tracer.startSpan('cassandra.query', {
        childOf,
        tags: {
          'service.name': this.config.service || `${this.tracer._service}-cassandra`,
          'resource.name': trim(query, 5000),
          'span.type': 'cassandra',
          'span.kind': 'client',
          'db.type': 'cassandra',
          'cassandra.query': query,
          'cassandra.keyspace': keyspace
        }
      })

      if (connectionOptions) {
        span.addTags({
          'out.host': connectionOptions.host,
          'out.port': connectionOptions.port
        })
      }

      analyticsSampler.sample(span, this.config.measured)
      this.enter(span, store)
    })

    this.addSub(`apm:cassandra:query:end`, () => {
      this.exit()
    })

    this.addSub(`apm:cassandra:query:error`, err => {
      storage.getStore().span.setTag('error', err)
    })

    this.addSub(`apm:cassandra:query:async-end`, () => {
      storage.getStore().span.finish()
    })

    this.addSub(`apm:cassandra:query:addConnection`, connectionOptions => {
      const store = storage.getStore()
      if (!store) {
        return
      }
      const span = store.span
      span.addTags({
        'out.host': connectionOptions.address,
        'out.port': connectionOptions.port
      })
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
