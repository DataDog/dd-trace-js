'use strict'

const Tags = require('../../../ext/tags')
const { TEXT_MAP } = require('../../../ext/formats')
const { ERROR } = require('../../../ext/tags')
const kinds = require('./kinds')
const { addMethodTags, addMetadataTags, getFilter } = require('./util')

function createWrapMakeRequest (tracer, config, methodKind) {
  const filter = getFilter(config, 'metadata')

  return function wrapMakeRequest (makeRequest) {
    return function makeRequestWithTrace (path) {
      const args = ensureMetadata(this, arguments, 4)

      return callMethod(tracer, config, this, makeRequest, args, path, args[4], methodKind, filter)
    }
  }
}

function createWrapLoadPackageDefinition (tracer, config) {
  return function wrapLoadPackageDefinition (loadPackageDefinition) {
    return function loadPackageDefinitionWithTrace (packageDef) {
      const result = loadPackageDefinition.apply(this, arguments)

      if (!result) return result

      wrapPackageDefinition(tracer, config, result)

      return result
    }
  }
}

function createWrapMakeClientConstructor (tracer, config) {
  return function wrapMakeClientConstructor (makeClientConstructor) {
    return function makeClientConstructorWithTrace (methods) {
      const ServiceClient = makeClientConstructor.apply(this, arguments)

      wrapClientConstructor(tracer, config, ServiceClient, methods)

      return ServiceClient
    }
  }
}

function wrapPackageDefinition (tracer, config, def) {
  for (const name in def) {
    if (def[name].format) continue
    if (def[name].service && def[name].prototype) {
      wrapClientConstructor(tracer, config, def[name], def[name].service)
    } else {
      wrapPackageDefinition(tracer, config, def[name])
    }
  }
}

function wrapClientConstructor (tracer, config, ServiceClient, methods) {
  const proto = ServiceClient.prototype

  if (typeof methods !== 'object' || 'format' in methods) return

  Object.keys(methods)
    .forEach(name => {
      if (!methods[name]) return

      const originalName = methods[name].originalName
      const path = methods[name].path
      const methodKind = getMethodKind(methods[name])

      if (methods[name]) {
        proto[name] = wrapMethod(tracer, config, proto[name], path, methodKind)
      }

      if (originalName) {
        proto[originalName] = wrapMethod(tracer, config, proto[originalName], path, methodKind)
      }
    })
}

function wrapMethod (tracer, config, method, path, methodKind) {
  if (typeof method !== 'function' || method._datadog_patched) {
    return method
  }

  const filter = getFilter(config, 'metadata')

  const methodWithTrace = function methodWithTrace () {
    const args = ensureMetadata(this, arguments, 1)

    return callMethod(tracer, config, this, method, args, path, args[1], methodKind, filter)
  }

  Object.assign(methodWithTrace, method)

  methodWithTrace._datadog_patched = true

  return methodWithTrace
}

function wrapCallback (span, callback) {
  const scope = span.tracer().scope()
  const parent = scope.active()

  return function (err) {
    err && span.setTag(ERROR, err)

    if (callback) {
      return scope.bind(callback, parent).apply(this, arguments)
    }
  }
}

function wrapStream (span, call, filter) {
  if (!call || typeof call.emit !== 'function') return

  const emit = call.emit

  call.emit = function (eventName, ...args) {
    switch (eventName) {
      case 'error':
        span.setTag(ERROR, args[0] || 1)

        break
      case 'status':
        if (args[0]) {
          span.setTag('grpc.status.code', args[0].code)

          addMetadataTags(span, args[0].metadata, filter, 'response')
        }

        span.finish()

        break
    }

    return emit.apply(this, arguments)
  }
}

