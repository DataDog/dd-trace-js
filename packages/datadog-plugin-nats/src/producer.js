'use strict'

const { TEXT_MAP } = require('../../../ext/formats')
const { CLIENT_PORT_KEY } = require('../../dd-trace/src/constants')
const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const { getOperationName } = require('./util')

const MESSAGING_DESTINATION_KEY = 'messaging.destination.name'

class NatsProducerPlugin extends ProducerPlugin {
  static id = 'nats'
  static operation = 'publish'
  static peerServicePrecursors = [MESSAGING_DESTINATION_KEY]

  bindStart (ctx) {
    const { subject, options, connection, type, createHeaders } = ctx
    const server = connection?.protocol?.servers?.getCurrent?.() ??
      connection?.protocol?.servers?.getCurrentServer?.()
    const operation = getOperationName(type)

    const span = this.startSpan({
      resource: subject,
      meta: {
        component: 'nats',
        'nats.subject': subject,
        'nats.operation': operation,
        [MESSAGING_DESTINATION_KEY]: subject,
        'out.host': server?.hostname,
      },
    }, ctx)

    if (server?.port) {
      span.setTag(CLIENT_PORT_KEY, server.port)
    }

    if (this.serverSupportsHeaders(connection)) {
      let headers = options.headers
      if (!headers && typeof createHeaders === 'function') {
        headers = createHeaders()
        options.headers = headers
      }
      if (headers && typeof headers.set === 'function') {
        const carrier = {}
        this.tracer.inject(span, TEXT_MAP, carrier)
        for (const key of Object.keys(carrier)) {
          headers.set(key, carrier[key])
        }
      }
    }

    return ctx.currentStore
  }

  serverSupportsHeaders (connection) {
    const info = connection?.protocol?.info
    // If info isn't available yet (e.g. publish before INFO), assume supported — modern NATS does.
    if (!info) return true
    return info.headers !== false
  }
}

module.exports = NatsProducerPlugin
