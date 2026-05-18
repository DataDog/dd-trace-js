'use strict'

const { addHook, channel } = require('../helpers/instrument')
const shimmer = require('../../../datadog-shimmer')
const types = require('./types')

const patched = new WeakSet()
const instances = new WeakMap()

const startChannel = channel('apm:grpc:client:request:start')
const asyncStartChannel = channel('apm:grpc:client:request:asyncStart')
const errorChannel = channel('apm:grpc:client:request:error')
const finishChannel = channel('apm:grpc:client:request:finish')
const emitChannel = channel('apm:grpc:client:request:emit')

function createWrapMakeRequest (type, hasPeer = false) {
  const metadataIndex = type === types.client_stream || type === types.bidi ? 3 : 4

  return function wrapMakeRequest (makeRequest) {
    return function (path) {
      if (!startChannel.hasSubscribers) return makeRequest.apply(this, arguments)

      const { metadata, args } = resolveMetadata(this, arguments, metadataIndex)
      return callMethod(this, makeRequest, args, path, metadata, type, hasPeer)
    }
  }
}

function createWrapLoadPackageDefinition (hasPeer = false) {
  return function wrapLoadPackageDefinition (loadPackageDefinition) {
    return function (packageDef) {
      const result = loadPackageDefinition.apply(this, arguments)

      if (!result) return result

      wrapPackageDefinition(result, hasPeer)

      return result
    }
  }
}

function createWrapMakeClientConstructor (hasPeer = false) {
  return function wrapMakeClientConstructor (makeClientConstructor) {
    return function (methods) {
      const ServiceClient = makeClientConstructor.apply(this, arguments)
      wrapClientConstructor(ServiceClient, methods, hasPeer)
      return ServiceClient
    }
  }
}

function wrapPackageDefinition (def, hasPeer = false) {
  for (const name in def) {
    if (def[name].format) continue
    if (def[name].service && def[name].prototype) {
      wrapClientConstructor(def[name], def[name].service, hasPeer)
    } else {
      wrapPackageDefinition(def[name], hasPeer)
    }
  }
}

function wrapClientConstructor (ServiceClient, methods, hasPeer = false) {
  const proto = ServiceClient.prototype

  if (typeof methods !== 'object' || 'format' in methods) return

  for (const [name, method] of Object.entries(methods)) {
    if (!method) continue

    const { originalName, path } = method
    const type = getType(method)

    proto[name] = wrapMethod(proto[name], path, type, hasPeer)

    if (originalName) {
      proto[originalName] = wrapMethod(proto[originalName], path, type, hasPeer)
    }
  }
}

function wrapMethod (method, path, type, hasPeer) {
  if (typeof method !== 'function' || patched.has(method)) {
    return method
  }

  const metadataIndex = type === types.client_stream || type === types.bidi ? 0 : 1

  const wrapped = shimmer.wrapFunction(method, method => function () {
    if (!startChannel.hasSubscribers) return method.apply(this, arguments)

    const { metadata, args } = resolveMetadata(this, arguments, metadataIndex)
    return callMethod(this, method, args, path, metadata, type, hasPeer)
  })

  patched.add(wrapped)

  return wrapped
}

function wrapCallback (ctx, callback = () => {}) {
  return shimmer.wrapFunction(callback, callback => function (err) {
    if (err) {
      ctx.error = err
      errorChannel.publish(ctx)
    }

    return asyncStartChannel.runStores(ctx, () => {
      return callback.apply(this, arguments)
      // No async end channel needed
    })
  })
}

const onStatusWithPeer = function (ctx, arg1, thisArg) {
  ctx.result = arg1
  ctx.peer = thisArg.getPeer()
  finishChannel.publish(ctx)
}

const onStatusWithoutPeer = function (ctx, arg1) {
  ctx.result = arg1
  finishChannel.publish(ctx)
}

