'use strict'

const tx = require('../../dd-trace/src/plugins/util/promise')

function createWrapCollectionAddQueue (tracer, config) {
  return function wrapAddQueue (addQueue) {
    return function addQueueWithTrace (name) {
      const scope = tracer.scope()

      if (typeof name === 'function') {
        arguments[0] = scope.bind(name)
      } else if (typeof this[name] === 'function') {
        arguments[0] = scope.bind((...args) => this[name](...args))
      }

      return addQueue.apply(this, arguments)
    }
  }
}

module.exports = [
  {
    name: 'mongoose',
    versions: ['>=4.6.4'],
    patch (mongoose, tracer, config) {
      if (mongoose.Promise !== global.Promise) {
        this.wrap(mongoose.Promise.prototype, 'then', tx.createWrapThen(tracer, config))
      }

      this.wrap(mongoose.Collection.prototype, 'addQueue', createWrapCollectionAddQueue(tracer, config))
    },
    unpatch (mongoose) {
      if (mongoose.Promise !== global.Promise) {
        this.unwrap(mongoose.Promise.prototype, 'then')
      }

      this.unwrap(mongoose.Collection.prototype, 'addQueue')
    }
  }
]
