'use strict'

const log = require('../../log')

function applyFilter (filter, uri) {
  if (typeof filter === 'function') {
    return filter(uri)
  }
  if (filter instanceof RegExp) {
    return filter.test(uri)
  }
  if (Array.isArray(filter)) {
    return filter.some(filter => applyFilter(filter, uri))
  }

  return filter === uri
}

const urlFilter = {
  getFilter (config) {
    if (typeof config.filter === 'function') {
      return config.filter
    }
    if (Object.hasOwn(config, 'filter')) {
      log.error('Expected `filter` to be a function. Overriding filter property to default.')
    }

    const allowlist = config.allowlist || config.whitelist || /.*/
    const blocklist = config.blocklist || config.blacklist || []

    return uri => applyFilter(allowlist, uri) && !applyFilter(blocklist, uri)
  }
}

module.exports = urlFilter
