'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const nodeUnserializeCh = channel('datadog:node-serialize:unserialize:start')
const patched = new WeakSet()

function wrapUnserialize (serialize) {
  return function wrappedUnserialize (obj) {
    if (nodeUnserializeCh.hasSubscribers) {
      nodeUnserializeCh.publish({ obj })
    }

    return serialize.apply(this, arguments)
  }
}

addHook({ name: 'node-serialize', versions: ['0.0.4'] }, serialize => {
  if (patched.has(serialize.unserialize)) return serialize
  shimmer.wrap(serialize, 'unserialize', wrapUnserialize)
  patched.add(serialize.unserialize)

  return serialize
})
