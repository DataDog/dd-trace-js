'use strict'

const {
  channel,
  addHook
} = require('./helpers/instrument')
const shimmer = require('../../datadog-shimmer')

function isString (value) {
  return typeof value === 'string' || value instanceof String
}

addHook({ name: 'ldapjs', versions: ['>=1'] }, ldapjs => {
  const ldapSearchCh = channel('datadog:ldapjs:client:search')

  shimmer.wrap(ldapjs.Client.prototype, 'search', search => function () {
    if (ldapSearchCh.hasSubscribers) {
      const base = arguments[0]
      let filter = null
      const options = arguments[1]
      if (isString(options)) {
        filter = options
      } else if (typeof options === 'object' && options.filter) {
        if (isString(options.filter)) {
          filter = options.filter
        }
      }
      ldapSearchCh.publish({ base, filter })
    }

    return search.apply(this, arguments)
  })

  return ldapjs
})
