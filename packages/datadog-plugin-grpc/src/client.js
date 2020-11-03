'use strict'

const Tags = require('../../../ext/tags')
const { TEXT_MAP } = require('../../../ext/formats')
const { ERROR } = require('../../../ext/tags')
const kinds = require('./kinds')
const { addMethodTags, addMetadataTags, getFilter } = require('./util')

function createWrapLoadPackageDefinition (tracer, config) {
  config = config.client || config

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
  config = config.client || config

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
    if (def[name].service) {
      wrapClientConstructor(tracer, config, def[name], def[name].service)
    } else {
      wrapPackageDefinition(tracer, config, def[name])
    }
  }
}

function wrapClientConstructor (tracer, config, ServiceClient, methods) {
  const proto = ServiceClient.prototype

  if (typeof methods !== 'object' || 'format' in methods) {
    return ServiceClient
  }

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

  return ServiceClient
}

function wrapMethod (tracer, config, method, path, methodKind) {
  if (typeof method !== 'function' || method._datadog_patched) {
    return method
  }

  const filter = getFilter(config, 'metadata')

  const methodWithTrace = function methodWithTrace () {
    const args = ensureMetadata(this, arguments)
    const length = args.length
    const metadata = args[1]
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

    const call = scope.bind(method, span).apply(this, args)

    wrapStream(span, call, filter)

    return scope.bind(call)
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

function startSpan (tracer, config, path, methodKind) {
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

function ensureMetadata (client, args) {
  if (!client || !client._datadog) return args

  const normalized = [args[0]]

  if (!args[1] || !args[1].constructor || args[1].constructor.name !== 'Metadata') {
    normalized.push(new client._datadog.grpc.Metadata())
  }

  for (let i = 1; i < args.length; i++) {
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

module.exports = [
  {
    name: 'grpc',
    versions: ['>=1.13'],
    patch (grpc, tracer, config) {
      if (config.client === false) return

      grpc.Client.prototype._datadog = { grpc }
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
      if (config.client === false) return

      this.wrap(client, 'makeClientConstructor', createWrapMakeClientConstructor(tracer, config))
    },
    unpatch (client) {
      this.unwrap(client, 'makeClientConstructor')
    }
  },
  {
    name: '@grpc/grpc-js',
    versions: ['>=1.0.3'],
    patch (grpc, tracer, config) {
      if (config.client === false) return

      grpc.Client.prototype._datadog = { grpc }
    },
    unpatch (grpc) {
      delete grpc.Client._datadog
    }
  },
  {
    name: '@grpc/grpc-js',
    versions: ['>=1.0.3'],
    file: 'build/src/make-client.js',
    patch (client, tracer, config) {
      if (config.client === false) return

      this.wrap(client, 'makeClientConstructor', createWrapMakeClientConstructor(tracer, config))
      this.wrap(client, 'loadPackageDefinition', createWrapLoadPackageDefinition(tracer, config))
    },
    unpatch (client) {
      this.unwrap(client, 'makeClientConstructor')
      this.unwrap(client, 'loadPackageDefinition')
    }
  }
]
