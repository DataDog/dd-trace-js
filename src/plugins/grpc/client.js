'use strict'

const log = require('../../log')
const pick = require('lodash.pick')
const Tags = require('../../../ext/tags')
const TEXT_MAP = require('../../../ext/formats').TEXT_MAP

function getFilter (config, filter) {
  if (typeof config[filter] === 'function') {
    return config[filter]
  }

  if (config[filter] instanceof Array) {
    return element => pick(element, config[filter])
  }

  if (config.hasOwnProperty(filter)) {
    log.error(`Expected '${filter}' to be an array or function.`)
  }

  return null
}

function getMethodType (definition) {
  if (definition.requestStream) {
    if (definition.responseStream) {
      return 'bidi'
    }

    return 'client_stream'
  }

  if (definition.responseStream) {
    return 'server_stream'
  }

  return 'unary'
}

function patch (grpc, tracer, config) {
  if (config.client === false) return

  config = config.client || config

  const configFields = getFilter(config, 'fields')
  const configMetadata = getFilter(config, 'metadata')

  function datadogInterceptor (options, nextCall) {
    const path = options.method_definition.path
    const methodParts = path.split('/')
    const methodType = getMethodType(options.method_definition)
    const scope = tracer.scopeManager().active()
    const span = tracer.startSpan('grpc.request', {
      childOf: scope && scope.span(),
      tags: {
        [Tags.SPAN_KIND]: 'client',
        'grpc.method.name': methodParts[2],
        'grpc.method.service': methodParts[1],
        'grpc.method.path': path,
        'grpc.method.type': methodType,
        'resource.name': path,
        'service.name': config.service || `${tracer._service}-grpc-client`
      }
    })

    tracer.scopeManager().activate(span)

    return new grpc.InterceptingCall(nextCall(options), {
      sendMessage: (message, next) => {
        if (configFields) {
          const values = configFields(message)

          for (const key in values) {
            span.setTag(`grpc.request.message.fields.${key}`, values[key])
          }
        }

        next(message)
      },

      cancel: () => {
        span.setTag('grpc.status.code', grpc.status.CANCELLED)
        span.finish()
      },

      start: (metadata, _listener, next) => {
        if (configMetadata && metadata) {
          const values = configMetadata(metadata.getMap())

          for (const key in values) {
            span.setTag(`grpc.request.metadata.${key}`, values[key])
          }
        }

        // Inject tracing headers into the grpc call's metadata.
        const tracingMetadata = metadata || new grpc.Metadata()
        const meta = {}

        tracer.inject(span, TEXT_MAP, meta)

        for (const key in meta) {
          tracingMetadata.set(key, meta[key])
        }

        next(tracingMetadata, {
          onReceiveStatus: (status, next) => {
            if (status.code !== 0) {
              span.addTags({
                'error.msg': status.details,
                'error.type': 'Error'
              })
            }

            if (configMetadata) {
              const values = configMetadata(status.metadata.getMap())

              for (const key in values) {
                span.setTag(`grpc.response.metadata.${key}`, values[key])
              }
            }

            span.setTag('grpc.status.code', status.code)
            span.finish()

            next(status)
          }
        })
      }
    })
  }

  this.wrap(grpc.Client.prototype, 'resolveCallInterceptors', resolveCallInterceptors => {
    return function resolveCallInterceptorsWithTrace () {
      return [datadogInterceptor].concat(resolveCallInterceptors.call(this, arguments))
    }
  })
}

function unpatch (grpc) {
  this.unwrap(grpc.Client.prototype, 'resolveCallInterceptors')
}

module.exports = [{
  name: 'grpc',
  versions: ['>=1.13'],
  patch,
  unpatch
}]
