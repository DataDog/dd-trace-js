'use strict'

const log = require('../../log')

const urlFilter = {
  getFilter (config) {
    if (typeof config.filter === 'function') {
      return config.filter
    } else if (config.hasOwnProperty('filter')) {
      log.error('Expected `filter` to be a function. Overriding filter property to default.')
    }

    const whitelist = config.whitelist || /.*/
    const blacklist = config.blacklist || []

    return uri => {
      const whitelisted = applyFilter(whitelist, uri)
      const blacklisted = applyFilter(blacklist, uri)
      return whitelisted && !blacklisted
    }

    function applyFilter (filter, uri) {
      if (typeof filter === 'function') {
        return filter(uri)
      } else if (filter instanceof RegExp) {
        return filter.test(uri)
      } else if (filter instanceof Array) {
        return filter.some(filter => applyFilter(filter, uri))
      }

      return filter === uri
    }
  }
}

module.exports = urlFilter
