'use strict'

const Tags = require('opentracing').Tags
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

function createWrapQuery (tracer, config) {
  return function wrapQuery (query) {
    return function queryWithTrace (sql, values, cb) {
      const command = query.apply(this, arguments)

      return wrapCommand(tracer, config, command, command.sql)
    }
  }
}

function createWrapExecute (tracer, config) {
  return function wrapExecute (execute) {
    return function executeWithTrace (sql, values, cb) {
      const command = execute.apply(this, arguments)

      return wrapCommand(tracer, config, command, command.sql)
    }
  }
}

function createWrapPrepare (tracer, config) {
  return function wrapPrepare (prepare) {
    return function prepareWithTrace (options, cb) {
      return prepare.call(this, options, function (err, statement) {
        if (err) return cb.apply(this, arguments)

        const execute = statement.execute

        statement.execute = function executeWithTrace (packet, connection) {
          const command = execute.apply(this, arguments)

          return wrapCommand(tracer, config, command, command.statement.query)
        }

        return cb.call(this, err, statement)
      })
    }
  }
}

function wrapCommand (tracer, config, command, sql) {
  const execute = command.execute
  const scope = tracer.scope()
  const childOf = scope.active()

  command.execute = function executeWithTrace (packet, connection) {
    const span = tracer.startSpan('mysql.query', {
      childOf,
      tags: {
        [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
        'service.name': config.service || `${tracer._service}-mysql`,
        'span.type': 'sql',
        'db.type': 'mysql',
        'db.user': connection.config.user,
        'out.host': connection.config.host,
        'out.port': connection.config.port
      }
    })

    if (connection.config.database) {
      span.setTag('db.name', connection.config.database)
    }

    analyticsSampler.sample(span, config.analytics)

    const result = scope.bind(execute, span).apply(this, arguments)

    span.setTag('resource.name', sql)

    if (this.onResult) {
      this.onResult = wrapCallback(tracer, span, childOf, this.onResult)
    } else {
      this.on('end', () => {
        span.finish()
      })
    }

    return result
  }

  return command
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
  this.wrap(Connection.prototype, 'execute', createWrapExecute(tracer, config))
  this.wrap(Connection.prototype, 'prepare', createWrapPrepare(tracer, config))
}

function unpatchConnection (Connection) {
  this.unwrap(Connection.prototype, 'query')
  this.unwrap(Connection.prototype, 'execute')
  this.unwrap(Connection.prototype, 'prepare')
}

module.exports = [
  {
    name: 'mysql2',
    file: 'lib/connection.js',
    versions: ['>=1'],
    patch: patchConnection,
    unpatch: unpatchConnection
  },
  {
    name: 'mysql2',
    file: 'lib/commands/command.js',
    versions: ['>=1'],
    patch (Command, tracer, config) {
      tracer.scope().bind(Command.prototype)
    },
    unpatch (Command, tracer) {
      tracer.scope().unbind(Command.prototype)
    }
  }
]
