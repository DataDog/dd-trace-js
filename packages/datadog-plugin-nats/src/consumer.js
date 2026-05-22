'use strict'

const { TEXT_MAP } = require('../../../ext/formats')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { headersToTextMap } = require('./util')

const MESSAGING_DESTINATION_KEY = 'messaging.destination.name'

class NatsConsumerPlugin extends ConsumerPlugin {
  static id = 'nats'
  static operation = 'consume'

  bindStart (ctx) {
    const { subject, message } = ctx
    const carrier = headersToTextMap(message?.headers)
    const childOf = carrier ? this.tracer.extract(TEXT_MAP, carrier) : null

    this.startSpan({
      childOf,
      resource: subject,
      type: 'worker',
      meta: {
        component: 'nats',
        'nats.subject': subject,
        [MESSAGING_DESTINATION_KEY]: subject,
      },
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = NatsConsumerPlugin
