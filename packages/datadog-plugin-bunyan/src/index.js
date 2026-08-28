'use strict'

const { buildLogHolder } = require('../../dd-trace/src/plugins/log_injection')
const LogPlugin = require('../../dd-trace/src/plugins/log_plugin')

class BunyanPlugin extends LogPlugin {
  static id = 'bunyan'

  constructor (...args) {
    super(...args)
    this.addSub(`apm:${this.constructor.id}:log`, (arg) => this.handleLog(arg))
  }

  /**
   * Inject `dd` directly on the record Bunyan implementations hand us. They build the record
   * inside `mkRecord` from a copy of the logger and caller fields, so the `rec` object that flows
   * through `_emit` is always logger-owned. Mutating it adds `dd` for every consumer without
   * paying for a Proxy view.
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
