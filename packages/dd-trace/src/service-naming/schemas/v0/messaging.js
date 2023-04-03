const { identityService } = require('../util')

function amqpServiceName (service) {
  return `${service}-amqp`
}

const messaging = {
  outbound: {
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
      serviceName: service => `${service}-pubsub`
    },
    kafkajs: {
      opName: () => 'kafka.produce',
      serviceName: service => `${service}-kafka`
    },
    rhea: {
      opName: () => 'amqp.send',
      serviceName: service => `${service}-amqp-producer`
    }
  },
  inbound: {
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
      serviceName: service => `${service}-kafka`
    },
    rhea: {
      opName: () => 'amqp.receive',
      serviceName: identityService
    }
  },
  controlPlane: {
    amqplib: {
      opName: () => 'amqp.command',
      serviceName: amqpServiceName
    },
    'google-cloud-pubsub': {
      opName: () => 'pubsub.request',
      serviceName: service => `${service}-pubsub`
    }
  }
}

module.exports = messaging
