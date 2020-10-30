'use strict'

function createWrapRequest (tracer, config) {
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

function createProducerRequestTimeoutTags ({
  broker,
  clientId,
  correlationId,
  createdAt,
  sentAt,
  pendingDuration,
  apiName,
  apiVersion
}) {
  return {
    'kafka.broker': broker,
    'kafka.clientId': clientId,
    'kafka.correlationId': correlationId,
    'kafka.message.createdAt': createdAt,
    'kafka.message.sentAt': sentAt,
    'kafka.pendingDuration': pendingDuration,
    'kafka.apiName': apiName,
    'kafka.apiVersion': apiVersion
  }
}

function createProducerRequestQueueSizeTags ({ broker, clientId, queueSize }) {
  return {
    'kafka.broker': broker,
    'kafka.clientId': clientId,
    'kafka.queueSize': queueSize
  }
}
// eslint-disable-next-line max-len
function createProducerRequestTags ({
  broker,
  clientId,
  correlationId,
  size,
  createdAt,
  sentAt,
  pendingDuration,
  duration,
  apiName,
  apiVersion
}) {
  return {
    'kafka.broker': broker,
    'kafka.clientId': clientId,
    'kafka.correlationId': correlationId,
    'kafka.message.size': size,
    'kafka.message.createdAt': createdAt,
    'kafka.message.sentAt': sentAt,
    'kafka.pendingDuration': pendingDuration,
    'kafka.duration': duration,
    'kafka.apiName': apiName,
    'kafka.apiVersion': apiVersion
  }
}

function addCommonProducerTags (serviceName, resourceName, tagCreatorFn) {
  const restOfTags = tagCreatorFn ? tagCreatorFn() : {}

  return {
    'service.name': serviceName,
    'resource.name': resourceName,
    'span.kind': 'producer',
    'span.type': 'queue',
    component: 'kafkajs',
    ...restOfTags
  }
}

module.exports = [
  {
    name: 'kafkajs',
    versions: ['>=1.2'],
    patch ({ Kafka }, tracer, config) {
      this.wrap(Kafka.prototype, 'producer', createWrapRequest(tracer, config))
      this.wrap(Kafka.prototype, 'consumer', createWrapRequest(tracer, config))
      this.wrap(Kafka.prototype, 'admin', createWrapRequest(tracer, config))
    },
    unpatch ({ Kafka }) {
      this.unwrap(Kafka.prototype, 'producer')
      this.unwrap(Kafka.prototype, 'consumer')
      this.unwrap(Kafka.prototype, 'admin')
    }
  }
]
