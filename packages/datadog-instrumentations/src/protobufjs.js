const shimmer = require('../../datadog-shimmer')
const { channel, addHook, AsyncResource } = require('./helpers/instrument')

const startSerializeCh = channel('datadog:protobuf:serialize:start')
const finishSerializeCh = channel('datadog:protobuf:serialize:finish')
const startDeserializeCh = channel('datadog:protobuf:deserialize:start')
const finishDeserializeCh = channel('datadog:protobuf:deserialize:finish')

function wrapSerialization (messageClass) {
  if (messageClass?.encode) {
    wrapOperation(messageClass, 'encode', {
      startChPublish: (obj, args) => startSerializeCh.publish({ message: obj }),
      finishChPublish: (result) => finishSerializeCh.publish({ buffer: result }),
      startCh: startSerializeCh,
      finishCh: finishSerializeCh
    })
  }
}

function wrapDeserialization (messageClass) {
  if (messageClass?.decode) {
    wrapOperation(messageClass, 'decode', {
      startChPublish: (obj, args) => startDeserializeCh.publish({ buffer: args[0] }),
      finishChPublish: (result) => finishDeserializeCh.publish({ message: result }),
      startCh: startDeserializeCh,
      finishCh: finishDeserializeCh
    })
  }
}

function wrapOperation (messageClass, operationName, channels) {
  shimmer.wrap(messageClass, operationName, original => {
    return function wrappedMethod (...args) {
      if (!channels.startCh.hasSubscribers && !channels.finishCh.hasSubscribers) {
        return original.apply(this, args)
      }

      const asyncResource = new AsyncResource('bound-anonymous-fn')

      asyncResource.runInAsyncScope(() => {
        channels.startChPublish(this, args)
      })

      try {
        const result = original.apply(this, args)

        asyncResource.runInAsyncScope(() => {
          channels.finishChPublish(result)
        })

        return result
      } catch (err) {
        asyncResource.runInAsyncScope(() => {
          channels.finishChPublish(args)
        })
        throw err
      }
    }
  })
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
