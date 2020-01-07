'use strict'

const tx = require('../../dd-trace/src/plugins/util/promise')

module.exports = [
  {
    name: 'promise-js',
    versions: ['>=0.0.7'],
    patch (Promise, tracer, config) {
      if (Promise !== global.Promise) {
        this.wrap(Promise.prototype, 'then', tx.createWrapThen(tracer, config))
      }
    },
    unpatch (Promise) {
      if (Promise !== global.Promise) {
        this.unwrap(Promise.prototype, 'then')
      }
    }
  },
  {
    name: 'promise-js',
    versions: ['0.0.3 - 0.0.6'],
    patch (Promise, tracer, config) {
      this.wrap(Promise.prototype, 'then', tx.createWrapThen(tracer, config))
    },
    unpatch (Promise) {
      this.unwrap(Promise.prototype, 'then')
    }
  }
]
