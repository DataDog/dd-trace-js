'use strict'

// Load binding first to not import other modules if it throws
const libdatadog = require('@datadog/libdatadog')
const tracerVersion = require('../../../package.json').version

function storeConfig (config) {
  const processDiscovery = libdatadog.maybeLoad('process-discovery')
  if (processDiscovery === undefined) {
    throw new Error('Can\'t load process-discovery library')
  }

  const metadata = new processDiscovery.TracerMetadata(
    'runtimeid',
    tracerVersion,
    config.hostname,
    config.server || null,
    config.env || null,
    config.version || null
  )

  return processDiscovery.storeMetadata(metadata)
}

module.exports = storeConfig
