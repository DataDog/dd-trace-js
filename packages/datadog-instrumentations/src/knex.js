'use strict'

const { addHook } = require('./helpers/instrument')
const { wrapThen } = require('./helpers/promise')
const shimmer = require('../../datadog-shimmer')

patch('lib/query/builder.js')
patch('lib/raw.js')
patch('lib/schema/builder.js')

function patch (file) {
  addHook({
    name: 'knex',
    versions: ['>=0.8.0'],
    file
  }, Builder => {
    shimmer.wrap(Builder.prototype, 'then', wrapThen)
    return Builder
  })
}
