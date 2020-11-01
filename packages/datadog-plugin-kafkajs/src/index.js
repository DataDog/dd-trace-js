'use strict'
const {
  producer: {
    addCommonProducerTags,
    createProducerRequestQueueSizeTags,
    createProducerRequestTags,
    createProducerRequestTimeoutTags
  }
} = require('./utils')

function createWrapProducer (tracer, config) {
  return function wrapProducer (createProducer) {
    return function producerWithTrace () {
      const serviceName = config.service || `${tracer._service}-kafka`
      const createdProducer = createProducer.apply(this, arguments)

      const {
        REQUEST,
        DISCONNECT,
        CONNECT,
        REQUEST_QUEUE_SIZE,
        REQUEST_TIMEOUT
      } = createdProducer.events

      // Listening to all events emitted by KafkaJS
      createdProducer.on(CONNECT, ({ type }) =>
        tracer.trace(type, {
          tags: addCommonProducerTags(serviceName, 'Producer Connected')
        })
      )
      // I don't think I can get this from KafkaJS Instrumentation events
      createdProducer.on(REQUEST, ({ type, payload }) =>
        tracer.trace(type, {
          tags: addCommonProducerTags(
            serviceName,
            'Producer Request to [TOPIC]',
            createProducerRequestTags(payload)
          )
        })
      )
      createdProducer.on(DISCONNECT, ({ type }) =>
        tracer.trace(type, {
          tags: addCommonProducerTags(serviceName, 'Producer Disconnected')
        })
      )
      createdProducer.on(REQUEST_QUEUE_SIZE, ({ type, payload }) =>
        tracer.trace(type, {
          tags: addCommonProducerTags(
            serviceName,
            'Producer Request Queue Size',
            createProducerRequestQueueSizeTags(payload)
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
        createWrapProducer(tracer, config)
      )
      this.wrap(Kafka.prototype, 'admin', createWrapProducer(tracer, config))
    },
    unpatch ({ Kafka }) {
      this.unwrap(Kafka.prototype, 'producer')
      this.unwrap(Kafka.prototype, 'consumer')
      this.unwrap(Kafka.prototype, 'admin')
    }
  }
]
