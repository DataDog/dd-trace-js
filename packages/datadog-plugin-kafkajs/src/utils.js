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

function addCommonConsumerTags (serviceName, resourceName, tagCreatorFn) {
  const restOfTags = tagCreatorFn ? tagCreatorFn() : {}

  return {
    'service.name': serviceName,
    'resource.name': resourceName,
    'span.kind': 'consumer',
    'span.type': 'queue',
    component: 'kafkajs',
    ...restOfTags
  }
}
function createConsumerStartBatchProcessTags ({
  batchSize,
  firstOffset,
  highWatermark,
  lastOffset,
  offsetLag,
  offsetLagLow,
  partition,
  topic
}) {
  return {
    'kafka.batch.highWatermark': highWatermark,
    'kafka.batch.size': batchSize,
    'kafka.batch.firstOffset': firstOffset,
    'kafka.batch.lastOffset': lastOffset,
    'kafka.batch.offsetLag': offsetLag,
    'kafka.batch.offsetLagLow': offsetLagLow,
    'kafka.partition': partition,
    'kafka.topic': topic
  }
}

function createConsumerEndBatchProcessTags ({
  batchSize,
  firstOffset,
  highWatermark,
  lastOffset,
  offsetLag,
  offsetLagLow,
  partition,
  topic,
  duration
}) {
  return {
    ...createConsumerStartBatchProcessTags({
      batchSize,
      firstOffset,
      highWatermark,
      lastOffset,
      offsetLag,
      offsetLagLow,
      partition,
      topic
    }),
    'kafka.duration': duration
  }
}

const consumer = {
  addCommonConsumerTags,
  createConsumerStartBatchProcessTags,
  createConsumerEndBatchProcessTags
}

const producer = {
  createProducerRequestTimeoutTags,
  createProducerRequestTags,
  addCommonProducerTags
}

module.exports = {
  producer,
  consumer
}
