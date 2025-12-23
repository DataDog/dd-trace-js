'use strict'

const { storage } = require('./storage')

function withRoutingContext (options, fn) {
  if (!options || !options.ddApiKey) {
    throw new Error('ddApiKey is required for routing context')
  }

  const currentStore = storage.getStore()

  const store = {
    ...currentStore,
    routingContext: {
      apiKey: options.ddApiKey,
      site: options.ddSite
    }
  }

  return storage.run(store, fn)
}

function getCurrentRouting () {
  const store = storage.getStore()
  const routing = store?.routingContext

  if (!routing) {
    return null
  }

  return {
    apiKey: routing.apiKey,
    site: routing.site
  }
}

module.exports = { withRoutingContext, getCurrentRouting }
