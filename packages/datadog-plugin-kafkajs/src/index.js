'use strict'
function createWrapProducer (tracer, config) {
  return function wrapProducer (createProducer) {
    return function producerWithTrace () {
      const serviceName = config.service || `${tracer._service}-kafka`
      const createdProducer = createProducer.apply(this, arguments)

      const send = createdProducer.send

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

        return tracer.wrap('kafka.producer.send', { tags }, () =>
          send(...args)
        )
      }

      return createdProducer
    }
  }
}

function createWrapConsumer (tracer, config) {
  return function wrapProcessEachMessage (Consumer) {
    return function processEachMessageWithTrace () {
      const consumer = Consumer.apply(this, arguments)
      const run = consumer.run

      consumer.run = async function ({ eachMessage, ...args }) {
        // return the promise
        return run({
          eachMessage: tracer.wrap('kafka', {}, eachMessage),
          args
        })
      }

      return consumer
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
