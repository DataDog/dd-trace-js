'use strict'

const { wrapThen } = require('../../datadog-instrumentations/src/helpers/promise')


module.exports = [
  {
    name: 'promise',
    file: 'lib/core.js',
    versions: ['>=7'],
    patch (Promise, tracer, config) {
      this.wrap(Promise.prototype, 'then', wrapThen)
    },
    unpatch (Promise) {
      this.unwrap(Promise.prototype, 'then')
    }
  }
]
