'use strict'

// Load binding first to not import other modules if it throws
const libdatadog = require('@datadog/libdatadog')
const tracerVersion = require('../../../../package.json').version

function storeConfig (config) {
  const process_discovery = libdatadog.maybeLoad('process_discovery')
  if (process_discovery === undefined) {
    throw new Error('Can\t load process_discovery library')
  }

  const metadata = new process_discovery.TracerMetadata({
    runtime_id: config.experimental.runtimeId,
    tracer_version: tracerVersion,
    hostname: config.hostname,
    service_name: config.service || null,
    service_env: config.env || null,
    service_version: config.version || null,
  })

  return process_discovery.store_metadata(metadata)
}

module.exports = storeConfig
