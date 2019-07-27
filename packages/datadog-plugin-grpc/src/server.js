'use strict'

const Tags = require('../../../ext/tags')
const TEXT_MAP = require('../../../ext/formats').TEXT_MAP
const kinds = require('./kinds')
const { addMethodTags, addMetadataTags, getFilter } = require('./util')

function handleError (config, span, err) {
  span.addTags({
    'error.msg': err.message,
    'error.stack': err.stack,
    'error.type': err.name
  })
}

function createWrapHandler (grpc, tracer, config, handler) {
  const configMetadata = getFilter(config, 'metadata')

  return function wrapHandler (func) {
    return function funcWithTrace (emitter, callback) {
      const metadata = emitter.metadata
      const request = emitter.request
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

      if (request) {
        if (configMetadata && metadata) {
          addMetadataTags(span, metadata, configMetadata, 'request')
        }
      }

      scope.bind(emitter)

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
      return scope.bind(func, span).call(this, emitter, (err, value, trailer, flags) => {
        if (err) {
          if (err.code) {
            span.setTag('grpc.status.code', err.code)
          }

          handleError(config, span, err)
        } else {
          span.setTag('grpc.status.code', grpc.status.OK)
        }

        if (trailer && configMetadata) {
          addMetadataTags(span, trailer, configMetadata, 'response')
        }

        span.finish()

        if (callback) {
          scope.bind(callback, childOf).call(this, value, trailer, flags)
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
