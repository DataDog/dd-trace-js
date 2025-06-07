'use strict'

const { isMainThread } = require('worker_threads')
const log = require('../log')

if (isMainThread) {
  try {
    module.exports = require('./crashtracker')
  } catch (error) {
    log.warn(error.message)
    module.exports = require('./noop')
  }
} else {
  module.exports = require('./noop')
}
