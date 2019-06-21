'use strict'

const Tags = require('opentracing').Tags
const analyticsSampler = require('../../dd-trace/src/analytics_sampler')

function createWrapMakeRequest (tracer, config) {
  return function wrapMakeRequest (makeRequest) {
    return function makeRequestWithTrace (request) {
      const connectionConfig = this.config
      const scope = tracer.scope()
      const childOf = scope.active()
      const span = tracer.startSpan(`tedious.request`, {
        childOf,
        tags: {
          [Tags.SPAN_KIND]: Tags.SPAN_KIND_RPC_CLIENT,
          'db.type': 'mssql',
          'service.name': config.service || `${tracer._service}-mssql`,
          'resource.name': request.parametersByName.statement.value,
          'span.type': 'tedious'
        }
      })

      analyticsSampler.sample(span, config.analytics)
      request.userCallback = wrapCallback(tracer, span, childOf, request.userCallback)
      const res = scope.bind(makeRequest, span).apply(this, arguments)

      addConnectionTags(span, connectionConfig)
      return res
    }
  }
}

function addConnectionTags (span, connectionConfig) {
  span.setTag('out.host', connectionConfig.server)

  // If instanceName is defined, the config.options.port is undefined and so we must find it
  const instanceName = connectionConfig.options.instanceName
  if (instanceName) {
    span.setTag('out.instance.name', instanceName)
  } else {
    span.setTag('out.port', connectionConfig.options.port)
  }

  const database = connectionConfig.options.database
  if (database) {
    span.setTag('db.name', database)
  }

  let userName
  if (connectionConfig.userName) {
    userName = connectionConfig.userName
  } else {
    userName = connectionConfig.authentication.options.userName
  }

  if (userName) {
    span.setTag('db.user', userName)
  }
}

function wrapCallback (tracer, span, parent, callback) {
  return function (err) {
    if (err) {
      span.addTags({
        'error.type': err.name,
        'error.msg': err.message,
        'error.stack': err.stack
      })
    }

    span.finish()
    if (callback) {
      return tracer.scope().activate(parent, () => callback.apply(this, arguments))
    }
  }
}

module.exports = [
  {
    name: 'tedious',
    file: 'lib/tedious.js',
    versions: ['>=3'],
    patch (tedious, tracer, config) {
      this.wrap(tedious.Connection.prototype, 'makeRequest', createWrapMakeRequest(tracer, config))
    },
    unpatch (tedious, tracer, config) {
      this.unwrap(tedious.Connection.prototype, 'makeRequest')
    }
  }
]
