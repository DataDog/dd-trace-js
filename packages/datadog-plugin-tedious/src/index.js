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

      addConnectionTags(span, connectionConfig)
      addDatabaseTags(span, connectionConfig)

      analyticsSampler.sample(span, config.analytics)
      request.userCallback = tx.wrap(span, request.userCallback)

      return scope.bind(makeRequest, span).apply(this, arguments)
    }
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
    versions: ['>=3'],
    patch (tedious, tracer, config) {
      this.wrap(tedious.Connection.prototype, 'makeRequest', createWrapMakeRequest(tracer, config))
    },
    unpatch (tedious) {
      this.unwrap(tedious.Connection.prototype, 'makeRequest')
    }
  }
]
