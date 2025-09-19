'use strict'

const { format } = require('util')

// other times we produce an Error in a central location and log it several other places
class NoTransmitError extends Error {}

class Log {
  constructor (message, args, cause, delegate, sendViaTelemetry = true) {
    this.message = message
    this.args = args
    this.cause = cause
    this.delegate = delegate
    this.sendViaTelemetry = sendViaTelemetry
  }

  get formatted () {
    const { message, args } = this

    let formatted = message
    if (message && args && args.length) {
      formatted = format(message, ...args)
    }
    return formatted
  }

  static parse (...args) {
    let message, cause, delegate
    let sendViaTelemetry = true

    {
      const lastArg = args.at(-1)
      if (lastArg instanceof LogConfig) {
        args.pop()
        sendViaTelemetry = lastArg.transmit
      }
    }

    {
      const lastArg = args.at(-1)
      if (lastArg && typeof lastArg === 'object' && lastArg.stack) { // lastArg instanceof Error?
        cause = args.pop()
        if (cause instanceof NoTransmitError) sendViaTelemetry = false
      }
    }

    const firstArg = args.shift()
    if (firstArg) {
      if (typeof firstArg === 'string') {
        message = firstArg
      } else if (typeof firstArg === 'object') { // eslint-disable-line eslint-rules/eslint-safe-typeof-object
        message = String(firstArg.message || firstArg)
      } else if (typeof firstArg === 'function') {
        delegate = firstArg
      } else {
        message = String(firstArg)
      }
    } else if (!cause) {
      message = String(firstArg)
    }

    return new Log(message, args, cause, delegate, sendViaTelemetry)
  }
}

/**
 * Pass instances of this class to logger methods when fine-grain control is needed
 * @property {boolean} transmit - Whether to send the log via telemetry.
 */
class LogConfig {
  constructor (transmit = true) {
    this.transmit = transmit
  }
}

module.exports = {
  Log,
  LogConfig,
  NoTransmitError,
}
