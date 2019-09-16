'use strict'

const Tags = require('../../../ext/tags')
const { TEXT_MAP } = require('../../../ext/formats')
const { ERROR } = require('../../../ext/tags')
const kinds = require('./kinds')
const { addMethodTags, addMetadataTags, getFilter } = require('./util')

function createWrapHandler (server, tracer, config, handler) {
  const filter = getFilter(config, 'metadata')

  return function wrapHandler (func) {
    return function funcWithTrace (call, callback) {
      const grpc = server.Server._datadog.grpc
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
        addMetadataTags(span, metadata, filter, 'request')
      }

      scope.bind(call)

      // Finish the span if the call was cancelled.
      call.once('cancelled', () => {
        span.setTag('grpc.status.code', grpc.status.CANCELLED)
        span.finish()
      })

      if (isStream) {
        wrapStream(span, call)
      } else {
        arguments[1] = wrapCallback(span, callback, filter, grpc, childOf)
      }

      return scope.bind(func, span).apply(this, arguments)
    }
  }
}

function createWrapRegister (tracer, config, server) {
  config = config.server || config

  return function wrapRegister (register) {
    return function registerWithTrace (name, handler, serialize, deserialize, type) {
      arguments[1] = createWrapHandler(server, tracer, config, name)(handler)

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
          [ERROR]: args[0],
          'grpc.status.code': args[0].code
        })

        span.finish()

        break

      // Finish the span of the response only if it was successful.
      // Otherwise it'll be finished in the `error` listener.
      case 'finish':
        span.setTag('grpc.status.code', call.status.code)

        if (call.status.code === 0) {
          span.finish()
        }

        break
    }

    return emit.apply(this, arguments)
  }
}

function wrapCallback (span, callback, filter, grpc, childOf) {
  const scope = span.tracer().scope()

  return function (err, value, trailer, flags) {
    if (err) {
      if (err.code) {
        span.setTag('grpc.status.code', err.code)
      }

      span.setTag(ERROR, err)
    } else {
      span.setTag('grpc.status.code', grpc.status.OK)
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

module.exports = [
  {
    name: 'grpc',
    versions: ['>=1.13'],
    patch (grpc, tracer, config) {
      if (config.server === false) return

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
      if (config.server === false) return

      this.wrap(server.Server.prototype, 'register', createWrapRegister(tracer, config, server))
    },
    unpatch (server) {
      this.unwrap(server.Server.prototype, 'register')
    }
  }
]
