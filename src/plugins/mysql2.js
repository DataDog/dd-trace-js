'use strict'

const Tags = require('opentracing').Tags
const analyticsSampler = require('../analytics_sampler')

function createWrapQuery (tracer, config) {
  return function wrapQuery (query) {
    return function queryWithTrace (sql, values, cb) {
      const scope = tracer.scope()
      const childOf = scope.active()
      const span = tracer.startSpan('mysql.query', {
        childOf,
        tags: {
          [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
          'service.name': config.service || `${tracer._service}-mysql`,
          'span.type': 'sql',
          'db.type': 'mysql',
          'db.user': this.config.user,
          'out.host': this.config.host,
          'out.port': this.config.port
        }
      })

      if (this.config.database) {
        span.setTag('db.name', this.config.database)
      }

      analyticsSampler.sample(span, config.analytics)

      const sequence = scope.bind(query, span).call(this, sql, values, cb)

      span.setTag('resource.name', sequence.sql)

      if (sequence.onResult) {
        sequence.onResult = wrapCallback(tracer, span, childOf, sequence.onResult)
      } else {
        sequence.on('end', () => {
          span.finish()
        })
      }

      return sequence
    }
  }
}

function wrapCallback (tracer, span, parent, done) {
  return tracer.scope().bind((err, res) => {
    if (err) {
      span.addTags({
        'error.type': err.name,
        'error.msg': err.message,
        'error.stack': err.stack
      })
    }

    span.finish()

    done(err, res)
  }, parent)
}

function patchConnection (Connection, tracer, config) {
  this.wrap(Connection.prototype, 'query', createWrapQuery(tracer, config))
}

function unpatchConnection (Connection) {
  this.unwrap(Connection.prototype, 'query')
}

module.exports = [
  {
    name: 'mysql2',
    file: 'lib/connection.js',
    versions: ['>=1'],
    patch: patchConnection,
    unpatch: unpatchConnection
  }
]
