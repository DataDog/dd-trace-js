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
    const { operation, params } = request

    if (!params) return

    switch (operation) {
      case 'publish':
        this._injectMessageAttributes(span, params)
        break
      case 'publishBatch':
        if (params.PublishBatchRequestEntries && params.PublishBatchRequestEntries.length > 0) {
          this._injectMessageAttributes(span, params.PublishBatchRequestEntries[0])
        }
        break
    }
  }

  _injectMessageAttributes (span, params) {
    if (!params.MessageAttributes) {
      params.MessageAttributes = {}
    }
    if (Object.keys(params.MessageAttributes).length >= 10) { // SNS quota
      log.info('Message attributes full, skipping trace context injection')
      return
    }
    const ddInfo = {}
    this.tracer.inject(span, 'text_map', ddInfo)
    params.MessageAttributes._datadog = {
      DataType: 'Binary',
      BinaryValue: Buffer.from(JSON.stringify(ddInfo)) // BINARY types are automatically base64 encoded
    }
  }
}

module.exports = Sns
