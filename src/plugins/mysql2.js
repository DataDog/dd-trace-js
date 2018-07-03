'use strict'

const Tags = require('opentracing').Tags

function createWrapQuery (tracer, config) {
  return function wrapQuery (query) {
    return function queryWithTrace (sql, values, cb) {
      let span

      tracer.trace('mysql.query', {
        tags: {
          [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
          [Tags.DB_TYPE]: 'mysql'
        }
      }, child => {
        span = child
      })

      const sequence = query.call(this, sql, values, cb)

      span.setTag('service.name', config.service || 'mysql')
      span.setTag('resource.name', sequence.sql)
      span.setTag('out.host', this.config.host)
      span.setTag('out.port', String(this.config.port))
      span.setTag('span.type', 'sql')
      span.setTag('db.user', this.config.user)

      if (this.config.database) {
        span.setTag('db.name', this.config.database)
      }

      tracer.bindEmitter(sequence)

      if (sequence.onResult) {
        sequence.onResult = wrapCallback(tracer, span, sequence.onResult)
      } else {
        sequence.on('end', () => {
          span.finish()
        })
      }

      return sequence
    }
  }
}

function wrapCallback (tracer, span, done) {
  return tracer.bind((err, res) => {
    if (err) {
      span.addTags({
        'error.type': err.name,
        'error.msg': err.message,
        'error.stack': err.stack
      })
    }

    span.finish()

    done(err, res)
  })
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
    versions: ['^1.5'],
    patch: patchConnection,
    unpatch: unpatchConnection
  }
]
