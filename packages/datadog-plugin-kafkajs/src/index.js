'use strict'
const {
  producer: {
    addCommonProducerTags,
    createProducerRequestTags,
    createProducerRequestTimeoutTags
  },
  consumer: {
    createConsumerStartBatchProcessTags,
    addCommonConsumerTags,
    createConsumerEndBatchProcessTags
  }
} = require('./utils')

function createWrapProducer (tracer, config) {
  return function wrapProducer (createProducer) {
    return function producerWithTrace () {
      const serviceName = config.service || `${tracer._service}-kafka`
      const createdProducer = createProducer.apply(this, arguments)

      const { REQUEST, REQUEST_TIMEOUT } = createdProducer.events

      // I don't think I can get the topic we are producing to from KafkaJS Instrumentation events
      createdProducer.on(REQUEST, ({ type, payload }) =>
        tracer.trace(type, {
          tags: addCommonProducerTags(
            serviceName,
            'Producer Request to [TOPIC]',
            createProducerRequestTags(payload)
          )
        })
      )

      createdProducer.on(REQUEST_TIMEOUT, ({ type, payload }) =>
        tracer.trace(type, {
          tags: addCommonProducerTags(
            serviceName,
            'Producer Request Queue Size',
            createProducerRequestTimeoutTags(payload)
          )
        })
      )

      return createdProducer
    }
  }
}

function createWrapConsumer (tracer, config) {
  return function wrapConsumer (createConsumer) {
    return function consumerWithTrace () {
      const serviceName = config.service || `${tracer._service}-kafka`
      const createdConsumer = createConsumer.apply(this, arguments)

      const { START_BATCH_PROCESS, END_BATCH_PROCESS } = createdConsumer.events

      createdConsumer.on(START_BATCH_PROCESS, ({ type, payload }) =>
        tracer.trace(type, {
          tags: addCommonConsumerTags(
            serviceName,
            'Consumer start batch process',
            createConsumerStartBatchProcessTags(payload)
          )
        })
      )

      createdConsumer.on(END_BATCH_PROCESS, ({ type, payload }) =>
        tracer.trace(type, {
          tags: addCommonConsumerTags(
            serviceName,
            'Consumer end batch process',
            createConsumerEndBatchProcessTags(payload)
          )
        })
      )

      return createdConsumer
    }
  }
}

module.exports = [
  {
    name: 'kafkajs',
    versions: ['>=1.2'],
    patch ({ Kafka }, tracer, config) {
      this.wrap(
        Kafka.prototype,
        'producer',
        createWrapProducer(tracer, config)
      )
      this.wrap(
        Kafka.prototype,
        'consumer',
        createWrapConsumer(tracer, config)
      )
      this.wrap(Kafka.prototype, 'admin', createWrapProducer(tracer, config))
    },
    unpatch ({ Kafka }) {
      this.unwrap(Kafka.prototype, 'producer')
      this.unwrap(Kafka.prototype, 'consumer')
    }
  }
]
