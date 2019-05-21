'use strict'

const tx = require('./util/promise')

module.exports = [
  {
    name: 'promise-js',
    versions: ['>=0.0.3'],
    patch (Promise, tracer, config) {
      this.wrap(Promise.prototype, 'then', tx.createWrapThen(tracer, config))
    },
    unpatch (Promise) {
      this.unwrap(Promise.prototype, 'then')
    }
  }
]
