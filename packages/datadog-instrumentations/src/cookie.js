'use strict'

const shimmer = require('../../datadog-shimmer')
const { channel, addHook } = require('./helpers/instrument')

const cookieParseCh = channel('datadog:cookie:parse:finish')

function wrapParse (originalParse) {
  return function (...args) {
    const cookies = originalParse.apply(this, args)
    if (cookieParseCh.hasSubscribers && cookies) {
      cookieParseCh.publish({ cookies })
    }
    return cookies
  }
}

/** @param {typeof import('cookie')} cookie */
addHook({ name: 'cookie', versions: ['>=0.4'] }, cookie => {
  for (const name of ['parse', 'parseCookie']) {
    if (typeof cookie[name] === 'function') {
      // shimmer returns a mutable replacement when an ESM namespace export is non-configurable.
      cookie = shimmer.wrap(cookie, name, wrapParse)
    }
  }
  return cookie
})
