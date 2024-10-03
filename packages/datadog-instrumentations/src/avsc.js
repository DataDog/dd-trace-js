const shimmer = require('../../datadog-shimmer')
const { addHook, AsyncResource } = require('./helpers/instrument')

const dc = require('dc-polyfill')
const serializeChannel = dc.channel('apm:avsc:serialize')
const deserializeChannel = dc.channel('apm:avsc:deserialize')

function wrapSerialization (Type) {
  shimmer.wrap(Type.prototype, 'toBuffer', original => {
    return function wrappedToBuffer (...args) {
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

function wrapDeserialization (Type) {
  shimmer.wrap(Type.prototype, 'fromBuffer', original => {
    return function wrappedFromBuffer (...args) {
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

addHook({
  name: 'avsc',
  versions: ['>=5.0.0']
}, avro => {
  wrapDeserialization(avro.Type)
  wrapSerialization(avro.Type)

  return avro
})
