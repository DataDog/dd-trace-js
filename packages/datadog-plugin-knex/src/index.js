'use strict'

const { wrapThen } = require('../../datadog-instrumentations/src/helpers/promise')

function createPatch (file) {
  return {
    name: 'knex',
    versions: ['>=0.8.0'],
    file,
    patch (Builder) {
      this.wrap(Builder.prototype, 'then', wrapThen)
    },
    unpatch (Builder) {
      this.unwrap(Builder.prototype, 'then')
    }
  }
}

module.exports = [
  createPatch('lib/query/builder.js'),
  createPatch('lib/raw.js'),
  createPatch('lib/schema/builder.js')
]
