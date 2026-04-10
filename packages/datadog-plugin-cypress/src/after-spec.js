'use strict'

const dc = require('dc-polyfill')

const afterSpecCh = dc.channel('ci:cypress:after-spec')

module.exports = function afterSpec (spec, results) {
  if (!afterSpecCh.hasSubscribers) return
  return new Promise(resolve => afterSpecCh.publish({ spec, results, onDone: resolve }))
}
