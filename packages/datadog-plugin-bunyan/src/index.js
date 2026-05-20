'use strict'

const { LOG } = require('../../../ext/formats')
const { storage } = require('../../datadog-core')
const LogPlugin = require('../../dd-trace/src/plugins/log_plugin')

const legacyStorage = storage('legacy')

class BunyanPlugin extends LogPlugin {
  static id = 'bunyan'

  /**
   * Inject `dd` directly on the record object bunyan hands us, instead of
   * wrapping it in a `Proxy`. bunyan builds the record inside `mkRecord` via
   * `objCopy(log.fields)` and then copies the caller's fields onto the
   * result, so the `rec` object that flows through `_emit` is always
   * bunyan-owned, has `Object.prototype` for its prototype, and is never
   * the caller's input directly. Mutating it adds `dd` for every consumer
   * (JSON streams via `JSON.stringify(rec)`, raw streams via the record
   * reference) without paying for a Proxy view.
   *
   * @override
   */
  _addLogSubs () {
    this.addSub('apm:bunyan:log', (arg) => {
      const rec = arg.message
      if (rec === null || typeof rec !== 'object' || Object.hasOwn(rec, 'dd')) return

      const holder = {}
      this.tracer.inject(legacyStorage.getStore()?.span, LOG, holder)

      const dd = holder.dd
      if (dd === undefined || Object.keys(dd).length === 0) return

      rec.dd = dd
    })
  }
}

module.exports = BunyanPlugin
