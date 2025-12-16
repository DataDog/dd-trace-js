'use strict'

const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const Extractors = require('./extractors')
const { getSizeOrZero } = require('../../dd-trace/src/datastreams')

class NatsConsumerPlugin extends ConsumerPlugin {
  static get id () { return 'nats' }
  static operation = 'processMsg'

  constructor (...args) {
    super(...args)
    this.registerOperation('tracing:orchestrion:nats:ProtocolHandler_processMsg')
  }

  bindStart (ctx, channel) {
    const options = Extractors[channel]?.(ctx)
    if (!options) return ctx.currentStore

    const msg = ctx.arguments?.[0]
    const data = ctx.arguments?.[1]
    const subject = options.meta?.['messaging.destination.name']
    const plainHeaders = extractHeaders(msg, data)

    const childOf = plainHeaders ? this.tracer.extract('text_map', plainHeaders) : undefined

    const span = this.startSpan(`${this.constructor.id}.${this.constructor.operation}`, {
      childOf,
      resource: options.resource,
      type: 'worker',
      kind: 'consumer',
      meta: options.meta
    }, ctx)

    if (this.config.dsmEnabled) {
      if (plainHeaders) {
        this.tracer.decodeDataStreamsContext(plainHeaders)
      }
      const payloadSize = msg?.hdr > 0 ? getSizeOrZero(data?.subarray?.(msg.hdr)) : getSizeOrZero(data)
      this.tracer.setCheckpoint(['direction:in', `topic:${subject}`, 'type:nats'], span, payloadSize)
    }

    return ctx.currentStore
  }

  end (ctx) {
    this.finish(ctx)
  }

  error (ctx) {
    const span = ctx?.currentStore?.span
    if (span && ctx.error) {
      this.addError(ctx.error, span)
    }
  }
}

function headersToPlainObject (headers) {
  if (!headers) return null
  if (typeof headers.keys === 'function' && typeof headers.get === 'function') {
    const plainObj = {}
    for (const key of headers.keys()) {
      plainObj[key] = headers.get(key)
    }
    return plainObj
  }
  return headers
}

function decodeHeadersFromRawData (msg, data) {
  if (!msg || msg.hdr <= 0 || !data) return null
  try {
    const headerBytes = data.subarray(0, msg.hdr)
    const headerStr = new TextDecoder().decode(headerBytes)
    const lines = headerStr.split('\r\n')
    const headers = {}
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      if (line) {
        const colonIdx = line.indexOf(':')
        if (colonIdx > 0) {
          headers[line.slice(0, colonIdx)] = line.slice(colonIdx + 1).trim()
        }
      }
    }
    return Object.keys(headers).length > 0 ? headers : null
  } catch {
    return null
  }
}

function extractHeaders (msg, data) {
  let headers = headersToPlainObject(msg?.headers)
  if (!headers && msg?.hdr > 0 && data) {
    headers = decodeHeadersFromRawData(msg, data)
  }
  return headers
}

module.exports = NatsConsumerPlugin
