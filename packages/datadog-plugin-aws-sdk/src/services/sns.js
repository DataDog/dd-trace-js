'use strict'

class Sns {
  generateTags (params, operation, response) {
    const tags = {}

    if (!params) return tags

    if (!params.TopicArn && !(response.data && response.data.TopicArn)) return tags

    return Object.assign(tags, {
      'resource.name': `${operation} ${params.TopicArn || response.data.TopicArn}`,
      'aws.sns.topic_arn': params.TopicArn || response.data.TopicArn
    })

    // TODO: should arn be sanitized or quantized in some way here,
    // for example if it contains a phone number?
  }

  requestInject (span, request, tracer) {
    const operation = request.operation
    if (operation === 'publish' || operation === 'publishBatch') {
      if (!request.params) {
        request.params = {}
      }
      if (!request.params.MessageAttributes) {
        request.params.MessageAttributes = {}
      } else if (Object.keys(request.params.MessageAttributes).length >= 10) { // SNS quota
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

module.exports = Sns
