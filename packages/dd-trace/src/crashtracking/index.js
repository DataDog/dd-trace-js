'use strict'

const { isMainThread } = require('node:worker_threads')
const log = require('../log')

if (isMainThread) {
  try {
    module.exports = require('./crashtracker')
  } catch (err) {
    log.warn(err.message)
    module.exports = require('./noop')
  }
} else {
  module.exports = require('./noop')
}
