'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const cookieParseCh = channel('datadog:cookie:parse:finish')

function wrapParse (originalParse) {
  return function () {
    const cookies = originalParse.apply(this, arguments)
    if (cookieParseCh.hasSubscribers && cookies) {
      cookieParseCh.publish({ cookies })
    }
    return cookies
  }
}

addHook({ name: 'cookie', versions: ['>=0.4'] }, cookie => {
  shimmer.wrap(cookie, 'parse', wrapParse)
  return cookie
})
