'use strict'

const types = require('./types')
const { addHook, channel } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const nodeMajor = parseInt(process.versions.node.split('.')[0])

const patched = new WeakSet()
const instances = new WeakMap()

const startChannel = channel('apm:grpc:client:request:start')
const asyncStartChannel = channel('apm:grpc:client:request:asyncStart')
const errorChannel = channel('apm:grpc:client:request:error')
const finishChannel = channel('apm:grpc:client:request:finish')
const emitChannel = channel('apm:grpc:client:request:emit')

function createWrapMakeRequest (type) {
  return function wrapMakeRequest (makeRequest) {
    return function (path) {
      const args = ensureMetadata(this, arguments, 4)

      return callMethod(this, makeRequest, args, path, args[4], type)
    }
  }
}

function createWrapLoadPackageDefinition () {
  return function wrapLoadPackageDefinition (loadPackageDefinition) {
    return function (packageDef) {
      const result = loadPackageDefinition.apply(this, arguments)

      if (!result) return result

      wrapPackageDefinition(result)

      return result
    }
  }
}

function createWrapMakeClientConstructor () {
  return function wrapMakeClientConstructor (makeClientConstructor) {
    return function (methods) {
      const ServiceClient = makeClientConstructor.apply(this, arguments)

      wrapClientConstructor(ServiceClient, methods)

      return ServiceClient
    }
  }
}

function wrapPackageDefinition (def) {
  for (const name in def) {
    if (def[name].format) continue
    if (def[name].service && def[name].prototype) {
      wrapClientConstructor(def[name], def[name].service)
    } else {
      wrapPackageDefinition(def[name])
    }
  }
}

function wrapClientConstructor (ServiceClient, methods) {
  const proto = ServiceClient.prototype

  if (typeof methods !== 'object' || 'format' in methods) return

  Object.keys(methods)
    .forEach(name => {
      if (!methods[name]) return

      const originalName = methods[name].originalName
      const path = methods[name].path
      const type = getType(methods[name])

      if (methods[name]) {
        proto[name] = wrapMethod(proto[name], path, type)
      }

      if (originalName) {
        proto[originalName] = wrapMethod(proto[originalName], path, type)
      }
    })
}

function wrapMethod (method, path, type) {
  if (typeof method !== 'function' || patched.has(method)) {
    return method
  }

  const wrapped = function () {
    const args = ensureMetadata(this, arguments, 1)

    return callMethod(this, method, args, path, args[1], type)
  }

  Object.assign(wrapped, method)

  patched.add(wrapped)

  return wrapped
}

function wrapCallback (ctx, callback = () => { }) {
  return function (err) {
    if (err) {
      ctx.error = err
      errorChannel.publish(ctx)
    }

    return asyncStartChannel.runStores(ctx, () => {
      return callback.apply(this, arguments)
      // No async end channel needed
    })
  }
}

function createWrapEmit (ctx) {
  return function wrapEmit (emit) {
    return function (event, arg1) {
      switch (event) {
        case 'error':
          ctx.error = arg1
          errorChannel.publish(ctx)
          break
        case 'status':
          ctx.result = arg1
          finishChannel.publish(ctx)
          break
      }

      return emitChannel.runStores(ctx, () => {
        return emit.apply(this, arguments)
      })
    }
  }
}

function callMethod (client, method, args, path, metadata, type) {
  if (!startChannel.hasSubscribers) return method.apply(client, args)

  const length = args.length
  const callback = args[length - 1]

  const ctx = { metadata, path, type }

  return startChannel.runStores(ctx, () => {
    try {
      if (type === types.unary || type === types.client_stream) {
        if (typeof callback === 'function') {
          args[length - 1] = wrapCallback(ctx, callback)
        } else {
          args[length] = wrapCallback(ctx)
        }
      }

      const call = method.apply(client, args)

      if (call && typeof call.emit === 'function') {
        shimmer.wrap(call, 'emit', createWrapEmit(ctx))
      }

      return call
    } catch (e) {
      ctx.error = e
      errorChannel.publish(ctx)
    }
    // No end channel needed
  })
}

function ensureMetadata (client, args, index) {
  const grpc = getGrpc(client)

  if (!client || !grpc) return args

  const meta = args[index]
  const normalized = []

  for (let i = 0; i < index; i++) {
    normalized.push(args[i])
  }

  if (!meta || !meta.constructor || meta.constructor.name !== 'Metadata') {
    normalized.push(new grpc.Metadata())
  }

  if (meta) {
    normalized.push(meta)
  }

  for (let i = index + 1; i < args.length; i++) {
    normalized.push(args[i])
  }

  return normalized
}

function getType (definition) {
  if (definition.requestStream) {
    if (definition.responseStream) {
      return types.bidi
    }

    return types.client_stream
  }

  if (definition.responseStream) {
    return types.server_stream
  }

  return types.unary
}

function getGrpc (client) {
  let proto = client

  do {
    const instance = instances.get(proto)
    if (instance) return instance
  } while ((proto = Object.getPrototypeOf(proto)))
}

function patch (grpc) {
  const proto = grpc.Client.prototype

  instances.set(proto, grpc)

  shimmer.wrap(proto, 'makeBidiStreamRequest', createWrapMakeRequest(types.bidi))
  shimmer.wrap(proto, 'makeClientStreamRequest', createWrapMakeRequest(types.clientStream))
  shimmer.wrap(proto, 'makeServerStreamRequest', createWrapMakeRequest(types.serverStream))
  shimmer.wrap(proto, 'makeUnaryRequest', createWrapMakeRequest(types.unary))

  return grpc
}

if (nodeMajor <= 14) {
  addHook({ name: 'grpc', versions: ['>=1.24.3'] }, patch)

  addHook({ name: 'grpc', versions: ['>=1.24.3'], file: 'src/client.js' }, client => {
    shimmer.wrap(client, 'makeClientConstructor', createWrapMakeClientConstructor())

    return client
  })
}

addHook({ name: '@grpc/grpc-js', versions: ['>=1.0.3'] }, patch)

addHook({ name: '@grpc/grpc-js', versions: ['>=1.0.3'], file: 'build/src/make-client.js' }, client => {
  shimmer.wrap(client, 'makeClientConstructor', createWrapMakeClientConstructor())
  shimmer.wrap(client, 'loadPackageDefinition', createWrapLoadPackageDefinition())

  return client
})