function callMethod (tracer, config, client, method, args, path, metadata, methodKind, filter) {
  const length = args.length
  const callback = args[length - 1]
  const scope = tracer.scope()
  const span = startSpan(tracer, config, path, methodKind)

  if (metadata) {
    addMetadataTags(span, metadata, filter, 'request')
    inject(tracer, span, metadata)
  }

  if (methodKind === kinds.unary || methodKind === kinds.client_stream) {
    if (typeof callback === 'function') {
      args[length - 1] = wrapCallback(span, callback)
    } else {
      args[length] = wrapCallback(span)
    }
  }

  const call = scope.bind(method, span).apply(client, args)

  wrapStream(span, call, filter)

  return scope.bind(call)
}

function startSpan (tracer, config, path, methodKind) {
  const scope = tracer.scope()
  const childOf = scope.active()
  const span = tracer.startSpan('grpc.request', {
    childOf,
    tags: {
      [Tags.SPAN_KIND]: 'client',
      'span.type': 'http',
      'resource.name': path,
      'service.name': config.service || `${tracer._service}-grpc-client`,
      'component': 'grpc'
    }
  })

  addMethodTags(span, path, methodKind)

  return span
}

function ensureMetadata (client, args, index) {
  if (!client || !client._datadog) return args

  const meta = args[index]
  const normalized = []

  for (let i = 0; i < index; i++) {
    normalized.push(args[i])
  }

  if (!meta || !meta.constructor || meta.constructor.name !== 'Metadata') {
    normalized.push(new client._datadog.grpc.Metadata())
  }

  if (meta) {
    normalized.push(meta)
  }

  for (let i = index + 1; i < args.length; i++) {
    normalized.push(args[i])
  }

  return normalized
}

function inject (tracer, span, metadata) {
  if (typeof metadata.set !== 'function') return

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

function patch (grpc, tracer, config) {
  if (config.client === false) return

  config = config.client || config

  const proto = grpc.Client.prototype

  proto._datadog = { grpc }

  this.wrap(proto, 'makeBidiStreamRequest', createWrapMakeRequest(tracer, config, kinds.bidi))
  this.wrap(proto, 'makeClientStreamRequest', createWrapMakeRequest(tracer, config, kinds.clientStream))
  this.wrap(proto, 'makeServerStreamRequest', createWrapMakeRequest(tracer, config, kinds.serverStream))
  this.wrap(proto, 'makeUnaryRequest', createWrapMakeRequest(tracer, config, kinds.unary))
}

function unpatch (grpc) {
  const proto = grpc.Client.prototype

  delete proto._datadog

  this.unwrap(proto, 'makeBidiStreamRequest')
  this.unwrap(proto, 'makeClientStreamRequest')
  this.unwrap(proto, 'makeServerStreamRequest')
  this.unwrap(proto, 'makeUnaryRequest')
}

module.exports = [
  {
    name: 'grpc',
    versions: ['>=1.13'],
    patch,
    unpatch
  },
  {
    name: 'grpc',
    versions: ['>=1.13'],
    file: 'src/client.js',
    patch (client, tracer, config) {
      if (config.client === false) return

      config = config.client || config

      this.wrap(client, 'makeClientConstructor', createWrapMakeClientConstructor(tracer, config))
    },
    unpatch (client) {
      this.unwrap(client, 'makeClientConstructor')
    }
  },
  {
    name: '@grpc/grpc-js',
    versions: ['>=1.0.3'],
    patch,
    unpatch
  },
  {
    name: '@grpc/grpc-js',
    versions: ['>=1.0.3'],
    file: 'build/src/make-client.js',
    patch (client, tracer, config) {
      if (config.client === false) return

      config = config.client || config

      this.wrap(client, 'makeClientConstructor', createWrapMakeClientConstructor(tracer, config))
      this.wrap(client, 'loadPackageDefinition', createWrapLoadPackageDefinition(tracer, config))
    },
    unpatch (client) {
      this.unwrap(client, 'makeClientConstructor')
      this.unwrap(client, 'loadPackageDefinition')
    }
  }
]
