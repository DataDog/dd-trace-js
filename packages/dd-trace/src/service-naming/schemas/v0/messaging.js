'use strict'

const { identityService, awsServiceV0 } = require('../util')

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
    'azure-event-hubs': {
      opName: () => 'azure.eventhubs.send',
      serviceName: ({ tracerService }) => `${tracerService}-azure-event-hubs`
    },
    'azure-service-bus': {
      opName: () => 'azure.servicebus.send',
      serviceName: ({ tracerService }) => `${tracerService}-azure-service-bus`
    },
    'google-cloud-pubsub': {
      opName: () => 'pubsub.request',
      serviceName: ({ tracerService }) => `${tracerService}-pubsub`
    },
    kafkajs: {
      opName: () => 'kafka.produce',
      serviceName: ({ tracerService }) => `${tracerService}-kafka`
    },
    'confluentinc-kafka-javascript': {
      opName: () => 'kafka.produce',
      serviceName: ({ tracerService }) => `${tracerService}-kafka`
    },
    '@nats-io/nats-core': {
      opName: () => 'nats.publish',
      serviceName: ({ tracerService }) => `${tracerService}-nats`
    },
    rhea: {
      opName: () => 'amqp.send',
      serviceName: ({ tracerService }) => `${tracerService}-amqp-producer`
    },
    sqs: {
      opName: () => 'aws.request',
      serviceName: awsServiceV0
    },
    sns: {
      opName: () => 'aws.request',
      serviceName: awsServiceV0
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
    'confluentinc-kafka-javascript': {
      opName: () => 'kafka.consume',
      serviceName: ({ tracerService }) => `${tracerService}-kafka`
    },
    '@nats-io/nats-core': {
      opName: () => 'nats.process',
      serviceName: ({ tracerService }) => `${tracerService}-nats`
    },
    rhea: {
      opName: () => 'amqp.receive',
      serviceName: identityService
    },
    sqs: {
      opName: () => 'aws.request',
      serviceName: awsServiceV0
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
    },
    '@nats-io/nats-core': {
      opName: () => 'nats.request',
      serviceName: ({ tracerService }) => `${tracerService}-nats`
    }
  }
}

module.exports = messaging
