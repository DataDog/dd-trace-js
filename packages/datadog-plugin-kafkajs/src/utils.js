
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

const producer = {
  createProducerRequestTimeoutTags,
  createProducerRequestQueueSizeTags,
  createProducerRequestTags,
  addCommonProducerTags
}

module.exports = {
  producer
}
