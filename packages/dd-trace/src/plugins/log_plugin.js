'use strict'

const log = require('../log')
const captureSender = require('../log-capture/sender')
const { buildLogHolder, messageProxy } = require('./log_injection')
const Plugin = require('./plugin')

module.exports = class LogPlugin extends Plugin {
  constructor (...args) {
    super(...args)

    this.addSub(`apm:${this.constructor.id}:log`, (arg) => {
      // Injection is handled by each subclass directly (direct mutation for
      // bunyan/winston, JSON splice + proxy for pino). Only handle capture here.
      // Subclasses may override _captureEnabled to suppress this path and
      // handle capture via their own channel instead (e.g. pino uses
      // apm:pino:log:json so it overrides _captureEnabled to false).
      if (!this._captureEnabled) return

      try {
        const logHolder = buildLogHolder(this.tracer)
        // Enrich the captured record with dd trace context via a temporary
        // proxy that never mutates arg.message.
        const msg = logHolder ? messageProxy(arg.message, logHolder) : arg.message
        this.capture(JSON.stringify(msg))
      } catch (err) {
        log.debug('Log capture serialization error: %s', err.message)
      }
    })
  }

  /**
   * Whether log capture is enabled for this plugin instance.
   * Subclasses may override this to return false and handle capture themselves
   * via a dedicated channel instead.
   *
   * @returns {boolean}
   */
  get _captureEnabled () {
    return !!this.config.logCaptureEnabled
  }

  /**
   * Forward a pre-serialized JSON log record to the capture sender.
   *
   * @param {string} jsonStr Serialized JSON log record.
   * @returns {void}
   */
  capture (jsonStr) {
    captureSender.add(jsonStr)
  }

  configure (config) {
    if (typeof config === 'boolean') {
      return super.configure(config)
    }

    super.configure({
      ...config,
      enabled: config.enabled && (
        config.logInjection ||
        config.DD_AGENTLESS_LOG_SUBMISSION_ENABLED ||
        config.logCaptureEnabled
      ),
    })

  }
}
