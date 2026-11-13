'use strict'

const OtlpHttpExporterBase = require('../../opentelemetry/otlp/otlp_http_exporter_base')
const log = require('../../log')

/** @typedef {import('../../config/config-base')} TracerConfig */

// The OTLP profiles development version of the request format that @datadog/pprof encodes. The
// specification lets clients of version 1 omit it; sending it ties the format to this exporter.
const PROFILES_DEVELOPMENT_VERSION = '1'

/**
 * Sends a collection cycle's profiles, as one OTLP ExportProfilesServiceRequest, to the OTLP
 * profiles endpoint. Profiles are only sent with OTEL_PROFILES_EXPORTER=otlp, in place of the
 * agent destination.
 */
class OtlpProfilesExporter extends OtlpHttpExporterBase {
  /** @param {TracerConfig} config */
  constructor (config) {
    super(
      config.OTEL_EXPORTER_OTLP_PROFILES_ENDPOINT,
      {
        'OTLP-Profiles-Development-Version': PROFILES_DEVELOPMENT_VERSION,
        ...config.OTEL_EXPORTER_OTLP_PROFILES_HEADERS,
      },
      config.OTEL_EXPORTER_OTLP_PROFILES_TIMEOUT,
      'http/protobuf',
      'profiles'
    )
  }

  /**
   * The near-OOM export subprocess only uploads pprof, so it doesn't use this exporter.
   *
   * @returns {URL | undefined}
   */
  getExportUrl () {}

  /**
   * @param {{ otlp?: Buffer, [key: string]: unknown }} exportSpec - The cycle's export, with the encoded
   *   OTLP request. Exports without one, such as near-OOM heap snapshots, which are pprof, are not sent.
   * @returns {Promise<void>}
   */
  async export ({ otlp }) {
    if (otlp === undefined) {
      log.debug('Not exporting a profile without an OTLP request to the OTLP profiles endpoint')
      return
    }
    const result = await new Promise(resolve => this.sendPayload(otlp, resolve))
    if (result.code !== 0) {
      throw result.error
    }
  }
}

module.exports = { OtlpProfilesExporter }
