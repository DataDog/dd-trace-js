'use strict'

const tx = require('../../dd-trace/src/plugins/util/promise')

module.exports = [
  {
    name: 'promise-js',
    versions: ['>=0.0.3'],
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
  }
]
