'use strict'
const log = require('../../../dd-trace/src/log')

class Sns {
  generateTags (params, operation, response) {
    if (!params) return {}

    if (!params.TopicArn && !(response.data && response.data.TopicArn)) return {}

    return {
      'resource.name': `${operation} ${params.TopicArn || response.data.TopicArn}`,
      'aws.sns.topic_arn': params.TopicArn || response.data.TopicArn
    }

    // TODO: should arn be sanitized or quantized in some way here,
    // for example if it contains a phone number?
  }

  requestInject (span, request, tracer) {
    const operation = request.operation
    if (operation === 'publish' || operation === 'publishBatch') {
      if (!request.params) {
        request.params = {}
      }
      let injectPath
      if (request.params.PublishBatchRequestEntries && request.params.PublishBatchRequestEntries.length > 0) {
        injectPath = request.params.PublishBatchRequestEntries[0]
      } else if (request.params.Message) {
        injectPath = request.params
      }
      if (!injectPath.MessageAttributes) {
        injectPath.MessageAttributes = {}
      }
      if (Object.keys(injectPath.MessageAttributes).length >= 10) { // SNS quota
        log.info('Message attributes full, skipping trace context injection')
        return
      }
      const ddInfo = {}
      tracer.inject(span, 'text_map', ddInfo)
      const b64EncodedTraceContext = Buffer.from(JSON.stringify(ddInfo), 'ascii').toString('base64')
      injectPath.MessageAttributes._datadog = {
        DataType: 'Binary',
        StringValue: b64EncodedTraceContext
      }
    }
  }
}

module.exports = Sns
