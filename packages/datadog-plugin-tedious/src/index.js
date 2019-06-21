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
      const span = tracer.startSpan(`tedious.request`, {
        childOf,
        tags: {
          [Tags.SPAN_KIND]: Kinds.CLIENT,
          'db.type': 'mssql',
          'service.name': config.service || `${tracer._service}-mssql`,
          'resource.name': request.parametersByName.statement.value,
          'span.type': 'sql',
          'component': 'tedious'
        }
      })

      analyticsSampler.sample(span, config.analytics)
      request.userCallback = tx.wrap(span, request.userCallback)
      const res = scope.bind(makeRequest, span).apply(this, arguments)

      addConnectionTags(span, connectionConfig)
      addDatabaseTags(span, connectionConfig)

      return res
    }
  }
}

function addConnectionTags (span, connectionConfig) {
  span.setTag('out.host', connectionConfig.server)

  const instanceName = connectionConfig.options.instanceName
  if (instanceName) {
    span.setTag('db.instance', instanceName)
  } else {
    span.setTag('out.port', connectionConfig.options.port)
  }
}

function addDatabaseTags (span, connectionConfig) {
  const userName = connectionConfig.userName || connectionConfig.authentication.options.userName

  if (userName) {
    span.setTag('db.user', userName)
  }

  const database = connectionConfig.options.database
  if (database) {
    span.setTag('db.name', database)
  }
}

module.exports = [
  {
    name: 'tedious',
    versions: ['>=3'],
    patch (tedious, tracer, config) {
      this.wrap(tedious.Connection.prototype, 'makeRequest', createWrapMakeRequest(tracer, config))
    },
    unpatch (tedious) {
      this.unwrap(tedious.Connection.prototype, 'makeRequest')
    }
  }
]
