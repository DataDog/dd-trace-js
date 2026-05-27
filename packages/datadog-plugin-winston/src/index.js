'use strict'

const { buildLogHolder, messageProxy } = require('../../dd-trace/src/plugins/log_injection')
const LogPlugin = require('../../dd-trace/src/plugins/log_plugin')

class WinstonPlugin extends LogPlugin {
  static id = 'winston'

  constructor (...args) {
    super(...args)
    this.addSub('apm:winston:log', (arg) => this.handleLog(arg))
  }

  /**
   * The prototype + extensibility check is load-bearing. The Proxy
   * fallback keeps `dd` off caller-owned objects (Error, Set, Map, any
   * user class) and out of non-extensible records, where a strict-mode
   * write would throw and `Plugin.addSub` would react by disabling the
   * plugin for the rest of the process.
   *
   * @param {{ message: unknown }} arg
   */
  handleLog (arg) {
    const info = arg.message
    if (info === null || typeof info !== 'object' || Object.hasOwn(info, 'dd')) return

    const logHolder = buildLogHolder(this.tracer)
    if (!logHolder) return

    if (Object.getPrototypeOf(info) === Object.prototype && Object.isExtensible(info)) {
      info.dd = logHolder.dd
    } else {
      arg.message = messageProxy(info, logHolder)
    }
  }
}

module.exports = WinstonPlugin
