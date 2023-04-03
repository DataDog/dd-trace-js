const { identityService } = require('../util')

const amqpInbound = {
  opName: () => 'amqp.process',
  serviceName: identityService
}

const amqpOutbound = {
  opName: () => 'amqp.send',
  serviceName: identityService
}

const messaging = {
  outbound: {
    amqplib: amqpOutbound,
    amqp10: amqpOutbound,
    'google-cloud-pubsub': {
      opName: () => 'gcp.pubsub.send',
      serviceName: identityService
    },
    kafkajs: {
      opName: () => 'kafka.send',
      serviceName: identityService
    },
    rhea: amqpOutbound
  },
  inbound: {
    amqplib: amqpInbound,
    amqp10: amqpInbound,
    'google-cloud-pubsub': {
      opName: () => 'gcp.pubsub.process',
      serviceName: identityService
    },
    kafkajs: {
      opName: () => 'kafka.process',
      serviceName: identityService
    },
    rhea: amqpInbound
  },
  controlPlane: {
    amqplib: {
      opName: () => 'amqp.command',
      serviceName: identityService
    },
    'google-cloud-pubsub': {
      opName: () => 'gcp.pubsub.request',
      serviceName: identityService
    }
  }
}

module.exports = messaging
