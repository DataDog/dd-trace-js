'use strict'

const { LOG } = require('../../../ext/formats')
const { storage } = require('../../datadog-core')
const LogPlugin = require('../../dd-trace/src/plugins/log_plugin')
const { messageProxy } = LogPlugin

const legacyStorage = storage('legacy')

class WinstonPlugin extends LogPlugin {
  static id = 'winston'

  /**
   * The prototype + extensibility check is load-bearing. The Proxy
   * fallback keeps `dd` off caller-owned objects (Error, Set, Map, any
   * user class) and out of non-extensible records, where a strict-mode
   * write would throw and `Plugin.addSub` would react by disabling the
   * plugin for the rest of the process.
   *
   * @override
   */
  _addLogSubs () {
    this.addSub('apm:winston:log', (arg) => {
      const info = arg.message
      if (info === null || typeof info !== 'object' || Object.hasOwn(info, 'dd')) return

      const holder = {}
      this.tracer.inject(legacyStorage.getStore()?.span, LOG, holder)

      const dd = holder.dd
      if (dd === undefined || Object.keys(dd).length === 0) return

      if (Object.getPrototypeOf(info) === Object.prototype && Object.isExtensible(info)) {
        info.dd = dd
      } else {
        arg.message = messageProxy(info, holder)
      }
    })
  }
}

module.exports = WinstonPlugin
