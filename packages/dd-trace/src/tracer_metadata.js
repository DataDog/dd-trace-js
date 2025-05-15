'use strict'

// Load binding first to not import other modules if it throws
const libdatadog = require('@datadog/libdatadog')
const tracerVersion = require('../../../package.json').version

function storeConfig (config) {
  const process_discovery = libdatadog.maybeLoad('process_discovery')
  if (process_discovery === undefined) {
    throw new Error('Can\'t load process_discovery library')
  }

  const metadata = new process_discovery.TracerMetadata(
    "runtimeid",
    tracerVersion,
    config.hostname,
    config.server || null,
    config.env || null,
    config.version || null
  )

  return process_discovery.storeMetadata(metadata)
}

module.exports = storeConfig
