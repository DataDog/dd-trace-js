'use strict'

const { identityService, awsServiceV0 } = require('../util')

function amqpServiceName (opts) {
  opts.srvSrc = 'amqplib'
  return `${opts.tracerService}-amqp`
}

const messaging = {
  producer: {
    amqplib: {
      opName: () => 'amqp.command',
      serviceName: amqpServiceName,
    },
    amqp10: {
      opName: () => 'amqp.send',
      serviceName: (opts) => {
        opts.srvSrc = 'amqp10'
        return `${opts.tracerService}-amqp`
      },
    },
    'azure-event-hubs': {
      opName: () => 'azure.eventhubs.send',
      serviceName: (opts) => {
        opts.srvSrc = 'azure-event-hubs'
        return `${opts.tracerService}-azure-event-hubs`
      },
    },
    'azure-service-bus': {
      opName: () => 'azure.servicebus.send',
      serviceName: (opts) => {
        opts.srvSrc = 'azure-service-bus'
        return `${opts.tracerService}-azure-service-bus`
      },
    },
    'google-cloud-pubsub': {
      opName: () => 'pubsub.request',
      serviceName: (opts) => {
        opts.srvSrc = 'google-cloud-pubsub'
        return `${opts.tracerService}-pubsub`
      },
    },
    kafkajs: {
      opName: () => 'kafka.produce',
      serviceName: (opts) => {
        opts.srvSrc = 'kafkajs'
        return `${opts.tracerService}-kafka`
      },
    },
    'confluentinc-kafka-javascript': {
      opName: () => 'kafka.produce',
      serviceName: (opts) => {
        opts.srvSrc = 'confluentinc-kafka-javascript'
        return `${opts.tracerService}-kafka`
      },
    },
    rhea: {
      opName: () => 'amqp.send',
      serviceName: (opts) => {
        opts.srvSrc = 'rhea'
        return `${opts.tracerService}-amqp-producer`
      },
    },
    sqs: {
      opName: () => 'aws.request',
      serviceName: awsServiceV0,
    },
    sns: {
      opName: () => 'aws.request',
      serviceName: awsServiceV0,
    },
    bullmq: {
      opName: () => 'bullmq.add',
      serviceName: (opts) => {
        opts.srvSrc = 'bullmq'
        return `${opts.tracerService}-bullmq`
      },
    },
  },
  consumer: {
    amqplib: {
      opName: () => 'amqp.command',
      serviceName: amqpServiceName,
    },
    amqp10: {
      opName: () => 'amqp.receive',
      serviceName: (opts) => {
        opts.srvSrc = 'amqp10'
        return `${opts.tracerService}-amqp`
      },
    },
    'google-cloud-pubsub': {
      opName: () => 'pubsub.receive',
      serviceName: identityService,
    },
    kafkajs: {
      opName: () => 'kafka.consume',
      serviceName: (opts) => {
        opts.srvSrc = 'kafkajs'
        return `${opts.tracerService}-kafka`
      },
    },
    'confluentinc-kafka-javascript': {
      opName: () => 'kafka.consume',
      serviceName: (opts) => {
        opts.srvSrc = 'confluentinc-kafka-javascript'
        return `${opts.tracerService}-kafka`
      },
    },
    rhea: {
      opName: () => 'amqp.receive',
      serviceName: identityService,
    },
    sqs: {
      opName: () => 'aws.request',
      serviceName: awsServiceV0,
    },
    bullmq: {
      opName: () => 'bullmq.processJob',
      serviceName: (opts) => {
        opts.srvSrc = 'bullmq'
        return `${opts.tracerService}-bullmq`
      },
    },
  },
  client: {
    amqplib: {
      opName: () => 'amqp.command',
      serviceName: amqpServiceName,
    },
    'google-cloud-pubsub': {
      opName: () => 'pubsub.request',
      serviceName: (opts) => {
        opts.srvSrc = 'google-cloud-pubsub'
        return `${opts.tracerService}-pubsub`
      },
    },
  },
}

module.exports = messaging
