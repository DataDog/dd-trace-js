'use strict'

// Load binding first to not import other modules if it throws
const libdatadog = require('@datadog/libdatadog')
const tracerVersion = require('../../../version').VERSION

function storeConfig (config) {
  const processDiscovery = libdatadog.maybeLoad('process-discovery')
  if (processDiscovery === undefined) {
    return
  }

  const metadata = new processDiscovery.TracerMetadata(
    config.tags['runtime-id'],
    tracerVersion,
    config.hostname,
    config.server || null,
    config.env || null,
    config.version || null
  )

  return processDiscovery.storeMetadata(metadata)
}

module.exports = storeConfig
