'use strict'

const { LOG } = require('../../../ext/formats')
const { storage } = require('../../datadog-core')
const LogPlugin = require('../../dd-trace/src/plugins/log_plugin')

const legacyStorage = storage('legacy')

class PinoPlugin extends LogPlugin {
  static id = 'pino'

  /**
   * Two subscribers split the work:
   *
   *  - `apm:pino:log:json` is the hot path. Pino publishes the JSON line it
   *    just produced, and we splice `,"dd":<json>` in before the closing
   *    brace. The caller-owned message object is never observed, so a
   *    user `Proxy` (or custom serializer) cannot see our mutation -- there
   *    is no mutation to see.
   *  - `apm:pino:log` is the pretty-print path. `pino-pretty` (bundled with
   *    pino 5/7, separate package on >=8) reads the original message object
   *    rather than the JSON line, so the splice above is invisible to it.
   *    The base `LogPlugin._addLogSubs` already wires this channel to wrap
   *    the object in a `Proxy` that exposes a virtual `dd` field, so reuse
   *    it via `super._addLogSubs()`.
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

    super._addLogSubs()
  }
}

module.exports = PinoPlugin
