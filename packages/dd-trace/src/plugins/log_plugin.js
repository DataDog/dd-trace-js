'use strict'

const log = require('../log')
const captureSender = require('../log-capture/sender')
const { buildLogHolder, messageProxy } = require('./log_injection')
const Plugin = require('./plugin')

module.exports = class LogPlugin extends Plugin {
  constructor (...args) {
    super(...args)

    this.addSub(`apm:${this.constructor.id}:log`, (arg) => {
      const logHolder = buildLogHolder(this.tracer)

      arg.holder = logHolder

      // Only mutate the actual log record when log injection is requested.
      if (this.config.logInjection && logHolder) {
        arg.message = messageProxy(arg.message, logHolder)
      }

      // Forward to capture sender.
      // Subclasses may override _captureEnabled to suppress this path
      // and handle capture via their own channel instead.
      if (this._captureEnabled && logHolder) {
        try {
          const msg = this.config.logInjection ? arg.message : messageProxy(arg.message, logHolder)
          this.capture(JSON.stringify(msg))
        } catch (err) {
          log.debug('Log capture serialization error: %s', err.message)
        }
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
    super.configure({
      ...config,
      enabled: config.enabled && (
        config.logInjection ||
        config.DD_AGENTLESS_LOG_SUBMISSION_ENABLED ||
        config.logCaptureEnabled
      ),
    })

    return this
  }
}
