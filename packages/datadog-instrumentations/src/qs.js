'use strict'

const { addHook, channel } = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

const qsParseCh = channel('datadog:qs:parse:finish')

function wrapParse (originalParse) {
  return function () {
    const qsParsedObj = originalParse.apply(this, arguments)
    if (qsParseCh.hasSubscribers && qsParsedObj) {
      qsParseCh.publish({ qs: qsParsedObj })
    }
    return qsParsedObj
  }
}

addHook({
  name: 'qs',
  versions: ['>=1']
}, qs => {
  shimmer.wrap(qs, 'parse', wrapParse)
  return qs
})
