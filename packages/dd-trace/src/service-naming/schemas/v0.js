const SchemaDefinition = require('./definition')

function amqpServiceName (service) {
  return `${service}-amqp`
}

const schema = {
  messaging: {
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
        serviceName: service => service
      },
      kafkajs: {
        opName: () => 'kafka.consume',
        serviceName: service => `${service}-kafka`
      },
      rhea: {
        opName: () => 'amqp.receive',
        serviceName: service => service
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
}

module.exports = new SchemaDefinition(schema)
