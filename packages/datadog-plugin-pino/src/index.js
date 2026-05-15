'use strict'

const { LOG } = require('../../../ext/formats')
const { storage } = require('../../datadog-core')
const LogPlugin = require('../../dd-trace/src/plugins/log_plugin')

const legacyStorage = storage('legacy')

class PinoPlugin extends LogPlugin {
  static id = 'pino'

  /**
   * Inject `dd` by splicing the trace-correlation fields into the JSON line
   * pino just produced, rather than wrapping the caller-owned message in a
   * `Proxy`. Pino's instrumentation publishes the JSON line once `asJson`
   * has run, so the caller's message object is never observed -- a downstream
   * user `Proxy` (or any custom serializer) cannot see our mutation because
   * there is no mutation to see.
   *
   * @override
   */
  _addLogSubs () {
    this.addSub('apm:pino:log:json', (payload) => {
      const holder = {}
      this.tracer.inject(legacyStorage.getStore()?.span, LOG, holder)

      // `tracer.inject` always assigns `holder.dd = {}`; skip the splice
      // when nothing was added (no span, no service / version / env).
      const dd = holder.dd
      if (dd === undefined || Object.keys(dd).length === 0) return

      const line = payload.line
      // Pino emits compact JSON ending in `}\n` or `}`. Splice
      // `,"dd":<json>` (or `"dd":<json>` for a `{}`-empty message) in
      // before the closing brace.
      const lastClose = line.lastIndexOf('}')
      if (lastClose < 1) return

      const ddJson = JSON.stringify(dd)
      const sep = line.charCodeAt(lastClose - 1) === 0x7B ? '' : ','
      payload.line = line.slice(0, lastClose) + sep + '"dd":' + ddJson + line.slice(lastClose)
    })
  }
}

module.exports = PinoPlugin
