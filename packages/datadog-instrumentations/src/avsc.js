const shimmer = require('../../datadog-shimmer')
const { addHook, AsyncResource } = require('./helpers/instrument')
const tracingChannel = require('dc-polyfill').tracingChannel

const serializeCh = tracingChannel('apm:avsc:serialize')
const deserializeCh = tracingChannel('apm:avsc:deserialize')

function wrapSerialization (Type) {
  shimmer.wrap(Type.prototype, 'toBuffer', original => {
    return function wrappedToBuffer (...args) {
      if (!serializeCh.start.hasSubscribers && !serializeCh.end.hasSubscribers) {
        return original.apply(this, args)
      }

      const asyncResource = new AsyncResource('bound-anonymous-fn')

      return asyncResource.runInAsyncScope(() => {
        return serializeCh.traceSync(() => original.apply(this, args), { type: this })
      })
    }
  })
}

function wrapDeserialization (Type) {
  shimmer.wrap(Type.prototype, 'fromBuffer', original => {
    return function wrappedFromBuffer (...args) {
      if (!deserializeCh.start.hasSubscribers && !deserializeCh.end.hasSubscribers) {
        return original.apply(this, args)
      }

      const asyncResource = new AsyncResource('bound-anonymous-fn')

      return asyncResource.runInAsyncScope(() => {
        return deserializeCh.traceSync(() => original.apply(this, args), { type: this })
      })
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
