'use strict'

const { identityService, awsServiceV0, awsServiceSource } = require('../util')

function amqpServiceName ({ tracerService }) {
  return `${tracerService}-amqp`
}

function integrationSource (source) {
  return () => source
}

const messaging = {
  producer: {
    amqplib: {
      opName: () => 'amqp.command',
      serviceName: amqpServiceName,
      serviceSource: integrationSource('amqp'),
    },
    amqp10: {
      opName: () => 'amqp.send',
      serviceName: amqpServiceName,
      serviceSource: integrationSource('amqp'),
    },
    'azure-event-hubs': {
      opName: () => 'azure.eventhubs.send',
      serviceName: ({ tracerService }) => `${tracerService}-azure-event-hubs`,
      serviceSource: integrationSource('azure-event-hubs'),
    },
    'azure-service-bus': {
      opName: () => 'azure.servicebus.send',
      serviceName: ({ tracerService }) => `${tracerService}-azure-service-bus`,
      serviceSource: integrationSource('azure-service-bus'),
    },
    'google-cloud-pubsub': {
      opName: () => 'pubsub.request',
      serviceName: ({ tracerService }) => `${tracerService}-pubsub`,
      serviceSource: integrationSource('google-cloud-pubsub'),
    },
    kafkajs: {
      opName: () => 'kafka.produce',
      serviceName: ({ tracerService }) => `${tracerService}-kafka`,
      serviceSource: integrationSource('kafka'),
    },
    'confluentinc-kafka-javascript': {
      opName: () => 'kafka.produce',
      serviceName: ({ tracerService }) => `${tracerService}-kafka`,
      serviceSource: integrationSource('kafka'),
    },
    rhea: {
      opName: () => 'amqp.send',
      serviceName: ({ tracerService }) => `${tracerService}-amqp-producer`,
      serviceSource: integrationSource('amqp'),
    },
    sqs: {
      opName: () => 'aws.request',
      serviceName: awsServiceV0,
      serviceSource: awsServiceSource,
    },
    sns: {
      opName: () => 'aws.request',
      serviceName: awsServiceV0,
      serviceSource: awsServiceSource,
    },
    bullmq: {
      opName: () => 'bullmq.add',
      serviceName: ({ tracerService }) => `${tracerService}-bullmq`,
      serviceSource: integrationSource('bullmq'),
    },
  },
  consumer: {
    amqplib: {
      opName: () => 'amqp.command',
      serviceName: amqpServiceName,
      serviceSource: integrationSource('amqp'),
    },
    amqp10: {
      opName: () => 'amqp.receive',
      serviceName: amqpServiceName,
      serviceSource: integrationSource('amqp'),
    },
    'google-cloud-pubsub': {
      opName: () => 'pubsub.receive',
      serviceName: identityService,
    },
    kafkajs: {
      opName: () => 'kafka.consume',
      serviceName: ({ tracerService }) => `${tracerService}-kafka`,
      serviceSource: integrationSource('kafka'),
    },
    'confluentinc-kafka-javascript': {
      opName: () => 'kafka.consume',
      serviceName: ({ tracerService }) => `${tracerService}-kafka`,
      serviceSource: integrationSource('kafka'),
    },
    rhea: {
      opName: () => 'amqp.receive',
      serviceName: identityService,
    },
    sqs: {
      opName: () => 'aws.request',
      serviceName: awsServiceV0,
      serviceSource: awsServiceSource,
    },
    bullmq: {
      opName: () => 'bullmq.processJob',
      serviceName: ({ tracerService }) => `${tracerService}-bullmq`,
      serviceSource: awsServiceSource,
    },
  },
  client: {
    amqplib: {
      opName: () => 'amqp.command',
      serviceName: amqpServiceName,
      serviceSource: integrationSource('amqp'),
    },
    'google-cloud-pubsub': {
      opName: () => 'pubsub.request',
      serviceName: ({ tracerService }) => `${tracerService}-pubsub`,
      serviceSource: integrationSource('google-cloud-pubsub'),
    },
  },
}

module.exports = messaging
