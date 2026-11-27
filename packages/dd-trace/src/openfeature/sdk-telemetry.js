'use strict'

const { VERSION } = require('../../../../version')
const SDKDiagnosticsWriter = require('./writers/sdk-diagnostics')

/** @param {unknown} value */
function validIdentity (value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    value.trim() === value && !/\p{Cc}/u.test(value)
}

/** Adds tracer identity and delivers observations measured by the provider. */
class SDKTelemetry {
  #config
  #writer
  #started = false
  #closed = false

  /** @param {import('../config/config-base')} config */
  static create (config) {
    if (!validIdentity(config.service) || !validIdentity(config.env)) return
    return new SDKTelemetry(config)
  }

  /** @param {import('../config/config-base')} config */
  constructor (config) {
    this.#config = config
  }

  start () {
    if (this.#closed || this.#started) return
    this.#started = true
    try {
      // Start discovery with initialization, as evaluation delivery does.
      this.#writer = new SDKDiagnosticsWriter(this.#config)
    } catch { /* Diagnostics must not affect provider initialization. */ }
  }

  /** @param {import('@datadog/openfeature-node-server').SDKDiagnostic} observation */
  emit (observation) {
    if (this.#closed) return
    const { service, env } = this.#config
    if (!validIdentity(service) || !validIdentity(env)) return
    try {
      this.#writer?.append({
        type: 'sdk_diagnostic',
        schema_version: 1,
        payload: {
          ...observation,
          sdk_name: 'dd-trace-js',
          sdk_version: VERSION,
          service_id: service,
          environment: env,
        },
      })
    } catch { /* Diagnostics must not affect provider behavior. */ }
  }

  close () {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#writer?.destroy()
    } catch { /* Diagnostics must not affect provider shutdown. */ }
  }
}

module.exports = SDKTelemetry
