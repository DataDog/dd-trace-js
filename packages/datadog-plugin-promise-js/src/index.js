'use strict'

const { wrapThen } = require('../../datadog-instrumentations/src/helpers/promise')

module.exports = [
  {
    name: 'promise-js',
    versions: ['>=0.0.3'],
    patch (Promise, tracer, config) {
      if (Promise !== global.Promise) {
        this.wrap(Promise.prototype, 'then', wrapThen)
      }
    },
    unpatch (Promise) {
      if (Promise !== global.Promise) {
        this.unwrap(Promise.prototype, 'then')
      }
    }
  }
]
