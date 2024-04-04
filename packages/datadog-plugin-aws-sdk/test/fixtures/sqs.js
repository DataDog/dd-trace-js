'use strict'

const sqs = {}

sqs.create = {
  QueueName: 'SQS_QUEUE_NAME',
  Attributes: {
    MessageRetentionPeriod: '86400'
  }
}

sqs.get = {
  QueueUrl: undefined
}

module.exports = sqs
