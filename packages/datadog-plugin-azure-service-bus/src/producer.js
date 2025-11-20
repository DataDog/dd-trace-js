'use strict'

const ProducerPlugin = require('../../dd-trace/src/plugins/producer')
const spanContexts = new WeakMap()

class AzureServiceBusProducerPlugin extends ProducerPlugin {
  static get id () { return 'azure-service-bus' }
  static get operation () { return 'send' }
  static get prefix () { return 'tracing:apm:azure-service-bus:send' }

  bindStart (ctx) {
    // we do not want to make these spans when batch linking is disabled.
    if (!this.batchLinksAreEnabled() && ctx.functionName === 'tryAddMessage') {
      return ctx.currentStore
    }

    const qualifiedSenderNamespace = ctx.config.host
    const span = this.startSpan({
      resource: ctx.entityPath,
      type: 'messaging',
      meta: {
        component: 'azure-service-bus',
        'messaging.destination.name': ctx.entityPath,
        'messaging.operation': 'send',
        'messaging.system': 'servicebus',
        'network.destination.name': qualifiedSenderNamespace,
      }
    }, ctx)

    if (ctx.functionName === 'tryAddMessage') {
      span._spanContext._name = 'azure.servicebus.create'
      span.setTag('messaging.operation', 'create')

      if (ctx.msg.messageID !== undefined) {
        span.setTag('message.id', ctx.msg)
      }

      if (this.batchLinksAreEnabled()) {
        const spanContext = spanContexts.get(ctx.batch)
        if (spanContext) {
          spanContext.push(span.context())
        } else {
          spanContexts.set(ctx.batch, [span.context()])
        }
        injectTraceContext(this.tracer, span, ctx.msg)
      }
    }

    if (ctx.functionName === 'send' || ctx.functionName === 'sendBatch' || ctx.functionName === 'scheduleMessages') {
      const messages = ctx.msg
      const isBatch = messages.constructor?.name === 'ServiceBusMessageBatchImpl'
      if (isBatch) {
        span.setTag('messaging.batch.message_count', messages.count)
        if (this.batchLinksAreEnabled()) {
          const contexts = spanContexts.get(messages)
          if (contexts) {
            for (const spanContext of contexts) {
              span.addLink(spanContext)
            }
          }
        }
      } else if (Array.isArray(messages)) {
        span.setTag('messaging.batch.message_count', messages.length)
        messages.forEach(event => {
          injectTraceContext(this.tracer, span, event)
        })
      } else {
        injectTraceContext(this.tracer, span, messages)
      }
    }
    return ctx.currentStore
  }

  asyncEnd (ctx) {
    super.finish(ctx)
  }

  batchLinksAreEnabled () {
    return this._tracerConfig?.trace?.azure?.serviceBus?.batchLinksEnabled !== false
  }
}

function injectTraceContext (tracer, span, msg) {
  if (!msg.applicationProperties) {
    msg.applicationProperties = {}
  }

  tracer.inject(span, 'text_map', msg.applicationProperties)
}

module.exports = AzureServiceBusProducerPlugin
