'use strict'
const { DsmPathwayCodec, getHeadersSize } = require('../../../dd-trace/src/datastreams')
const log = require('../../../dd-trace/src/log')
const {
  awsServiceSource,
  awsServiceV0,
  awsServiceV1,
  optionServiceSource,
} = require('../../../dd-trace/src/service-naming/helpers')
const BaseAwsSdkPlugin = require('../base')

/**
 * @param {import('../../../dd-trace/src/plugins/tracing').NamingOptions} options
 */
function snsOperationName ({ operation }) {
  return operation === 'publish' || operation === 'publishBatch' ? 'aws.sns.send' : 'aws.sns.request'
}

/** @type {import('../../../dd-trace/src/plugins/tracing').NamingSchema} */
const namingSchema = {
  v0: {
    operationName: () => 'aws.request',
    serviceName: awsServiceV0,
    serviceSource: awsServiceSource,
  },
  v1: {
    operationName: snsOperationName,
    serviceName: awsServiceV1,
    serviceSource: optionServiceSource,
  },
}

class Sns extends BaseAwsSdkPlugin {
  static id = 'sns'
  static peerServicePrecursors = ['topicname']
  static isPayloadReporter = true

  /** @override */
  getNamingSchema () {
    return namingSchema
  }

  generateTags (params, operation, response) {
    if (!params) return

    if (!params.TopicArn && !(response.data && response.data.TopicArn)) return
    const TopicArn = params.TopicArn || response.data.TopicArn

    // Get the topic name from the last `:`-delimited segment of the ARN
    // (e.g. 'my-topic' in 'arn:aws:sns:us-east-1:123456789012:my-topic')
    // without allocating an intermediate parts array.
    const topicName = TopicArn.slice(TopicArn.lastIndexOf(':') + 1)

    return {
      'resource.name': `${operation} ${params.TopicArn || response.data.TopicArn}`,
      'aws.sns.topic_arn': TopicArn,
      'messaging.system': 'aws.sns',
      topicname: topicName,
    }

    // TODO: should arn be sanitized or quantized in some way here,
    // for example if it contains a phone number?
  }

  operationFromRequest (request) {
    return this.operationName({
      awsService: 'sns',
      operation: request.operation,
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
          this.injectToMessage(
            span,
            params.PublishBatchRequestEntries[i],
            params.TopicArn,
            i === 0 || (this.config.batchPropagationEnabled)
          )
        }
        break
    }
  }

  /**
   * @param {import('../../../dd-trace/src/opentracing/span') | null} span
   * @param {{ Message?: string, MessageAttributes?: Record<string, object> }} params
   * @param {string | undefined} topicArn
   * @param {boolean} injectTraceContext
   */
  injectToMessage (span, params, topicArn, injectTraceContext) {
    if (!params.MessageAttributes) {
      params.MessageAttributes = {}
    } else if (Object.keys(params.MessageAttributes).length >= 10) { // SNS quota
      log.info('Message attributes full, skipping trace context injection')
      return
    }

    let ddInfo
    // for now, we only want to inject to the first message, this may change for batches in the future
    if (injectTraceContext) {
      ddInfo = this.tracer.inject(span, 'text_map')
    }

    if (this.config.dsmEnabled) {
      // Add the placeholder before the checkpoint so its payload size includes DD attributes.
      params.MessageAttributes._datadog = {
        DataType: 'Binary',
        BinaryValue: ddInfo ?? {},
      }

      const dataStreamsContext = this.setDSMCheckpoint(span, params, topicArn)
      ddInfo = DsmPathwayCodec.encode(dataStreamsContext, ddInfo) ?? ddInfo
    }

    if (ddInfo) {
      // BINARY types are automatically base64 encoded
      params.MessageAttributes._datadog = {
        DataType: 'Binary',
        BinaryValue: Buffer.from(JSON.stringify(ddInfo)),
      }
    } else if (params.MessageAttributes._datadog) {
      // let's avoid adding any additional information to payload if we failed to inject
      delete params.MessageAttributes._datadog
    }
  }

  setDSMCheckpoint (span, params, topicArn) {
    // only set a checkpoint if publishing to a topic
    if (topicArn) {
      const payloadSize = getHeadersSize(params)
      return this.tracer.setCheckpoint(['direction:out', `topic:${topicArn}`, 'type:sns'], span, payloadSize)
    }
  }
}

module.exports = Sns
