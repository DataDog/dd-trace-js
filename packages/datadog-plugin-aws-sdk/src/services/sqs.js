'use strict'

const log = require('../../../dd-trace/src/log')

class Sqs {
  generateTags (params, operation, response) {
    const tags = {}

    if (!params || (!params.QueueName && !params.QueueUrl)) return tags

    return Object.assign(tags, {
      'resource.name': `${operation} ${params.QueueName || params.QueueUrl}`,
      'aws.sqs.queue_name': params.QueueName || params.QueueUrl
    })
  }

  responseExtract (params, operation, response, tracer) {
    if (operation === 'receiveMessage') {
      if (
        (!params.MaxNumberOfMessages || params.MaxNumberOfMessages === 1) &&
        response &&
        response.Messages &&
        response.Messages[0] &&
        response.Messages[0].MessageAttributes &&
        response.Messages[0].MessageAttributes._datadog &&
        response.Messages[0].MessageAttributes._datadog.StringValue
      ) {
        const textMap = response.Messages[0].MessageAttributes._datadog.StringValue
        try {
          return tracer.extract('text_map', JSON.parse(textMap))
        } catch (err) {
          log.error(err)
          return undefined
        }
      }
    }
  }

  requestInject (span, request, tracer) {
    const operation = request.operation
    if (operation === 'sendMessage') {
      if (!request.params) {
        request.params = {}
      }
      if (!request.params.MessageAttributes) {
        request.params.MessageAttributes = {}
      } else if (Object.keys(request.params.MessageAttributes).length >= 10) { // SQS quota
        // TODO: add test when the test suite is fixed
        return
      }
      const ddInfo = {}
      tracer.inject(span, 'text_map', ddInfo)
      request.params.MessageAttributes._datadog = {
        DataType: 'String',
        StringValue: JSON.stringify(ddInfo)
      }
    }
  }
}

module.exports = Sqs
