'use strict'

const tracerVersion = require('../../../version').VERSION

function storeConfig (config) {
  try {
    // Load binding first to not import other modules if it throws
    const libdatadog = require('@datadog/libdatadog')
    const processDiscovery = libdatadog.maybeLoad('process-discovery')
    if (processDiscovery === undefined) {
      return
    }

    const { containerId } = require('./exporters/common/docker')
    const processTags = require('./process-tags')

    const processTagsSerialized = config.propagateProcessTags?.enabled
      ? (processTags.serialized || null)
      : null

    const metadata = new processDiscovery.TracerMetadata(
      config.tags['runtime-id'],
      tracerVersion,
      config.hostname,
      config.service || null,
      config.env || null,
      config.version || null,
      processTagsSerialized,
      containerId || null
    )

    return processDiscovery.storeMetadata(metadata)
  } catch {
    // Either libdatadog or process-discovery is unavailable.
  }
}

module.exports = storeConfig
