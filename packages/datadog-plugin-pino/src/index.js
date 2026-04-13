'use strict'

const { storage } = require('../../datadog-core')
const { LOG } = require('../../../ext/formats')
const LogPlugin = require('../../dd-trace/src/plugins/log_plugin')
const log = require('../../dd-trace/src/log')

const PINO_JSON_CHANNEL = 'apm:pino:json'

class PinoPlugin extends LogPlugin {
  static id = 'pino'

  constructor (...args) {
    super(...args)

    this.addSub(PINO_JSON_CHANNEL, ({ json, holder: payloadHolder }) => {
      if (!this.config.logCaptureEnabled) return

      if (!this.config.logInjection) {
        // dd was not injected into the serialized JSON (logInjection is off).
        // Enrich the captured record with trace context before forwarding.
        // payloadHolder is set for pino <5.14.0 (wrapAsJson path); for >=5.14.0
        // (wrapAsJsonForCapture) it is undefined, so re-inject from the current context.
        let captureHolder = payloadHolder
        if (!captureHolder) {
          captureHolder = {}
          this.tracer.inject(storage('legacy').getStore()?.span, LOG, captureHolder)
        }
        if (captureHolder.dd) {
          try {
            const parsed = JSON.parse(json)
            parsed.dd = captureHolder.dd
            this.capture(JSON.stringify(parsed))
            return
          } catch (err) {
            log.debug('Log capture serialization error: %s', err.message)
          }
        }
      }

      this.capture(json)
    })
  }

  /**
   * Disable the generic apm:${id}:log capture path for pino.
   *
   * Pino's apm:pino:json channel is used instead because it provides the fully-serialized
   * JSON record. This covers all standard pino output (JSON mode, pino-pretty transport,
   * and piped streams) since pino always calls asJson internally before delivering to any
   * destination — so apm:pino:json fires in every case.
   *
   * The apm:pino:log channel cannot be used for capture because for pino >=5.14.0 it fires
   * from the mixin hook with only partial data (the mixin fields, not the full log record).
   *
   * @returns {false}
   */
  get _captureEnabled () {
    return false
  }
}

module.exports = PinoPlugin
