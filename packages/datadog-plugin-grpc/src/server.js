'use strict'

const log = require('../../dd-trace/src/log')
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

function handleError (config, span, err) {
  span.addTags({
    'error.msg': err.message,
    'error.stack': err.stack,
    'error.type': err.name
  })
}

function createWrapHandler (grpc, tracer, config, handler) {
  const configFields = getFilter(config, 'fields')
  const configMetadata = getFilter(config, 'metadata')

  return function wrapHandler (func) {
    return function funcWithTrace (emitter, callback) {
      const metadata = emitter.metadata
      const request = emitter.request
      const type = this.type
      const methodParts = handler.split('/')
      const isStream = type !== 'unary'
      const childOf = tracer.extract(TEXT_MAP, metadata.getMap())
      const span = tracer.startSpan('grpc.request', {
        childOf,
        tags: {
          [Tags.SPAN_KIND]: 'server',
          'grpc.method.name': methodParts[2],
          'grpc.method.service': methodParts[1],
          'grpc.method.path': handler,
          'grpc.method.type': type,
          'resource.name': handler,
          'service.name': config.service || `${tracer._service}-grpc-server`
        }
      })

      tracer.scopeManager().activate(span)

      if (request) {
        if (configMetadata && metadata) {
          const values = configMetadata(metadata.getMap())

          for (const key in values) {
            span.setTag(`grpc.request.metadata.${key}`, values[key])
          }
        }

        if (configFields) {
          const values = configFields(request)

          for (const key in values) {
            span.setTag(`grpc.request.message.fields.${key}`, values[key])
          }
        }
      }

      // Finish the span if the call was cancelled.
      emitter.on('cancelled', () => {
        span.setTag('grpc.status.code', grpc.status.CANCELLED)
        span.finish()
      })

      if (isStream) {
        emitter.on('error', err => {
          span.setTag('grpc.status.code', err.code)

          handleError(config, span, err)

          span.finish()
        })

        // Finish the span of the response only if it was successful.
        // Otherwise it'll be finished in the `error` listener.
        emitter.on('finish', () => {
          span.setTag('grpc.status.code', emitter.status.code)

          if (emitter.status.code === 0) {
            span.finish()
          }
        })

        // Call the original stream request, without modification.
        return func.apply(this, arguments)
      }

      // Call the unary request with a wrapped callback.
      return func.call(this, emitter, (err, value, trailer, flags) => {
        if (err) {
          if (err.code) {
            span.setTag('grpc.status.code', err.code)
          }

          handleError(config, span, err)
        } else {
          span.setTag('grpc.status.code', grpc.status.OK)
        }

        if (trailer && configMetadata) {
          const values = configMetadata(trailer.getMap())

          for (const key in values) {
            span.setTag(`grpc.response.metadata.${key}`, values[key])
          }
        }

        span.finish()

        if (callback) {
          callback.call(this, value, trailer, flags)
        }
      })
    }
  }
}

function patch (grpc, tracer, config) {
  grpc._patchedHandlers = []

  if (config.server === false) return

  config = config.server || config

  const self = this

  this.wrap(grpc.Server.prototype, 'start', start => {
    return function startWithTrace () {
      start.call(this)

      for (const handler in this.handlers) {
        self.wrap(this.handlers[handler], 'func', createWrapHandler(grpc, tracer, config, handler))

        grpc._patchedHandlers.push(this.handlers[handler])
      }
    }
  })
}

function unpatch (grpc) {
  this.unwrap(grpc.Server.prototype, 'start')

  for (const handler of grpc._patchedHandlers) {
    this.unwrap(handler, 'func')
  }

  grpc._patchedHandlers = []
}

module.exports = {
  name: 'grpc',
  versions: ['>=1.13'],
  patch,
  unpatch
}
