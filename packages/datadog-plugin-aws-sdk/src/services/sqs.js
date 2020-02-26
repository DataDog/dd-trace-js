'use strict'

const BaseService = require('./base')

class SqsService extends BaseService {
  _addServiceTags (params, operation, response) {
    const tags = {}

    // sqs queue
    if (!params || (!params.QueueName && !params.QueueUrl)) return tags

    return Object.assign(tags, {
      'resource.name': `${operation} ${params.QueueName || params.QueueUrl}`,
      'aws.sqs.queue_name': params.QueueName || params.QueueUrl
    })
  }
}

module.exports = SqsService
