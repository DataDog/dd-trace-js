'use strict'

const { TEXT_MAP } = require('../../../ext/formats')
const ConsumerPlugin = require('../../dd-trace/src/plugins/consumer')
const { headersToTextMap } = require('./util')

const MESSAGING_DESTINATION_KEY = 'messaging.destination.name'

class NatsConsumerPlugin extends ConsumerPlugin {
  static id = 'nats'
  static operation = 'consume'

  bindStart (ctx) {
    const { subject: filter, message } = ctx
    // For wildcard subscriptions (e.g. `orders.*`), `filter` is the subscription
    // pattern but `message.subject` is the actual delivered subject. Prefer the
    // delivered one for resource/destination so spans aren't all collapsed under
    // the wildcard pattern. Fall back to the filter if the message is missing it.
    const subject = typeof message?.subject === 'string' ? message.subject : filter
    const carrier = headersToTextMap(message?.headers)
    const childOf = carrier ? this.tracer.extract(TEXT_MAP, carrier) : null

    const meta = {
      component: 'nats',
      'nats.subject': subject,
      [MESSAGING_DESTINATION_KEY]: subject,
    }
    if (filter && filter !== subject) {
      meta['nats.subscription.subject'] = filter
    }

    this.startSpan({
      childOf,
      resource: subject,
      type: 'worker',
      meta,
    }, ctx)

    return ctx.currentStore
  }
}

module.exports = NatsConsumerPlugin
