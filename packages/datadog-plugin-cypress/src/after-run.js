'use strict'

const dc = require('dc-polyfill')

const afterRunCh = dc.channel('ci:cypress:after-run')

module.exports = function afterRun (results) {
  if (!afterRunCh.hasSubscribers) return
  return new Promise(resolve => afterRunCh.publish({ results, onDone: resolve }))
}
