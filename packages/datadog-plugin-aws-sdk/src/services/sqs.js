'use strict'

const log = require('../../../dd-trace/src/log')
const BaseAwsSdkPlugin = require('../base')
const { DsmPathwayCodec, getHeadersSize } = require('../../../dd-trace/src/datastreams')

class Sqs extends BaseAwsSdkPlugin {
  static id = 'sqs'
  static peerServicePrecursors = ['queuename']
  static isPayloadReporter = true

  constructor (...args) {
    super(...args)
    //
    // TODO(bengl) Find a way to create the response span tags without this WeakMap being populated
    // in the base class
    this.requestTags = new WeakMap()

    this.addBind('apm:aws:response:start:sqs', ctx => {
      const { request, response } = ctx
      const contextExtraction = this.responseExtract(request.params, request.operation, response)

      let store = this._parentMap.get(request)
      let span
      let parsedMessageAttributes = null
      if (contextExtraction && contextExtraction.datadogContext) {
        ctx.needsFinish = true
        const options = {
          childOf: contextExtraction.datadogContext,
          meta: {
            ...this.requestTags.get(request),
            'span.kind': 'server'
          },
          integrationName: 'aws-sdk'
        }
        parsedMessageAttributes = contextExtraction.parsedAttributes
        span = this.startSpan('aws.response', options, ctx)
        store = ctx.currentStore
      }

      // extract DSM context after as we might not have a parent-child but may have a DSM context
      this.responseExtractDSMContext(
        request.operation, request.params, response, span || null, { parsedAttributes: parsedMessageAttributes }
      )

      return store
    })

    this.addSub('apm:aws:response:finish:sqs', ctx => {
      if (!ctx.needsFinish) return
      this.finish(ctx)
    })
  }

  operationFromRequest (request) {
    switch (request.operation) {
      case 'receiveMessage':
        return this.operationName({
          type: 'messaging',
          kind: 'consumer'
        })
      case 'sendMessage':
      case 'sendMessageBatch':
        return this.operationName({
          type: 'messaging',
          kind: 'producer'
        })
    }

    return this.operationName({
      id: 'aws',
      type: 'web',
      kind: 'client',
      awsService: 'sqs'
    })
  }

  isEnabled (request) {
    // TODO(bengl) Figure out a way to make separate plugins for consumer and producer so that
    // config can be isolated to `.configure()` instead of this whole isEnabled() thing.
    const config = this.config
    switch (request.operation) {
      case 'receiveMessage':
        return config.consumer !== false
      case 'sendMessage':
      case 'sendMessageBatch':
        return config.producer !== false
      default:
        return true
    }
  }

  generateTags (params, operation, response) {
    if (!params || (!params.QueueName && !params.QueueUrl)) return {}

    const queueMetadata = params.QueueUrl && this.extractQueueMetadata(params.QueueUrl)
    const queueName = queueMetadata?.queueName || params.QueueName

    const tags = {
      'resource.name': `${operation} ${params.QueueName || params.QueueUrl}`,
      'aws.sqs.queue_name': params.QueueName || params.QueueUrl,
      queuename: queueName,
    }

    if (queueMetadata?.arn) {
      tags['cloud.resource_id'] = queueMetadata.arn
    }

    switch (operation) {
      case 'receiveMessage':
        tags['span.type'] = 'worker'
        tags['span.kind'] = 'consumer'
        break
      case 'sendMessage':
      case 'sendMessageBatch':
        tags['span.kind'] = 'producer'
        break
    }

    return tags
  }

  extractQueueMetadata (queueUrl) {
    if (!queueUrl) return null

    // 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue';
    const parts = queueUrl.split('/')
    if (parts.length < 5) return null

    const queueName = parts[4]
    const accountId = parts[3]
    const hostname = parts[2]

    // Only build ARN if we can extract region from a real AWS URL
    if (hostname.includes('.amazonaws.com')) {
      const hostParts = hostname.split('.')
      if (hostParts.length >= 4 && hostParts[0] === 'sqs') {
        const region = hostParts[1]
        const partition = this.getAwsPartition(region)
        return {
          queueName,
          arn: `arn:${partition}:sqs:${region}:${accountId}:${queueName}`
        }
      }
    }

    return { queueName }
  }

  getAwsPartition (region) {
    if (region.startsWith('cn-')) return 'aws-cn'
    if (region.startsWith('us-gov-')) return 'aws-us-gov'
    return 'aws'
  }

  responseExtract (params, operation, response) {
    if (operation !== 'receiveMessage') return
    if (params.MaxNumberOfMessages && params.MaxNumberOfMessages !== 1) return
    if (!response || !response.Messages || !response.Messages[0]) return

    let message = response.Messages[0]

    if (message.Body) {
      try {
        const body = JSON.parse(message.Body)

        // SNS to SQS
        if (body.Type === 'Notification') {
          message = body
        }
      } catch {
        // SQS to SQS
      }
    }

    if (!message.MessageAttributes || !message.MessageAttributes._datadog) return

    const datadogAttribute = message.MessageAttributes._datadog

    const parsedAttributes = this.parseDatadogAttributes(datadogAttribute)
    if (parsedAttributes) {
      return {
        datadogContext: this.tracer.extract('text_map', parsedAttributes),
        parsedAttributes
      }
    }
  }

