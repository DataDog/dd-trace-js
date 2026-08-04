'use strict'

const { buildLogHolder } = require('../../dd-trace/src/plugins/log_injection')
const LogPlugin = require('../../dd-trace/src/plugins/log_plugin')

class BunyanPlugin extends LogPlugin {
  static id = 'bunyan'

  constructor (...args) {
    super(...args)
    this.addSub('apm:bunyan:log', (arg) => this.handleLog(arg))
  }

  /**
   * Inject `dd` directly on the record bunyan hands us. bunyan builds the
   * record inside `mkRecord` via `objCopy(log.fields)` and then copies the
   * caller's fields onto the result, so the `rec` object that flows
   * through `_emit` is always bunyan-owned, has `Object.prototype` for its
   * prototype, and is never the caller's input directly. Mutating it adds
   * `dd` for every consumer (JSON streams via `JSON.stringify(rec)`, raw
   * streams via the record reference) without paying for a Proxy view.
   *
   * @param {{ message: object }} arg
   */
  handleLog (arg) {
    const rec = arg.message
    if (rec === null || typeof rec !== 'object' || Object.hasOwn(rec, 'dd')) return

    const logHolder = buildLogHolder(this.tracer)
    if (!logHolder) return

    rec.dd = logHolder.dd
  }
}

module.exports = BunyanPlugin
