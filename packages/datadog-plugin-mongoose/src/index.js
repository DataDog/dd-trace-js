'use strict'

const { wrapThen } = require('../../datadog-instrumentations/src/helpers/promise')
const { AsyncResource } = require('../../datadog-instrumentations/src/helpers/instrument')

function wrapAddQueue (addQueue) {
  return function addQueueWithTrace (name) {
    if (typeof name === 'function') {
      arguments[0] = AsyncResource.bind(name)
    } else if (typeof this[name] === 'function') {
      arguments[0] = AsyncResource.bind((...args) => this[name](...args))
    }

    return addQueue.apply(this, arguments)
  }
}

module.exports = [
  {
    name: 'mongoose',
    versions: ['>=4.6.4'],
    patch (mongoose) {
      if (mongoose.Promise !== global.Promise) {
        this.wrap(mongoose.Promise.prototype, 'then', wrapThen)
      }

      this.wrap(mongoose.Collection.prototype, 'addQueue', wrapAddQueue)
    },
    unpatch (mongoose) {
      if (mongoose.Promise !== global.Promise) {
        this.unwrap(mongoose.Promise.prototype, 'then')
      }

      this.unwrap(mongoose.Collection.prototype, 'addQueue')
    }
  }
]
