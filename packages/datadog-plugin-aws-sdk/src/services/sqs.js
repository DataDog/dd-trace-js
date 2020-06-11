'use strict'

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
        response.Messages[0]
      ) {
        const msg = response.Messages[0]
        return tracer.extract('text_map', JSON.parse(msg.MessageAttributes._datadog.StringValue))
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
