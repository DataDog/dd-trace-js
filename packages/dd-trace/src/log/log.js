'use strict'

const { format } = require('util')

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
      if (lastArg && typeof lastArg === 'object' && lastArg.stack) { // lastArg instanceof Error?
        cause = args.pop()
      }
    }

    if (args.length >= 2) {
      const meta = args.at(-1)
      if (meta && typeof meta === 'object') {
        args.pop()
        sendViaTelemetry = meta.transmit !== false
      }
    }

    const firstArg = args.shift()
    if (firstArg) {
      if (typeof firstArg === 'string') {
        message = firstArg
      } else if (typeof firstArg === 'object') {
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

module.exports = {
  Log
}
