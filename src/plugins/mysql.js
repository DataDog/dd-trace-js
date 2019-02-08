'use strict'

const Tags = require('opentracing').Tags

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

      const sequence = scope.bind(query, span).call(this, sql, values, cb)

      span.setTag('resource.name', sequence.sql)

      if (sequence._callback) {
        sequence._callback = wrapCallback(tracer, span, childOf, sequence._callback)
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
    name: 'mysql',
    file: 'lib/Connection.js',
    versions: ['>=2'],
    patch: patchConnection,
    unpatch: unpatchConnection
  }
]
