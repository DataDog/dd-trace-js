'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const Extractors = require('./extractors')
const { DsmPathwayCodec, getSizeOrZero } = require('../../dd-trace/src/datastreams')

const NATS_URL_KEY = 'nats.url'

class NatsProducerPlugin extends ProducerPlugin {
  static get id () { return 'nats' }
  static operation = 'publish'
  static peerServicePrecursors = [NATS_URL_KEY]

  constructor (...args) {
    super(...args)
    this.registerOperation('tracing:orchestrion:nats:NatsConnectionImpl_publish')
  }

  bindStart (ctx, channel) {
    const options = Extractors[channel]?.(ctx)
    if (!options) return ctx.currentStore

    const span = this.startSpan(`${this.constructor.id}.${this.constructor.operation}`, {
      resource: options.resource,
      type: 'messaging',
      kind: 'producer',
      meta: options.meta
    }, ctx)

    const subject = options.meta?.['messaging.destination.name']
    const serverUrl = getServerUrl(ctx.self)
    if (serverUrl) span.setTag(NATS_URL_KEY, serverUrl)

    this._injectTraceContext(span, ctx)

    if (this.config.dsmEnabled) {
      this._setProducerCheckpoint(span, ctx, subject)
    }

    return ctx.currentStore
  }

  _injectTraceContext (span, ctx) {
    if (!span) return

    const msgOptions = ctx.arguments?.[2]
    if (!msgOptions?.headers) return

    const headersToInject = {}
    this.tracer.inject(span, 'text_map', headersToInject)
    for (const [key, value] of Object.entries(headersToInject)) {
      msgOptions.headers.set(key, value)
    }
  }

  _setProducerCheckpoint (span, ctx, subject) {
    if (!span || !subject) return

    const data = ctx.arguments?.[1]
    const msgOptions = ctx.arguments?.[2]
    const payloadSize = getSizeOrZero(data)

    const dataStreamsContext = this.tracer.setCheckpoint(
      ['direction:out', `topic:${subject}`, 'type:nats'], span, payloadSize
    )

    if (msgOptions?.headers) {
      const dsmHeaders = {}
      DsmPathwayCodec.encode(dataStreamsContext, dsmHeaders)
      for (const [key, value] of Object.entries(dsmHeaders)) {
        msgOptions.headers.set(key, value)
      }
    }
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

function getServerUrl (nc) {
  if (!nc) return null
  try {
    const server = nc.protocol?.servers?.getCurrentServer?.()
    if (server) {
      const hostname = server.hostname || server.host
      if (hostname) return server.port ? `${hostname}:${server.port}` : hostname
    }
    if (nc.protocol?.server) {
      const srv = nc.protocol.server
      const hostname = srv.hostname || srv.host
      if (hostname) return srv.port ? `${hostname}:${srv.port}` : hostname
    }
    const servers = nc.options?.servers || nc._options?.servers
    if (Array.isArray(servers) && servers.length > 0) return servers[0]
    if (typeof servers === 'string') return servers
  } catch {}
  return null
}

module.exports = NatsProducerPlugin
