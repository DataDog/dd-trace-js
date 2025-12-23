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

function getCurrentRouting (defaultApiKey, defaultSite) {
  const store = storage.getStore()
  const routing = store?.routingContext

  return {
    apiKey: routing?.apiKey || defaultApiKey,
    site: routing?.site || defaultSite
  }
}

module.exports = { withRoutingContext, getCurrentRouting }