  parseDatadogAttributes (attributes) {
    try {
      if (attributes.StringValue) {
        const textMap = attributes.StringValue
        return JSON.parse(textMap)
      } else if (attributes.Type === 'Binary' || attributes.DataType === 'Binary') {
        const buffer = Buffer.from(attributes.Value ?? attributes.BinaryValue, 'base64')
        return JSON.parse(buffer)
      }
    } catch (e) {
      log.error('Sqs error parsing DD attributes', e)
    }
  }

  responseExtractDSMContext (operation, params, response, span, kwargs = {}) {
    let { parsedAttributes } = kwargs
    if (!this.config.dsmEnabled) return
    if (operation !== 'receiveMessage') return
    if (!response || !response.Messages || !response.Messages[0]) return

    // we only want to set the payloadSize on the span if we have one message
    span = response.Messages.length > 1 ? null : span

    response.Messages.forEach(message => {
      // we may have already parsed the message attributes when extracting trace context
      if (!parsedAttributes) {
        if (message.Body) {
          try {
            const body = JSON.parse(message.Body)

            // SNS to SQS
            if (body.Type === 'Notification') {
              message = body
            }
          } catch {
            // SQS to SQS
          }
        }
        if (!parsedAttributes && message.MessageAttributes && message.MessageAttributes._datadog) {
          parsedAttributes = this.parseDatadogAttributes(message.MessageAttributes._datadog)
        }
      }
      const payloadSize = getHeadersSize({
        Body: message.Body,
        MessageAttributes: message.MessageAttributes
      })
      const queue = params.QueueUrl.split('/').pop()
      if (parsedAttributes) {
        this.tracer.decodeDataStreamsContext(parsedAttributes)
      }
      this.tracer
        .setCheckpoint(['direction:in', `topic:${queue}`, 'type:sqs'], span, payloadSize)
    })
  }

  requestInject (span, request) {
    const { operation, params } = request

    if (!params) return

    switch (operation) {
      case 'sendMessage':
        this.injectToMessage(span, params, params.QueueUrl, true)
        break
      case 'sendMessageBatch':
        for (let i = 0; i < params.Entries.length; i++) {
          this.injectToMessage(
            span,
            params.Entries[i],
            params.QueueUrl,
            i === 0 || (this.config.batchPropagationEnabled)
          )
        }
        break
      case 'receiveMessage':
        if (!params.MessageAttributeNames) {
          params.MessageAttributeNames = ['_datadog']
        } else if (
          !params.MessageAttributeNames.includes('_datadog') &&
          !params.MessageAttributeNames.includes('.*') &&
          !params.MessageAttributeNames.includes('All')
        ) {
          params.MessageAttributeNames.push('_datadog')
        }
        break
    }
  }

  injectToMessage (span, params, queueUrl, injectTraceContext) {
    if (!params) {
      params = {}
    }
    if (!params.MessageAttributes) {
      params.MessageAttributes = {}
    } else if (Object.keys(params.MessageAttributes).length >= 10) { // SQS quota
      // TODO: add test when the test suite is fixed
      return
    }
    const ddInfo = {}
    // for now, we only want to inject to the first message, this may change for batches in the future
    if (injectTraceContext) {
      this.tracer.inject(span, 'text_map', ddInfo)
      params.MessageAttributes._datadog = {
        DataType: 'String',
        StringValue: JSON.stringify(ddInfo)
      }
    }

    if (this.config.dsmEnabled) {
      if (!params.MessageAttributes._datadog) {
        params.MessageAttributes._datadog = {
          DataType: 'String',
          StringValue: JSON.stringify(ddInfo)
        }
      }

      const dataStreamsContext = this.setDSMCheckpoint(span, params, queueUrl)
      if (dataStreamsContext) {
        DsmPathwayCodec.encode(dataStreamsContext, ddInfo)
        params.MessageAttributes._datadog.StringValue = JSON.stringify(ddInfo)
      }
    }

    if (params.MessageAttributes._datadog && Object.keys(ddInfo).length === 0) {
      // let's avoid adding any additional information to payload if we failed to inject
      delete params.MessageAttributes._datadog
    }
  }

  setDSMCheckpoint (span, params, queueUrl) {
    const payloadSize = getHeadersSize({
      Body: params.MessageBody,
      MessageAttributes: params.MessageAttributes
    })
    const queue = queueUrl.split('/').pop()
    const dataStreamsContext = this.tracer
      .setCheckpoint(['direction:out', `topic:${queue}`, 'type:sqs'], span, payloadSize)
    return dataStreamsContext
  }
}

module.exports = Sqs
