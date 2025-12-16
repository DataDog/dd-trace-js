'use strict'

function natsconnectionimplPublishProducer (ctx) {
  const subject = ctx.arguments?.[0]
  return {
    operation: 'publish',
    resource: subject || 'publish',
    meta: {
      component: 'nats',
      'span.kind': 'producer',
      'messaging.system': 'nats',
      'messaging.destination.name': subject,
      'messaging.operation': 'publish'
    }
  }
}

function protocolhandlerProcessmsgConsumer (ctx) {
  const msg = ctx.arguments?.[0]
  const subject = msg?.subject?.toString?.() || msg?.subject

  return {
    operation: 'processMsg',
    resource: subject || 'processMsg',
    meta: {
      component: 'nats',
      'span.kind': 'consumer',
      'messaging.system': 'nats',
      'messaging.destination.name': subject,
      'messaging.operation': 'process'
    }
  }
}

module.exports = {
  'tracing:orchestrion:nats:NatsConnectionImpl_publish': natsconnectionimplPublishProducer,
  'tracing:orchestrion:nats:ProtocolHandler_processMsg': protocolhandlerProcessmsgConsumer
}
