const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

const dc = require('dc-polyfill')
const serializeChannel = dc.channel('apm:protobufjs:serialize-start')
const deserializeChannel = dc.channel('apm:protobufjs:deserialize-end')

function wrapSerialization (messageClass) {
  if (messageClass?.encode) {
    shimmer.wrap(messageClass, 'encode', original => function () {
      if (!serializeChannel.hasSubscribers) {
        return original.apply(this, arguments)
      }
      serializeChannel.publish({ messageClass: this })
      return original.apply(this, arguments)
    })
  }
}

function wrapDeserialization (messageClass) {
  if (messageClass?.decode) {
    shimmer.wrap(messageClass, 'decode', original => function () {
      if (!deserializeChannel.hasSubscribers) {
        return original.apply(this, arguments)
      }
      const result = original.apply(this, arguments)
      deserializeChannel.publish({ messageClass: result })
      return result
    })
  }
}

function wrapSetup (messageClass) {
  if (messageClass?.setup) {
    shimmer.wrap(messageClass, 'setup', original => function () {
      const result = original.apply(this, arguments)

      wrapSerialization(messageClass)
      wrapDeserialization(messageClass)

      return result
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
    shimmer.wrap(method.target, method.name, original => function () {
      const result = original.apply(this, arguments)
      if (result.nested) {
        for (const type in result.nested) {
          wrapSetup(result.nested[type])
        }
      }
      if (result.$type) {
        wrapSetup(result.$type)
      }
      return result
    })
  })
}

function isPromise (obj) {
  return !!obj && (typeof obj === 'object' || typeof obj === 'function') && typeof obj.then === 'function'
}

addHook({
  name: 'protobufjs',
  versions: ['>=6.8.0']
}, protobuf => {
  shimmer.wrap(protobuf.Root.prototype, 'load', original => function () {
    const result = original.apply(this, arguments)
    if (isPromise(result)) {
      return result.then(root => {
        wrapProtobufClasses(root)
        return root
      })
    } else {
      // If result is not a promise, directly wrap the protobuf classes
      wrapProtobufClasses(result)
      return result
    }
  })

  shimmer.wrap(protobuf.Root.prototype, 'loadSync', original => function () {
    const root = original.apply(this, arguments)
    wrapProtobufClasses(root)
    return root
  })

  shimmer.wrap(protobuf, 'Type', Original => function () {
    const typeInstance = new Original(...arguments)
    wrapSetup(typeInstance)
    return typeInstance
  })

  wrapReflection(protobuf)

  return protobuf
})
