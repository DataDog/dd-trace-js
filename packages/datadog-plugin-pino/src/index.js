'use strict'

const { buildHolder, messageProxy } = require('../../dd-trace/src/plugins/log_injection')
const LogPlugin = require('../../dd-trace/src/plugins/log_plugin')

class PinoPlugin extends LogPlugin {
  static id = 'pino'

  constructor (...args) {
    super(...args)
    this.addSub('apm:pino:log:json', (payload) => this.handleJsonLine(payload))
    this.addSub('apm:pino:log', (arg) => this.handlePrettyMessage(arg))
  }

  /**
   * Splice `,"dd":<json>` into the JSON line pino has already produced.
   * The caller-owned message object is never observed -- user Proxies and
   * custom serialisers see nothing because there is no mutation to see.
   *
   * @param {{ line: string }} payload
   */
  handleJsonLine (payload) {
    const holder = buildHolder(this.tracer)
    if (!holder) return

    const line = payload.line
    const lastClose = line.lastIndexOf('}')
    if (lastClose < 1) return

    const ddJson = JSON.stringify(holder.dd)
    const sep = line.charCodeAt(lastClose - 1) === 0x7B ? '' : ','
    payload.line = line.slice(0, lastClose) + sep + '"dd":' + ddJson + line.slice(lastClose)
  }

  /**
   * `pino-pretty` (bundled with pino 5/7, separate package on >=8) reads
   * the original message object rather than the JSON line, so the splice
   * above is invisible to it. Wrap the message in a Proxy that exposes a
   * virtual `dd` field for the prettifier to pick up.
   *
   * @param {{ message: object }} arg
   */
  handlePrettyMessage (arg) {
    const holder = buildHolder(this.tracer)
    if (!holder) return

    arg.message = messageProxy(arg.message, holder)
  }
}

module.exports = PinoPlugin
