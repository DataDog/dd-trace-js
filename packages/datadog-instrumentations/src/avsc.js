'use strict'

const dc = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
const { addHook } = require('./helpers/instrument')

const serializeChannel = dc.channel('apm:avsc:serialize-start')
const deserializeChannel = dc.channel('apm:avsc:deserialize-end')

function wrapSerialization (Type) {
  shimmer.wrap(Type.prototype, 'toBuffer', original => function (...args) {
    if (!serializeChannel.hasSubscribers) {
      return original.apply(this, args)
    }
    serializeChannel.publish({ messageClass: this })
    return original.apply(this, args)
  })
}

function wrapDeserialization (Type) {
  shimmer.wrap(Type.prototype, 'fromBuffer', original => function (...args) {
    if (!deserializeChannel.hasSubscribers) {
      return original.apply(this, args)
    }
    const result = original.apply(this, args)
    deserializeChannel.publish({ messageClass: result })
    return result
  })
}

addHook({
  name: 'avsc',
  versions: ['>=5.0.0'],
}, avro => {
  wrapDeserialization(avro.Type)
  wrapSerialization(avro.Type)

  return avro
})
