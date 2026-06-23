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

    const processTagsSerialized = config.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED
      ? (processTags.serialized || null)
      : null

    // OTEP-4947 thread-context writer's attribute_key_map, published as
    // part of the process context so an out-of-process reader can decode
    // the on-wire uint8 key indices back to attribute names. libdatadog
    // prepends the implicit `datadog.local_root_span_id` entry at wire
    // index 0, so we only supply our own additional keys here. Gated on
    // the same config flag that activates the writer.
    const threadlocalAttributeKeys = config.DD_TRACE_OTEL_CTX_ENABLED
      ? require('./otel-thread-ctx').ATTRIBUTE_KEYS
      : null

    const metadata = new processDiscovery.TracerMetadata(
      config.tags['runtime-id'],
      tracerVersion,
      config.hostname,
      config.service || null,
      config.env || null,
      config.version || null,
      processTagsSerialized,
      containerId || null,
      threadlocalAttributeKeys
    )

    return processDiscovery.storeMetadata(metadata)
  } catch {
    // Either libdatadog or process-discovery is unavailable.
  }
}

module.exports = storeConfig
