const { identityService } = require('../util')

function amqpServiceName ({ tracerService }) {
  return `${tracerService}-amqp`
}

const messaging = {
  producer: {
    amqplib: {
      opName: () => 'amqp.command',
      serviceName: amqpServiceName
    },
    amqp10: {
      opName: () => 'amqp.send',
      serviceName: amqpServiceName
    },
    'google-cloud-pubsub': {
      opName: () => 'pubsub.request',
      serviceName: ({ tracerService }) => `${tracerService}-pubsub`
    },
    kafkajs: {
      opName: () => 'kafka.produce',
      serviceName: ({ tracerService }) => `${tracerService}-kafka`
    },
    rhea: {
      opName: () => 'amqp.send',
      serviceName: ({ tracerService }) => `${tracerService}-amqp-producer`
    }
  },
  consumer: {
    amqplib: {
      opName: () => 'amqp.command',
      serviceName: amqpServiceName
    },
    amqp10: {
      opName: () => 'amqp.receive',
      serviceName: amqpServiceName
    },
    'google-cloud-pubsub': {
      opName: () => 'pubsub.receive',
      serviceName: identityService
    },
    kafkajs: {
      opName: () => 'kafka.consume',
      serviceName: ({ tracerService }) => `${tracerService}-kafka`
    },
    rhea: {
      opName: () => 'amqp.receive',
      serviceName: identityService
    }
  },
  client: {
    amqplib: {
      opName: () => 'amqp.command',
      serviceName: amqpServiceName
    },
    'google-cloud-pubsub': {
      opName: () => 'pubsub.request',
      serviceName: ({ tracerService }) => `${tracerService}-pubsub`
    }
  }
}

module.exports = messaging
