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
  producer: {
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
    rhea: amqpOutbound,
    sqs: {
      opName: () => 'aws.sqs.send',
      serviceName: identityService
    },
    sns: {
      opName: () => 'aws.sns.send',
      serviceName: identityService
    }
  },
  consumer: {
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
    rhea: amqpInbound,
    sqs: {
      opName: () => 'aws.sqs.process',
      serviceName: identityService
    }
  },
  client: {
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
