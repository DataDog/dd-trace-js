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

    // OTEP-4947 thread-context writer metadata, published as part of the
    // OTel process context so an out-of-process reader can decode the
    // on-wire record: the attribute key map (libdatadog prepends the
    // implicit `datadog.local_root_span_id` at wire index 0, so we only
    // supply our own additional keys), the schema-version string, and
    // the V8 layout constants the reader needs. Gated on the same config
    // flag that activates the writer; undefined when off or when
    // @datadog/pprof isn't installed to provide the values.
    const threadlocalMetadata = config.DD_TRACE_OTEL_CTX_ENABLED
      ? require('./otel-thread-ctx').getThreadLocalMetadata()
      : undefined

    const metadata = new processDiscovery.TracerMetadata(
      config.tags['runtime-id'],
      tracerVersion,
      config.hostname,
      config.service || null,
      config.env || null,
      config.version || null,
      processTagsSerialized,
      containerId || null,
      threadlocalMetadata
    )

    return processDiscovery.storeMetadata(metadata)
  } catch {
    // Either libdatadog or process-discovery is unavailable.
  }
}

module.exports = storeConfig
