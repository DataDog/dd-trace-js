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

// cookie <1 exports only `parse`. 1.x exports `parse` plus a `parseCookie` alias. 2.x is ESM-only and exports only
// `parseCookie`. Wrap whichever parse entry points the installed version exposes so the caller's chosen name is
// instrumented; a single call hits exactly one export, so wrapping both when present does not double-publish.
addHook({ name: 'cookie', versions: ['>=0.4'] }, cookie => {
  for (const name of ['parse', 'parseCookie']) {
    if (typeof cookie[name] === 'function') {
      shimmer.wrap(cookie, name, wrapParse)
    }
  }
  return cookie
})