function createWrapEmit (ctx, hasPeer = false) {
  const onStatus = hasPeer ? onStatusWithPeer : onStatusWithoutPeer

  return function wrapEmit (emit) {
    return function (event, arg1) {
      switch (event) {
        case 'error':
          ctx.error = arg1
          errorChannel.publish(ctx)
          break
        case 'status':
          onStatus(ctx, arg1, this)
          break
      }

      return emitChannel.runStores(ctx, () => {
        return emit.apply(this, arguments)
      })
    }
  }
}

function callMethod (client, method, args, path, metadata, type, hasPeer = false) {
  const ctx = { metadata, path, type }

  return startChannel.runStores(ctx, () => {
    try {
      let callArgs = args

      if (type === types.unary || type === types.client_stream) {
        if (!Array.isArray(callArgs)) callArgs = [...callArgs]

        const length = callArgs.length
        const callback = callArgs[length - 1]
        if (typeof callback === 'function') {
          callArgs[length - 1] = wrapCallback(ctx, callback)
        } else {
          callArgs[length] = wrapCallback(ctx)
        }
      }

      const call = method.apply(client, callArgs)

      if (call && typeof call.emit === 'function') {
        shimmer.wrap(call, 'emit', createWrapEmit(ctx, hasPeer))
      }

      return call
    } catch (e) {
      ctx.error = e
      errorChannel.publish(ctx)
      throw e
    }
    // No end channel needed
  })
}

/**
 * Returns the `Metadata` for a gRPC client invocation, splicing or replacing
 * one at `index` when the user did not pass their own.
 *
 * @param {object} client
 * @param {ArrayLike<unknown>} args
 * @param {number} index
 * @returns {{ metadata: object | undefined, args: ArrayLike<unknown> }}
 */
function resolveMetadata (client, args, index) {
  const grpc = client && getGrpc(client)
  if (!grpc) return { metadata: undefined, args }

  const slot = args[index]

  if (slot instanceof grpc.Metadata || slot?.constructor?.name === 'Metadata') {
    return { metadata: slot, args }
  }

  const metadata = new grpc.Metadata()

  if (slot == null) {
    const out = [...args]
    out[index] = metadata
    return { metadata, args: out }
  }

  const out = new Array(args.length + 1)
  for (let i = 0; i < index; i++) out[i] = args[i]
  out[index] = metadata
  for (let i = index; i < args.length; i++) out[i + 1] = args[i]
  return { metadata, args: out }
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

function patch (hasPeer = false) {
  return function patch (grpc) {
    const proto = grpc.Client.prototype

    instances.set(proto, grpc)

    shimmer.wrap(proto, 'makeBidiStreamRequest', createWrapMakeRequest(types.bidi, hasPeer))
    shimmer.wrap(proto, 'makeClientStreamRequest', createWrapMakeRequest(types.clientStream, hasPeer))
    shimmer.wrap(proto, 'makeServerStreamRequest', createWrapMakeRequest(types.serverStream, hasPeer))
    shimmer.wrap(proto, 'makeUnaryRequest', createWrapMakeRequest(types.unary, hasPeer))

    return grpc
  }
}

addHook({ name: '@grpc/grpc-js', versions: ['>=1.0.3 <1.1.4'] }, patch(false))

addHook({ name: '@grpc/grpc-js', versions: ['>=1.0.3 <1.1.4'], file: 'build/src/make-client.js' }, client => {
  shimmer.wrap(client, 'makeClientConstructor', createWrapMakeClientConstructor(false))
  shimmer.wrap(client, 'loadPackageDefinition', createWrapLoadPackageDefinition(false))

  return client
})

addHook({ name: '@grpc/grpc-js', versions: ['>=1.1.4'] }, patch(true))

addHook({ name: '@grpc/grpc-js', versions: ['>=1.1.4'], file: 'build/src/make-client.js' }, client => {
  shimmer.wrap(client, 'makeClientConstructor', createWrapMakeClientConstructor(true))
  shimmer.wrap(client, 'loadPackageDefinition', createWrapLoadPackageDefinition(true))

  return client
})
