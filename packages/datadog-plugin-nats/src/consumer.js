'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { getSizeOrZero } = require('../../dd-trace/src/datastreams')

class NatsConsumerPlugin extends ConsumerPlugin {
  static id = 'nats'
  static prefix = 'tracing:orchestrion:nats:processMsg'

  bindStart (ctx) {
    const meta = this.getTags(ctx)

    const span = this.startSpan({
      meta
    }, ctx)

    this._setConsumerCheckpoint(span, ctx)

    return ctx.currentStore
  }

  getTags (ctx) {
    const rawSubject = ctx.arguments?.[0]?.subject
    const subject = Buffer.isBuffer(rawSubject) ? rawSubject.toString() : rawSubject

    return {
      component: 'nats',
      'span.kind': 'consumer',
      'messaging.system': 'nats',
      'messaging.destination.name': subject,
      'messaging.operation': 'receive'
    }
  }

  /**
   * Sets a DSM checkpoint for a consume operation, decoding pathway context from NATS headers if available.
   * @param {import('../../dd-trace/src/opentracing/span')} span
   * @param {object} ctx
   */
  _setConsumerCheckpoint (span, ctx) {
    if (!this.config.dsmEnabled) return

    const msg = ctx.arguments?.[0]
    const data = ctx.arguments?.[1]
    const rawSubject = msg?.subject
    const subject = Buffer.isBuffer(rawSubject) ? rawSubject.toString() : rawSubject
    const payloadSize = getSizeOrZero(data)

    // In processMsg, msg is a MsgArg with hdr indicating header byte offset in data.
    // When hdr > -1, headers exist as text in data.subarray(0, hdr) in NATS format:
    // "NATS/1.0\r\nKey: Value\r\n\r\n"
    const carrier = this._extractCarrierFromRawHeaders(msg, data)
    if (carrier) {
      this.tracer.decodeDataStreamsContext(carrier)
    }

    const edgeTags = ['direction:in', `topic:${subject}`, 'type:nats']
    this.tracer.setCheckpoint(edgeTags, span, payloadSize)
  }

  /**
   * Extracts DSM pathway context from raw NATS protocol header bytes.
   * @param {object} msg - MsgArg with hdr offset
   * @param {Uint8Array} data - Raw message data including headers
   * @returns {object|undefined} Plain carrier object with dd-pathway-ctx-base64 if found
   */
  _extractCarrierFromRawHeaders (msg, data) {
    if (!msg || msg.hdr <= 0 || !data) return undefined

    try {
      const headerBytes = data.subarray(0, msg.hdr)
      const headerStr = Buffer.from(headerBytes).toString('utf8')
      const lines = headerStr.split('\r\n')

      for (const line of lines) {
        const colonIdx = line.indexOf(':')
        if (colonIdx <= 0) continue
        const key = line.slice(0, colonIdx).trim()
        if (key.toLowerCase() === 'dd-pathway-ctx-base64') {
          const value = line.slice(colonIdx + 1).trim()
          if (value) {
            return { 'dd-pathway-ctx-base64': value }
          }
        }
      }
    } catch {
      // If header parsing fails, proceed without DSM context propagation
    }

    return undefined
  }

  // asyncEnd and end delegate to finish() which has the required guard
  asyncEnd (ctx) {
    this.finish(ctx)
  }

  end (ctx) {
    this.finish(ctx)
  }

  // You may modify this method, but the guard below is REQUIRED and MUST NOT be removed!
  finish (ctx) {
    // CRITICAL GUARD - DO NOT REMOVE: Ensures span only finishes when operation completes
    if (!ctx.hasOwnProperty('result') && !ctx.hasOwnProperty('error')) return

    super.finish(ctx)
  }
}

module.exports = NatsConsumerPlugin
