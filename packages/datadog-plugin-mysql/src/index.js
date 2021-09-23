'use strict'

const Tags = require('opentracing').Tags
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

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
          'span.kind': 'client',
          'db.type': 'mysql',
          'db.user': this.config.user,
          'out.host': this.config.host,
          'out.port': this.config.port
        }
      })

      if (this.config.database) {
        span.setTag('db.name', this.config.database)
      }

      analyticsSampler.sample(span, config.measured)

      const sequence = scope.bind(query, span).apply(this, arguments)

      scope.bind(sequence)

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

function createWrapGetConnection (tracer, config) {
  return function wrapGetConnection (getConnection) {
    return function getConnectionWithTrace (cb) {
      const scope = tracer.scope()

      arguments[0] = scope.bind(cb)

      return scope.bind(getConnection).apply(this, arguments)
    }
  }
}

function wrapCallback (tracer, span, parent, done) {
  return tracer.scope().bind((...args) => {
    const err = args[0]
    if (err) {
      span.addTags({
        'error.type': err.name,
        'error.msg': err.message,
        'error.stack': err.stack
      })
    }

    span.finish()

    done(...args)
  }, parent)
}

function patchConnection (Connection, tracer, config) {
  this.wrap(Connection.prototype, 'query', createWrapQuery(tracer, config))
}

function unpatchConnection (Connection) {
  this.unwrap(Connection.prototype, 'query')
}

function patchPool (Pool, tracer, config) {
  this.wrap(Pool.prototype, 'getConnection', createWrapGetConnection(tracer, config))
}

function unpatchPool (Pool) {
  this.unwrap(Pool.prototype, 'getConnection')
}

module.exports = [
  {
    name: 'mysql',
    file: 'lib/Connection.js',
    versions: ['>=2'],
    patch: patchConnection,
    unpatch: unpatchConnection
  },
  {
    name: 'mysql',
    file: 'lib/Pool.js',
    versions: ['>=2'],
    patch: patchPool,
    unpatch: unpatchPool
  }
]
