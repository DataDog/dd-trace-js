'use strict'

const tracerVersion = require('../../../version').VERSION
const { containerId } = require('./exporters/common/docker')

function storeConfig (config) {
  try {
    // Load binding first to not import other modules if it throws
    const libdatadog = require('@datadog/libdatadog')
    const processDiscovery = libdatadog.maybeLoad('process-discovery')
    if (processDiscovery === undefined) {
      return
    }

    const processTags = require('./process-tags')
    const serializedProcessTags = config.propagateProcessTags?.enabled ? processTags.serialized : ''

    const metadata = new processDiscovery.TracerMetadata(
      config.tags['runtime-id'],
      tracerVersion,
      config.hostname,
      config.service || null,
      config.env || null,
      config.version || null,
      serializedProcessTags,
      containerId || ''
    )

    return processDiscovery.storeMetadata(metadata)
  } catch {
    // Either libdatadog or process-discovery is unavailable.
  }
}

module.exports = storeConfig
