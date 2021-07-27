'use strict'

const Tags = require('../../../ext/tags')
const Kinds = require('../../../ext/kinds')
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const tx = require('../../dd-trace/src/plugins/util/tx')

function createWrapMakeRequest (tracer, config) {
  return function wrapMakeRequest (makeRequest) {
    return function makeRequestWithTrace (request) {
      const connectionConfig = this.config
      const scope = tracer.scope()
      const childOf = scope.active()
      const queryOrProcedure = getQueryOrProcedure(request)

      if (!queryOrProcedure) {
        return makeRequest.apply(this, arguments)
      }

      const span = tracer.startSpan('tedious.request', {
        childOf,
        tags: {
          [Tags.SPAN_KIND]: Kinds.CLIENT,
          'db.type': 'mssql',
          'span.type': 'sql',
          'component': 'tedious',
          'service.name': config.service || `${tracer._service}-mssql`,
          'resource.name': queryOrProcedure
        }
      })

      addConnectionTags(span, connectionConfig)
      addDatabaseTags(span, connectionConfig)

      analyticsSampler.sample(span, config.measured)
      request.callback = tx.wrap(span, request.callback)

      return scope.bind(makeRequest, span).apply(this, arguments)
    }
  }
}

function createWrapGetRowStream (tracer) {
  return function wrapGetRowStream (getRowStream) {
    return function getRowStreamWithTrace () {
      const scope = tracer.scope()

      const rowToPacketTransform = getRowStream.apply(this, arguments)
      return scope.bind(rowToPacketTransform)
    }
  }
}

function getQueryOrProcedure (request) {
  if (!request.parameters) return

  const statement = request.parametersByName.statement || request.parametersByName.stmt

  if (!statement) {
    return request.sqlTextOrProcedure
  }

  return statement.value
}

function addConnectionTags (span, connectionConfig) {
  span.setTag('out.host', connectionConfig.server)
  span.setTag('out.port', connectionConfig.options.port)
}

function addDatabaseTags (span, connectionConfig) {
  span.setTag('db.user', connectionConfig.userName || connectionConfig.authentication.options.userName)
  span.setTag('db.name', connectionConfig.options.database)
  span.setTag('db.instance', connectionConfig.options.instanceName)
}

module.exports = [
  {
    name: 'tedious',
    versions: [ '>=1.0.0' ],
    patch (tedious, tracer, config) {
      this.wrap(tedious.Connection.prototype, 'makeRequest', createWrapMakeRequest(tracer, config))

      if (tedious.BulkLoad && tedious.BulkLoad.prototype.getRowStream) {
        this.wrap(tedious.BulkLoad.prototype, 'getRowStream', createWrapGetRowStream(tracer))
      }

      tracer.scope().bind(tedious.Request.prototype)
      tracer.scope().bind(tedious.Connection.prototype)
    },
    unpatch (tedious, tracer) {
      this.unwrap(tedious.Connection.prototype, 'makeRequest')

      if (tedious.BulkLoad) {
        this.unwrap(tedious.BulkLoad.prototype, 'getRowStream')
      }

      tracer.scope().unbind(tedious.Request.prototype)
      tracer.scope().unbind(tedious.Connection.prototype)
    }
  }
]
