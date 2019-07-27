'use strict'

const Tags = require('../../../ext/tags')
const TEXT_MAP = require('../../../ext/formats').TEXT_MAP
const kinds = require('./kinds')
const { addMethodTags, addMetadataTags, getFilter } = require('./util')

function handleError (span, err) {
  span.addTags({
    'error.msg': err.message,
    'error.stack': err.stack,
    'error.type': err.name
  })
}

function createWrapHandler (grpc, tracer, config, handler) {
  const configMetadata = getFilter(config, 'metadata')

  return function wrapHandler (func) {
    return function funcWithTrace (call, callback) {
      const metadata = call.metadata
      const request = call.request
      const type = this.type
      const isStream = type !== 'unary'
      const scope = tracer.scope()
      const childOf = tracer.extract(TEXT_MAP, metadata.getMap())
      const span = tracer.startSpan('grpc.request', {
        childOf,
        tags: {
          [Tags.SPAN_KIND]: 'server',
          'resource.name': handler,
          'service.name': config.service || `${tracer._service}`,
          'component': 'grpc'
        }
      })

      addMethodTags(span, handler, kinds[type])

      if (request && metadata) {
        addMetadataTags(span, metadata, configMetadata, 'request')
      }

      scope.bind(call)

      // Finish the span if the call was cancelled.
      call.on('cancelled', () => {
        span.setTag('grpc.status.code', grpc.status.CANCELLED)
        span.finish()
      })

      if (isStream) {
        call.on('error', err => {
          span.setTag('grpc.status.code', err.code)

          handleError(span, err)

          span.finish()
        })

        // Finish the span of the response only if it was successful.
        // Otherwise it'll be finished in the `error` listener.
        call.on('finish', () => {
          span.setTag('grpc.status.code', call.status.code)

          if (call.status.code === 0) {
            span.finish()
          }
        })

        // Call the original stream request, without modification.
        return scope.bind(func, span).apply(this, arguments)
      }

      // Call the unary request with a wrapped callback.
      return scope.bind(func, span).call(this, call, function (err, value, trailer, flags) {
        if (err) {
          if (err.code) {
            span.setTag('grpc.status.code', err.code)
          }

          handleError(span, err)
        } else {
          span.setTag('grpc.status.code', grpc.status.OK)
        }

        if (trailer && configMetadata) {
          addMetadataTags(span, trailer, configMetadata, 'response')
        }

        span.finish()

        if (callback) {
          scope.bind(callback, childOf).apply(this, arguments)
        }
      })
    }
  }
}

function createWrapRegister (tracer, config, grpc) {
  config = config.server || config

  return function wrapRegister (register) {
    return function registerWithTrace (name, handler, serialize, deserialize, type) {
      arguments[1] = createWrapHandler(grpc, tracer, config, name)(handler)

      return register.apply(this, arguments)
    }
  }
}

module.exports = [
  {
    name: 'grpc',
    versions: ['>=1.13'],
    patch (grpc) {
      grpc.Server._datadog = { grpc }
    },
    unpatch (grpc) {
      delete grpc.Server._datadog
    }
  },
  {
    name: 'grpc',
    versions: ['>=1.13'],
    file: 'src/server.js',
    patch (server, tracer, config) {
      const grpc = server.Server._datadog.grpc

      this.wrap(server.Server.prototype, 'register', createWrapRegister(tracer, config, grpc))
    },
    unpatch (server) {
      this.unwrap(server.Server.prototype, 'register')
    }
  }
]
