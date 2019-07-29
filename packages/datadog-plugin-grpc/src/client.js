'use strict'

const Tags = require('../../../ext/tags')
const TEXT_MAP = require('../../../ext/formats').TEXT_MAP
const kinds = require('./kinds')
const { addMethodTags, addMetadataTags, getFilter } = require('./util')

function createWrapMakeClientConstructor (tracer, config, grpc) {
  config = config.client || config

  return function wrapMakeClientConstructor (makeClientConstructor) {
    return function makeClientConstructorWithTrace (methods) {
      const ServiceClient = makeClientConstructor.apply(this, arguments)
      const proto = ServiceClient.prototype

      Object.keys(methods)
        .forEach(method => {
          const originalName = methods[method].originalName

          proto[method] = wrapMethod(proto[method], methods[method], tracer, config, grpc)

          if (originalName) {
            proto[originalName] = wrapMethod(proto[originalName], methods[originalName], tracer, config, grpc)
          }
        })

      return ServiceClient
    }
  }
}

function wrapMethod (method, definition, tracer, config, grpc) {
  if (typeof method !== 'function' || !definition.path) return method

  const filter = getFilter(config, 'metadata')

  const methodWithTrace = function methodWithTrace () {
    const args = ensureMetadata(arguments, grpc)
    const length = args.length
    const metadata = args[1]
    const callback = args[length - 1]
    const scope = tracer.scope()
    const span = startSpan(tracer, config, definition, filter)

    addMetadataTags(span, metadata, filter, 'request')

    inject(tracer, span, metadata)

    if (!definition.responseStream) {
      if (typeof callback === 'function') {
        args[length - 1] = wrapCallback(span, callback)
      } else {
        args[length] = wrapCallback(span)
      }
    }

    const call = scope.bind(method, span).apply(this, args)

    call.once('error', err => span.setTag('error', err))
    call.once('status', status => {
      span.setTag('grpc.status.code', status.code)

      addMetadataTags(span, status.metadata, filter, 'response')

      span.finish()
    })

    return scope.bind(call)
  }

  Object.assign(methodWithTrace, method)

  return methodWithTrace
}

function wrapCallback (span, callback) {
  const scope = span.tracer().scope()
  const parent = scope.active()

  return function (err) {
    err && span.setTag('error', err)

    if (callback) {
      return scope.bind(callback, parent).apply(this, arguments)
    }
  }
}

function startSpan (tracer, config, definition) {
  const path = definition.path
  const methodKind = getMethodKind(definition)
  const scope = tracer.scope()
  const childOf = scope.active()
  const span = tracer.startSpan('grpc.request', {
    childOf,
    tags: {
      [Tags.SPAN_KIND]: 'client',
      'resource.name': path,
      'service.name': config.service || `${tracer._service}-grpc-client`,
      'component': 'grpc'
    }
  })

  addMethodTags(span, path, methodKind)

  return span
}

function ensureMetadata (args, grpc) {
  const normalized = [args[0]]

  if (!args[1] || args[1].constructor.name !== 'Metadata') {
    normalized.push(new grpc.Metadata())
  }

  for (let i = 1; i < args.length; i++) {
    normalized.push(args[i])
  }

  return normalized
}

function inject (tracer, span, metadata) {
  const carrier = {}

  tracer.inject(span, TEXT_MAP, carrier)

  for (const key in carrier) {
    metadata.set(key, carrier[key])
  }
}

function getMethodKind (definition) {
  if (definition.requestStream) {
    if (definition.responseStream) {
      return kinds.bidi
    }

    return kinds.client_stream
  }

  if (definition.responseStream) {
    return kinds.server_stream
  }

  return kinds.unary
}

module.exports = [
  {
    name: 'grpc',
    versions: ['>=1.13'],
    patch (grpc) {
      grpc.Client._datadog = { grpc }
    },
    unpatch (grpc) {
      delete grpc.Client._datadog
    }
  },
  {
    name: 'grpc',
    versions: ['>=1.13'],
    file: 'src/client.js',
    patch (client, tracer, config) {
      const grpc = client.Client._datadog.grpc

      this.wrap(client, 'makeClientConstructor', createWrapMakeClientConstructor(tracer, config, grpc))
    },
    unpatch (client) {
      this.unwrap(client, 'makeClientConstructor')
    }
  }
]
