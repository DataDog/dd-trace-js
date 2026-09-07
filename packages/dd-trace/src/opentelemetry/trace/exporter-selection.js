'use strict'

const exporters = require('../../../../../ext/exporters')

/**
 * @param {import('../../config/config-base')} config
 */
function isOtlpTraceExporterEnabled (config) {
  return config.OTEL_TRACES_EXPORTER === 'otlp' &&
    !config.isCiVisibility &&
    config.experimental.exporter !== exporters.ELECTRON
}

module.exports = isOtlpTraceExporterEnabled
