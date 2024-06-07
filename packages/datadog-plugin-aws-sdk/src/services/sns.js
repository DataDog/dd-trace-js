'use strict'
const { getHeadersSize } = require('../../../dd-trace/src/datastreams/processor')
const { DsmPathwayCodec } = require('../../../dd-trace/src/datastreams/pathway')
const log = require('../../../dd-trace/src/log')
const BaseAwsSdkPlugin = require('../base')

class Sns extends BaseAwsSdkPlugin {
  static get id () { return 'sns' }
  static get peerServicePrecursors () { return ['topicname'] }

  generateTags (params, operation, response) {
    if (!params) return {}

    if (!params.TopicArn && !(response.data && response.data.TopicArn)) return {}
    const TopicArn = params.TopicArn || response.data.TopicArn

    // Split the ARN into its parts
    // ex.'arn:aws:sns:us-east-1:123456789012:my-topic'
    const arnParts = TopicArn.split(':')

    // Get the topic name from the last part of the ARN
    const topicName = arnParts[arnParts.length - 1]
    return {
      'resource.name': `${operation} ${params.TopicArn || response.data.TopicArn}`,
      'aws.sns.topic_arn': TopicArn,
      topicname: topicName
    }

    // TODO: should arn be sanitized or quantized in some way here,
    // for example if it contains a phone number?
  }

  operationFromRequest (request) {
    switch (request.operation) {
      case 'publish':
      case 'publishBatch':
        return this.operationName({
          type: 'messaging',
          kind: 'producer'
        })
    }

    return this.operationName({
      id: 'aws',
      type: 'web',
      kind: 'client',
      awsService: 'sns'
    })
  }

  requestInject (span, request) {
    const { operation, params } = request

    if (!params) return

    switch (operation) {
      case 'publish':
        this.injectToMessage(span, params, params.TopicArn, true)
        break
      case 'publishBatch':
        for (let i = 0; i < params.PublishBatchRequestEntries.length; i++) {
          this.injectToMessage(span, params.PublishBatchRequestEntries[i], params.TopicArn, i === 0)
        }
        break
    }
  }

  injectToMessage (span, params, topicArn, injectTraceContext) {
    if (!params.MessageAttributes) {
      params.MessageAttributes = {}
    }
    if (Object.keys(params.MessageAttributes).length >= 10) { // SNS quota
      log.info('Message attributes full, skipping trace context injection')
      return
    }

    const ddInfo = {}
    // for now, we only want to inject to the first message, this may change for batches in the future
    if (injectTraceContext) {
      this.tracer.inject(span, 'text_map', ddInfo)
      // add ddInfo before checking DSM so we can include DD attributes in payload size
      params.MessageAttributes._datadog = {
        DataType: 'Binary',
        BinaryValue: ddInfo
      }
    }

    if (this.config.dsmEnabled) {
      if (!params.MessageAttributes._datadog) {
        params.MessageAttributes._datadog = {
          DataType: 'Binary',
          BinaryValue: ddInfo
        }
      }

      const dataStreamsContext = this.setDSMCheckpoint(span, params, topicArn)
      DsmPathwayCodec.encode(dataStreamsContext, ddInfo)
    }

    if (Object.keys(ddInfo).length !== 0) {
      // BINARY types are automatically base64 encoded
      params.MessageAttributes._datadog.BinaryValue = Buffer.from(JSON.stringify(ddInfo))
    } else if (params.MessageAttributes._datadog) {
      // let's avoid adding any additional information to payload if we failed to inject
      delete params.MessageAttributes._datadog
    }
  }

  setDSMCheckpoint (span, params, topicArn) {
    // only set a checkpoint if publishing to a topic
    if (topicArn) {
      const payloadSize = getHeadersSize(params)
      const dataStreamsContext = this.tracer
        .setCheckpoint(['direction:out', `topic:${topicArn}`, 'type:sns'], span, payloadSize)
      return dataStreamsContext
    }
  }
}

module.exports = Sns
