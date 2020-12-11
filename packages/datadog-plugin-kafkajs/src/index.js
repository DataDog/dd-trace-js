'use strict'

function createWrapProducer (tracer, config) {
  return function wrapProducer (createProducer) {
    return function producerWithTrace () {
      const serviceName = config.service || `${tracer._service}-kafka`
      const producer = createProducer.apply(this, arguments)

      const send = producer.send

      const tags = {
        'service.name': serviceName,
        'span.kind': 'producer',
        'span.type': 'queue',
        component: 'kafka'
      }

      producer.send = tracer.wrap('kafka.produce', { tags }, function (...args) {
        const { topic, messages } = args[0]
        const currentSpan = tracer.scope().active()

        currentSpan.addTags({
          'resource.name': topic,
          'kafka.topic': topic,
          'kafka.batch.size': messages.length
        }
        )
        return send.apply(this, args)
      })

      return producer
    }
  }
}

function createWrapConsumer (tracer, config) {
  return function wrapProcessEachMessage (Consumer) {
    return function processEachMessageWithTrace () {
      const serviceName = config.service || `${tracer._service}-kafka`
      const consumer = Consumer.apply(this, arguments)
      const run = consumer.run

      const tags = {
        'service.name': serviceName,
        'span.kind': 'consumer',
        'span.type': 'queue',
        component: 'kafka'
      }

      consumer.run = async function ({ eachMessage, ...args }) {
        return run({
          eachMessage: tracer.wrap('kafka.consume', { tags }, function (...eachMessageArgs) {
            const { topic, partition, message } = eachMessageArgs[0]
            const currentSpan = tracer.scope().active()

            currentSpan.addTags({
              'resource.name': topic,
              'kafka.topic': topic,
              'kafka.partition': partition,
              'kafka.message.offset': message.offset
            })

            return eachMessage.apply(this, eachMessageArgs)
          }),
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
