'use strict'

const Tags = require('opentracing').Tags
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

function createWrapAddCommand (tracer, config) {
  return function wrapAddCommand (addCommand) {
    return function addCommandWithTrace (cmd) {
      const name = cmd && cmd.constructor && cmd.constructor.name
      const isCommand = typeof cmd.execute === 'function'
      const isSupported = name === 'Execute' || name === 'Query'

      if (isCommand && isSupported) {
        cmd.execute = wrapExecute(tracer, config, cmd.execute)
      }

      return addCommand.apply(this, arguments)
    }
  }
}

function wrapExecute (tracer, config, execute) {
  const scope = tracer.scope()
  const childOf = scope.active()

  return function executeWithTrace (packet, connection) {
    const connectionConfig = (connection && connection.config) || {}
    const sql = this.statement ? this.statement.query : this.sql
    const span = tracer.startSpan('mysql.query', {
      childOf,
      tags: {
        [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
        'service.name': config.service || `${tracer._service}-mysql`,
        'span.type': 'sql',
        'db.type': 'mysql',
        'db.user': connectionConfig.user,
        'out.host': connectionConfig.host,
        'out.port': connectionConfig.port
      }
    })

    if (connectionConfig.database) {
      span.setTag('db.name', connectionConfig.database)
    }

    analyticsSampler.sample(span, config.analytics)

    const result = scope.bind(execute, span).apply(this, arguments)

    span.setTag('resource.name', sql)

    if (typeof this.onResult === 'function') {
      this.onResult = wrapCallback(tracer, span, childOf, this.onResult)
    } else {
      this.on('end', () => {
        span.finish()
      })
    }

    this.execute = execute

    return result
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

module.exports = [
  {
    name: 'mysql2',
    file: 'lib/connection.js',
    versions: ['>=1'],
    patch (Connection, tracer, config) {
      this.wrap(Connection.prototype, 'addCommand', createWrapAddCommand(tracer, config))
    },
    unpatch (Connection) {
      this.unwrap(Connection.prototype, 'addCommand')
    }
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
