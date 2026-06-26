'use strict'

const { buildLogHolder, messageProxy } = require('../../dd-trace/src/plugins/log_injection')
const LogPlugin = require('../../dd-trace/src/plugins/log_plugin')

class PinoPlugin extends LogPlugin {
  static id = 'pino'

  constructor (...args) {
    super(...args)
    this.addSub('apm:pino:log:json', (payload) => this.handleJsonLine(payload))
    this.addSub('apm:pino:log', (arg) => this.handlePrettyMessage(arg))
  }

  /**
   * Disable the generic apm:${id}:log capture path for pino.
   *
   * Pino's apm:pino:log:json channel provides the fully-serialized JSON line
   * and is used for both injection and capture in handleJsonLine.
   * This prevents double-capture from the LogPlugin base class subscriber.
   *
   * @returns {false}
   */
  get _captureEnabled () {
    return false
  }

  /**
   * Splice `,"dd":<json>` into the JSON line pino has already produced,
   * and optionally capture the complete record for log forwarding.
   * The caller-owned message object is never observed -- user Proxies and
   * custom serialisers see nothing because there is no mutation to see.
   *
   * @param {{ line: string }} payload
   */
  handleJsonLine (payload) {
    const shouldInject = this.config.logInjection
    const shouldCapture = this.config.logCaptureEnabled

    if (!shouldInject && !shouldCapture) return

    const logHolder = buildLogHolder(this.tracer)

    if (shouldInject && logHolder) {
      const line = payload.line
      const lastClose = line.lastIndexOf('}')
      if (lastClose >= 1) {
        const ddJson = JSON.stringify(logHolder.dd)
        const sep = line.charCodeAt(lastClose - 1) === 0x7B ? '' : ','
        payload.line = line.slice(0, lastClose) + sep + '"dd":' + ddJson + line.slice(lastClose)
      }
    }

    if (shouldCapture) {
      if (!shouldInject && logHolder) {
        // Enrich the captured record with dd context without modifying the actual log line.
        const line = payload.line
        const lastClose = line.lastIndexOf('}')
        if (lastClose >= 1) {
          const ddJson = JSON.stringify(logHolder.dd)
          const sep = line.charCodeAt(lastClose - 1) === 0x7B ? '' : ','
          this.capture(line.slice(0, lastClose) + sep + '"dd":' + ddJson + line.slice(lastClose))
          return
        }
      }
      // If injection already happened, payload.line includes dd; otherwise capture raw.
      this.capture(payload.line)
    }
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
    const logHolder = buildLogHolder(this.tracer)
    if (!logHolder) return

    arg.message = messageProxy(arg.message, logHolder)
  }
}

module.exports = PinoPlugin
