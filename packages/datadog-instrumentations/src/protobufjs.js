const shimmer = require('../../datadog-shimmer')
const { addHook, AsyncResource } = require('./helpers/instrument')

const dc = require('dc-polyfill')
const serializeChannel = dc.channel('apm:protobufjs:serialize:start')
const deserializeChannel = dc.channel('apm:protobufjs:deserialize:end')

function wrapSerialization (messageClass) {
  if (messageClass?.encode) {
    shimmer.wrap(messageClass, 'encode', original => {
      return function wrappedEncode (...args) {
        if (!serializeChannel.hasSubscribers) {
          return original.apply(this, args)
        }

        const asyncResource = new AsyncResource('bound-anonymous-fn')

        asyncResource.runInAsyncScope(() => {
          serializeChannel.publish({ messageClass: this })
        })

        return original.apply(this, args)
      }
    })
  }
}

function wrapDeserialization (messageClass) {
  if (messageClass?.decode) {
    shimmer.wrap(messageClass, 'decode', original => {
      return function wrappedDecode (...args) {
        if (!deserializeChannel.hasSubscribers) {
          return original.apply(this, args)
        }

        const asyncResource = new AsyncResource('bound-anonymous-fn')

        const result = original.apply(this, args)

        asyncResource.runInAsyncScope(() => {
          deserializeChannel.publish({ messageClass: result })
        })

        return result
      }
    })
  }
}

function wrapSetup (messageClass) {
  if (messageClass?.setup) {
    shimmer.wrap(messageClass, 'setup', original => {
      return function wrappedSetup (...args) {
        const result = original.apply(this, args)

        wrapSerialization(messageClass)
        wrapDeserialization(messageClass)

        return result
      }
    })
  }
}

function wrapProtobufClasses (root) {
  if (!root) {
    return
  }

  if (root.decode) {
    wrapSetup(root)
  }

  if (root.nestedArray) {
    for (const subRoot of root.nestedArray) {
      wrapProtobufClasses(subRoot)
    }
  }
}

function wrapReflection (protobuf) {
  const reflectionMethods = [
    {
      target: protobuf.Root,
      name: 'fromJSON'
    },
    {
      target: protobuf.Type.prototype,
      name: 'fromObject'
    }
  ]

  reflectionMethods.forEach(method => {
    shimmer.wrap(method.target, method.name, original => {
      return function wrappedReflectionMethod (...args) {
        const result = original.apply(this, args)
        if (result.nested) {
          for (const type in result.nested) {
            wrapSetup(result.nested[type])
          }
        }
        if (result.$type) {
          wrapSetup(result.$type)
        }
        return result
      }
    })
  })
}

function isPromise (obj) {
  return !!obj && (typeof obj === 'object' || typeof obj === 'function') && typeof obj.then === 'function'
}

addHook({
  name: 'protobufjs',
  versions: ['>=6.0.0']
}, protobuf => {
  shimmer.wrap(protobuf.Root.prototype, 'load', original => {
    return function wrappedLoad (...args) {
      const result = original.apply(this, args)
      if (isPromise(result)) {
        result.then(root => {
          wrapProtobufClasses(root)
        })
      } else {
        // If result is not a promise, directly wrap the protobuf classes
        wrapProtobufClasses(result)
      }
      return result
    }
  })

  shimmer.wrap(protobuf.Root.prototype, 'loadSync', original => {
    return function wrappedLoadSync (...args) {
      const root = original.apply(this, args)
      wrapProtobufClasses(root)
      return root
    }
  })

  shimmer.wrap(protobuf, 'Type', Original => {
    return function wrappedTypeConstructor (...args) {
      const typeInstance = new Original(...args)
      wrapSetup(typeInstance)
      return typeInstance
    }
  })

  wrapReflection(protobuf)

  return protobuf
})
