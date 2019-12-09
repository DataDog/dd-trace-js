'use strict'

const Tags = require('../../../ext/tags')
const { TEXT_MAP } = require('../../../ext/formats')
const { ERROR } = require('../../../ext/tags')
const kinds = require('./kinds')
const { addMethodTags, addMetadataTags, getFilter } = require('./util')

// https://github.com/grpc/grpc/blob/master/doc/statuscodes.md
const OK = 0
const CANCELLED = 1

function createWrapHandler (tracer, config, handler) {
  const filter = getFilter(config, 'metadata')

  return function wrapHandler (func) {
    const isValid = (server, args) => {
      if (!server || !server.type) return false
      if (!args[0]) return false
      if (server.type !== 'unary' && !isEmitter(args[0])) return false
      if (server.type === 'unary' && typeof args[1] !== 'function') return false

      return true
    }

    return function funcWithTrace (call, callback) {
      if (!isValid(this, arguments)) return func.apply(this, arguments)

      const metadata = call.metadata
      const type = this.type
      const isStream = type !== 'unary'
      const scope = tracer.scope()
      const childOf = extract(tracer, metadata)
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
      addMetadataTags(span, metadata, filter, 'request')

      scope.bind(call)

      // Finish the span if the call was cancelled.
      call.once('cancelled', () => {
        span.setTag('grpc.status.code', CANCELLED)
        span.finish()
      })

      if (isStream) {
        wrapStream(span, call)
      } else {
        arguments[1] = wrapCallback(span, callback, filter, childOf)
      }

      return scope.bind(func, span).apply(this, arguments)
    }
  }
}

function createWrapRegister (tracer, config) {
  config = config.server || config

  return function wrapRegister (register) {
    return function registerWithTrace (name, handler, serialize, deserialize, type) {
      if (typeof handler === 'function') {
        arguments[1] = createWrapHandler(tracer, config, name)(handler)
      }

      return register.apply(this, arguments)
    }
  }
}

function wrapStream (span, call) {
  const emit = call.emit

  call.emit = function (eventName, ...args) {
    switch (eventName) {
      case 'error':
        span.addTags({
          [ERROR]: args[0] || 1,
          'grpc.status.code': args[0] && args[0].code
        })

        span.finish()

        break

      // Finish the span of the response only if it was successful.
      // Otherwise it'll be finished in the `error` listener.
      case 'finish':
        span.setTag('grpc.status.code', call.status && call.status.code)

        if (!call.status || call.status.code === 0) {
          span.finish()
        }

        break
    }

    return emit.apply(this, arguments)
  }
}

function wrapCallback (span, callback, filter, childOf) {
  const scope = span.tracer().scope()

  return function (err, value, trailer, flags) {
    if (err instanceof Error) {
      if (err.code) {
        span.setTag('grpc.status.code', err.code)
      }

      span.setTag(ERROR, err)
    } else {
      span.setTag('grpc.status.code', OK)
    }

    if (trailer && filter) {
      addMetadataTags(span, trailer, filter, 'response')
    }

    span.finish()

    if (callback) {
      return scope.bind(callback, childOf).apply(this, arguments)
    }
  }
}

function extract (tracer, metadata) {
  if (!metadata || typeof metadata.getMap !== 'function') return null

  return tracer.extract(TEXT_MAP, metadata.getMap())
}

function isEmitter (obj) {
  return typeof obj.emit === 'function' && typeof obj.once === 'function'
}

module.exports = [
  {
    name: 'grpc',
    versions: ['>=1.13'],
    file: 'src/server.js',
    patch (server, tracer, config) {
      if (config.server === false) return

      this.wrap(server.Server.prototype, 'register', createWrapRegister(tracer, config))
    },
    unpatch (server) {
      this.unwrap(server.Server.prototype, 'register')
    }
  }
]
