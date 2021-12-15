'use strict'

const { wrapThen } = require('../../datadog-instrumentations/src/helpers/promise')

module.exports = [
  {
    name: 'when',
    file: 'lib/Promise.js',
    versions: ['>=3'],
    patch (Promise, tracer, config) {
      this.wrap(Promise.prototype, 'then', wrapThen)
    },
    unpatch (Promise) {
      this.unwrap(Promise.prototype, 'then')
    }
  }
]
