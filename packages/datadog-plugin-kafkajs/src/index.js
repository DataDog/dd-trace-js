'use strict'
const {
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

      createdProducer.send = (...args) => {
        const { topic, messages } = args[0]

        const tags = {
          'service.name': serviceName,
          'resource.name': `produce to ${topic}`,
          'span.kind': 'producer',
          'span.type': 'queue',
          component: 'kafka',
          'kafka.topic': topic,
          'kafka.batch.size': messages.length
        }

        return tracer.trace('kafka.producer.send', { tags }, () => createdProducer.send(...args))
      }

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

      createdConsumer.on(START_BATCH_PROCESS, ({ type, payload }) => {
        const childOf = tracer.scope().active()

        tracer.trace(type, {
          tags: addCommonConsumerTags(
            serviceName,
            'Consumer start batch process',
            createConsumerStartBatchProcessTags(payload)
          ),
          childOf
        })
      })

      createdConsumer.on(END_BATCH_PROCESS, ({ type, payload }) => {
        const childOf = tracer.scope().active()

        tracer.trace(type, {
          tags: addCommonConsumerTags(
            serviceName,
            'Consumer end batch process',
            createConsumerEndBatchProcessTags(payload)
          ),
          childOf
        })
      })

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
    },
    unpatch ({ Kafka }) {
      this.unwrap(Kafka.prototype, 'producer')
      this.unwrap(Kafka.prototype, 'consumer')
    }
  }
]
