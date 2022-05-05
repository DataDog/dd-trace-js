'use strict'
const log = require('../../../dd-trace/src/log')
const BaseAwsSdkPlugin = require('../base')

class Sns extends BaseAwsSdkPlugin {
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

  requestInject (span, request) {
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
      this.tracer.inject(span, 'text_map', ddInfo)
      injectPath.MessageAttributes._datadog = {
        DataType: 'Binary',
        BinaryValue: JSON.stringify(ddInfo) // BINARY types are automatically base64 encoded
      }
    }
  }
}

module.exports = Sns
