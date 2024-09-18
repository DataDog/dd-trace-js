const shimmer = require('../../datadog-shimmer')
const { channel, addHook, AsyncResource } = require('./helpers/instrument')

const startSerializeCh = channel('datadog:protobuf:serialize:start')
const finishSerializeCh = channel('datadog:protobuf:serialize:finish')
const startDeserializeCh = channel('datadog:protobuf:deserialize:start')
const finishDeserializeCh = channel('datadog:protobuf:deserialize:finish')

function wrapSerialization (Class) {
  shimmer.wrap(Class, 'encode', original => {
    return function wrappedEncode (...args) {
      if (!startSerializeCh.hasSubscribers) {
        return original.apply(this, args)
      }

      const asyncResource = new AsyncResource('bound-anonymous-fn')

      asyncResource.runInAsyncScope(() => {
        startSerializeCh.publish({ message: this })
      })

      try {
        // when applying the original encode / decode functions, protobuf sets up the classes again
        // causing our function wrappers to dissappear, we should verify they exist and rewrap if not
        const wrappedDecode = this.decode
        const wrappedEncode = this.encode
        const result = original.apply(this, args)
        ensureMessageIsWrapped(this, wrappedEncode, wrappedDecode)

        if (original) {
          asyncResource.runInAsyncScope(() => {
            finishSerializeCh.publish({ message: this })
          })
        }
        return result
      } catch (err) {
        asyncResource.runInAsyncScope(() => {
          finishSerializeCh.publish({ message: this })
        })
        throw err
      }
    }
  })
}

function ensureMessageIsWrapped (messageClass, wrappedEncode, wrappedDecode) {
  if (messageClass.encode !== wrappedEncode) {
    messageClass.encode = wrappedEncode
  }

  if (messageClass.decode !== wrappedDecode) {
    messageClass.decode = wrappedDecode
  }
}

function wrapDeserialization (Class) {
  shimmer.wrap(Class, 'decode', original => {
    return function wrappedDecode (...args) {
      if (!startDeserializeCh.hasSubscribers) {
        return original.apply(this, args)
      }

      const asyncResource = new AsyncResource('bound-anonymous-fn')

      asyncResource.runInAsyncScope(() => {
        startDeserializeCh.publish({ buffer: args[0] })
      })

      try {
        // when applying the original encode / decode functions, protobuf sets up the classes again
        // causing our function wrappers to dissappear, we should verify they exist and rewrap if not

        const wrappedDecode = this.decode
        const wrappedEncode = this.encode
        const result = original.apply(this, args)
        ensureMessageIsWrapped(this, wrappedEncode, wrappedDecode)

        asyncResource.runInAsyncScope(() => {
          finishDeserializeCh.publish({ message: result })
        })
        return result
      } catch (err) {
        asyncResource.runInAsyncScope(() => {
          finishDeserializeCh.publish({ buffer: args[0] })
        })
        throw err
      }
    }
  })
}

function wrapProtobufClasses (root) {
  if (!root) {
    // pass
  } else if (root.decode) {
    wrapSerialization(root)
    wrapDeserialization(root)
  } else if (root.nestedArray) {
    for (const subRoot of root.nestedArray) {
      wrapProtobufClasses(subRoot)
    }
  }
}

addHook({
  name: 'protobufjs',
  versions: ['>=6.0.0']
}, protobuf => {
  shimmer.wrap(protobuf.Root.prototype, 'load', original => {
    return function wrappedLoad (...args) {
      const result = original.apply(this, args)
      result.then(root => {
        wrapProtobufClasses(root)
      })
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

  return protobuf
})
