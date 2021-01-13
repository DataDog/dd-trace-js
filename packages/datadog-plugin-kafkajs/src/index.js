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
        'component': 'kafkajs'
      }

      producer.send = tracer.wrap('kafka.produce', { tags }, function (...args) {
        const { topic, messages = [] } = args[0]
        const currentSpan = tracer.scope().active()

        currentSpan.addTags({
          'resource.name': topic,
          'kafka.topic': topic,
          'kafka.batch_size': messages.length
        })

        for (const message of messages) {
          message.headers = message.headers || {}
          tracer.inject(currentSpan, 'text_map', message.headers)
        }

        return send.apply(this, args)
      })

      return producer
    }
  }
}

function createWrapConsumer (tracer, config) {
  return function wrapConsumer (createConsumer) {
    return function consumerWithTrace () {
      const serviceName = config.service || `${tracer._service}-kafka`
      const consumer = createConsumer.apply(this, arguments)
      const run = consumer.run

      const tags = {
        'service.name': serviceName,
        'span.kind': 'consumer',
        'span.type': 'worker',
        'component': 'kafkajs'
      }

      consumer.run = function ({ eachMessage, ...runArgs }) {
        if (typeof eachMessage !== 'function') return run({ eachMessage, ...runArgs })

        return run({
          eachMessage: function (...eachMessageArgs) {
            const { topic, partition, message } = eachMessageArgs[0]
            const childOf = extract(tracer, message.headers)

            return tracer.trace('kafka.consume', { childOf, tags }, () => {
              const currentSpan = tracer.scope().active()

              currentSpan.addTags({
                'resource.name': topic,
                'kafka.topic': topic,
                'kafka.partition': partition,
                'kafka.message.offset': message.offset
              })

              return eachMessage.apply(this, eachMessageArgs)
            })
          },
          ...runArgs
        })
      }

      return consumer
    }
  }
}

function extract (tracer, bufferMap) {
  if (!bufferMap) return null

  const textMap = {}

  for (const key of Object.keys(bufferMap)) {
    textMap[key] = bufferMap[key].toString()
  }

  return tracer.extract('text_map', textMap)
}

module.exports = [
  {
    name: 'kafkajs',
    versions: ['>=1.4'],
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
