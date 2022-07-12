'use strict'

const types = require('./types')
const { addHook, channel, AsyncResource } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')

const patched = new WeakSet()
const instances = new WeakMap()

const startChannel = channel('apm:grpc:client:request:start')
const errorChannel = channel('apm:grpc:client:request:error')
const finishChannel = channel('apm:grpc:client:request:finish')

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

function wrapCallback (requestResource, parentResource, callback) {
  return function (err) {
    if (err) {
      requestResource.runInAsyncScope(() => {
        errorChannel.publish(err)
      })
    }

    if (callback) {
      return parentResource.runInAsyncScope(() => {
        return callback.apply(this, arguments)
      })
    }
  }
}

function wrapStream (call, requestResource, parentResource) {
  if (!call || typeof call.emit !== 'function') return

  const emit = call.emit

  call.emit = function (eventName, ...args) {
    requestResource.runInAsyncScope(() => {
      switch (eventName) {
        case 'error':
          errorChannel.publish(args[0])

          break
        case 'status':
          finishChannel.publish(args[0])

          break
      }
    })

    return parentResource.runInAsyncScope(() => {
      return emit.apply(this, arguments)
    })
  }
}

function callMethod (client, method, args, path, metadata, type) {
  if (!startChannel.hasSubscribers) return method.apply(client, args)

  const length = args.length
  const callback = args[length - 1]
  const parentResource = new AsyncResource('bound-anonymous-fn')
  const requestResource = new AsyncResource('bound-anonymous-fn')

  return requestResource.runInAsyncScope(() => {
    startChannel.publish({ metadata, path, type })

    if (type === types.unary || type === types.client_stream) {
      if (typeof callback === 'function') {
        args[length - 1] = wrapCallback(requestResource, parentResource, callback)
      } else {
        args[length] = wrapCallback(requestResource, parentResource)
      }
    }

    const call = method.apply(client, args)

    wrapStream(call, requestResource, parentResource)

    return call
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

addHook({ name: 'grpc', versions: ['>=1.20.2'] }, patch)

addHook({ name: 'grpc', versions: ['>=1.20.2'], file: 'src/client.js' }, client => {
  shimmer.wrap(client, 'makeClientConstructor', createWrapMakeClientConstructor())

  return client
})

addHook({ name: '@grpc/grpc-js', versions: ['>=1.0.3'] }, patch)

addHook({ name: '@grpc/grpc-js', versions: ['>=1.0.3'], file: 'build/src/make-client.js' }, client => {
  shimmer.wrap(client, 'makeClientConstructor', createWrapMakeClientConstructor())
  shimmer.wrap(client, 'loadPackageDefinition', createWrapLoadPackageDefinition())

  return client
})
