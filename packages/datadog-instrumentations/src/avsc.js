const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

const dc = require('dc-polyfill')
const serializeChannel = dc.channel('apm:avsc:serialize-start')
const deserializeChannel = dc.channel('apm:avsc:deserialize-end')

function wrapSerialization (Type) {
  shimmer.wrap(Type.prototype, 'toBuffer', original => function () {
    if (!serializeChannel.hasSubscribers) {
      return original.apply(this, arguments)
    }
    serializeChannel.publish({ messageClass: this })
    return original.apply(this, arguments)
  })
}

function wrapDeserialization (Type) {
  shimmer.wrap(Type.prototype, 'fromBuffer', original => function () {
    if (!deserializeChannel.hasSubscribers) {
      return original.apply(this, arguments)
    }
    const result = original.apply(this, arguments)
    deserializeChannel.publish({ messageClass: result })
    return result
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
