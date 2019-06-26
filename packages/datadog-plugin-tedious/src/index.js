'use strict'

const Tags = require('../../../ext/tags')
const Kinds = require('../../../ext/kinds')

const analyticsSampler = require('../../dd-trace/src/analytics_sampler')
const tx = require('../../dd-trace/src/plugins/util/tx')

const SQL_BATCH = 1
const RPC_REQUEST = 3
const BULK_LOAD = 7

const SUPPORTED_TYPES = [SQL_BATCH, RPC_REQUEST, BULK_LOAD]

function createWrapRequestClass (tracer) {
  return function wrapRequestClass (Request) {
    class RequestWithTrace extends Request {
      constructor (sqlTextOrProcedure, callback) {
        super(sqlTextOrProcedure, callback)
        tracer.scope().bind(this)
      }
    }

    return RequestWithTrace
  }
}

function createWrapConnectionClass (tracer) {
  return function wrapConnectionClass (Connection) {
    class ConnectionWithTrace extends Connection {
      constructor (config) {
        super(config)
        tracer.scope().bind(this)
      }
    }

    return ConnectionWithTrace
  }
}

function createWrapMakeRequest (tracer, config) {
  return function wrapMakeRequest (makeRequest) {
    return function makeRequestWithTrace (request, packetType) {
      const connectionConfig = this.config
      const scope = tracer.scope()
      const childOf = scope.active()

      if (!SUPPORTED_TYPES.includes(packetType)) {
        return scope.activate(childOf, () => makeRequest.apply(this, arguments))
      }

      const span = tracer.startSpan(`tedious.request`, {
        childOf,
        tags: {
          [Tags.SPAN_KIND]: Kinds.CLIENT,
          'db.type': 'mssql',
          'service.name': config.service || `${tracer._service}-mssql`,
          'span.type': 'sql',
          'component': 'tedious'
        }
      })

      addResourceTag(span, request, packetType)
      addConnectionTags(span, connectionConfig)
      addDatabaseTags(span, connectionConfig)
      analyticsSampler.sample(span, config.analytics)

      if (packetType === BULK_LOAD) {
        request.callback = tx.wrap(span, request.callback)
      } else {
        request.userCallback = tx.wrap(span, request.userCallback)
      }

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

function addResourceTag (span, request, packetType) {
  if (packetType === BULK_LOAD) {
    span.setTag('resource.name', request.table)
  } else if (request.parameters.length === 0) {
    span.setTag('resource.name', request.sqlTextOrProcedure)
  } else {
    span.setTag('resource.name', request.parametersByName.statement.value)
  }
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
      this.wrap(tedious, 'Request', createWrapRequestClass(tracer))
      this.wrap(tedious, 'Connection', createWrapConnectionClass(tracer))

      this.wrap(tedious.Connection.prototype, 'makeRequest', createWrapMakeRequest(tracer, config))

      if (tedious.BulkLoad && tedious.BulkLoad.prototype.getRowStream) {
        this.wrap(tedious.BulkLoad.prototype, 'getRowStream', createWrapGetRowStream(tracer))
      }
    },
    unpatch (tedious) {
      this.unwrap(tedious.Connection.prototype, 'makeRequest')
    }
  }
]
