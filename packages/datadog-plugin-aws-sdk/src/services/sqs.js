'use strict'

const log = require('../../../dd-trace/src/log')
const BaseAwsSdkPlugin = require('../base')
const { DsmPathwayCodec, getHeadersSize } = require('../../../dd-trace/src/datastreams')
const { extractQueueMetadata } = require('../util')

/**
 * @typedef {{
 *   'detail-type'?: string,
 *   detail?: { _datadog?: Record<string, string> },
 *   Type?: string,
 *   Message?: string
 * }} ParsedSqsBody
 */

/**
 * Resolve the EventBridge `_datadog` text map from a parsed SQS body — for both
 * EventBridge -> SQS (`body.detail._datadog`) and EventBridge -> SNS -> SQS (the
 * envelope is the SNS `Notification`'s stringified `Message`). Keyed off
 * `detail-type`, the marker AWS sets on every PutEvents delivery. Relies on the
 * default SQS-target shape; a target InputTransformer can drop `detail`.
 *
 * @param {ParsedSqsBody} [parsedBody]
 * @returns {Record<string, string> | undefined}
 */
function getEventBridgeContext (parsedBody) {
  let envelope
  if (parsedBody?.['detail-type'] !== undefined) {
    envelope = parsedBody // EventBridge -> SQS
  } else if (parsedBody?.Type === 'Notification' && typeof parsedBody.Message === 'string') {
    // EventBridge -> SNS -> SQS
    try {
      const innerEnvelope = JSON.parse(parsedBody.Message)
      if (innerEnvelope?.['detail-type'] !== undefined) {
        envelope = innerEnvelope
      }
    } catch {
      // SNS `Message` not JSON
    }
  }
  return envelope?.detail?._datadog
}

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

    this.addBind('apm:aws:response:start:sqs', ctx => this.#startResponseSpan(ctx))

    // No-callback receives (promises, event emitters) never publish response:start, so link and
    // finish the consumer span here instead. Callback paths reach the same logic via the bind above.
    this.addSub('apm:aws:request:complete:sqs', ctx => {
      if (ctx.cbExists) return
      // v2 nests the SDK payload under response.data; v3 spreads the output onto response.
      const responseCtx = { request: ctx.request, response: ctx.response?.data ?? ctx.response }
      this.#startResponseSpan(responseCtx)
      if (responseCtx.needsFinish) this.finish(responseCtx)
    })

    this.addSub('apm:aws:response:finish:sqs', ctx => {
      if (!ctx.needsFinish) return
      this.finish(ctx)
    })
  }

  /**
   * Start the consumer (`aws.response`) span for a receive. The first message carrying trace
   * context becomes the parent; every additional one fans in as a span link.
   *
   * @param {{ request: object, response: object, needsFinish?: boolean, currentStore?: object }} ctx
   * @returns {object | undefined} The store to activate for the consumer span, else the parent store.
   */
  #startResponseSpan (ctx) {
    const { request, response } = ctx
    const carriers = this.responseExtract(request.params, request.operation, response)

    let store = this._parentMap.get(request)
    let span

    if (carriers !== undefined) {
      // request:start records requestTags only after the isEnabled gate, so an absent entry
      // means this consumer is disabled — gate on it instead of paying isEnabled again here.
      const requestTags = this.requestTags.get(request)
      if (requestTags !== undefined) {
        // A receive can return messages from many producers; fanning the extra ones in as span
        // links is the shape dd-trace-java and dd-trace-py use for batch SQS receives.
        for (const carrier of carriers) {
          if (carrier === undefined) continue
          const datadogContext = this.tracer.extract('text_map', carrier)
          // A DSM-only carrier (a non-first sendMessageBatch entry when batchPropagationEnabled
          // is off) extracts to null; span.addLink dereferences the context and would throw on it.
          if (datadogContext === null) continue
          if (span === undefined) {
            ctx.needsFinish = true
            span = this.startSpan('aws.response', {
              childOf: datadogContext,
              meta: {
                ...requestTags,
                'span.kind': 'server',
              },
              integrationName: 'aws-sdk',
            }, ctx)
            store = ctx.currentStore
          } else {
            span.addLink({ context: datadogContext })
          }
        }
      }
    }

    // Extract DSM context after, as we might not have a parent-child but may have a DSM context.
    this.responseExtractDSMContext(request.operation, request.params, response, span ?? null, carriers)

    return store
  }

  operationFromRequest (request) {
    switch (request.operation) {
      case 'receiveMessage':
        return this.operationName({
          type: 'messaging',
          kind: 'consumer',
        })
      case 'sendMessage':
      case 'sendMessageBatch':
        return this.operationName({
          type: 'messaging',
          kind: 'producer',
        })
    }

    return this.operationName({
      id: 'aws',
      type: 'web',
      kind: 'client',
      awsService: 'sqs',
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
    if (!params || (!params.QueueName && !params.QueueUrl)) return

    const queueMetadata = extractQueueMetadata(params.QueueUrl)
    const queueName = queueMetadata?.queueName || params.QueueName

    const tags = {
      'resource.name': `${operation} ${params.QueueName || params.QueueUrl}`,
      'aws.sqs.queue_name': params.QueueName || params.QueueUrl,
      'messaging.system': 'aws_sqs',
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

  /**
   * Parse the trace-context carrier of every received message, in message order.
   * Entries are `undefined` for messages that carry no `_datadog` context.
   *
   * @param {{ MaxNumberOfMessages?: number }} params
   * @param {string} operation
   * @param {{ Messages?: object[] }} response
   * @returns {Array<Record<string, string> | undefined> | undefined}
   */
  responseExtract (params, operation, response) {
    if (operation !== 'receiveMessage') return
    if (!response?.Messages?.length) return

    return response.Messages.map(message => this.parseMessageCarrier(message))
  }

  /**
   * Resolve the trace-context carrier for a single received message. The
   * `MessageAttributes._datadog` text map (direct SQS or SNS to SQS) wins;
   * otherwise the EventBridge envelope, optionally wrapped in an SNS
   * `Notification` (see getEventBridgeContext). Checking MessageAttributes first
   * avoids parsing a large SNS `Message` just to rule out an EventBridge envelope.
   *
   * @param {object} message A single `response.Messages` entry.
   * @returns {Record<string, string> | undefined}
   */
  parseMessageCarrier (message) {
    let parsedBody
    if (message.Body) {
      try {
        parsedBody = JSON.parse(message.Body)
      } catch {
        // Opaque, non-JSON body (SQS to SQS).
      }
      // SNS to SQS
      if (parsedBody?.Type === 'Notification') {
        message = parsedBody
      }
    }

    const datadogAttribute = message.MessageAttributes?._datadog
    const carrier = datadogAttribute ? this.parseDatadogAttributes(datadogAttribute) : undefined
    return carrier ?? getEventBridgeContext(parsedBody)
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
    } catch (error) {
      log.error('Sqs error parsing DD attributes', error)
    }
  }

  /**
   * @param {string} operation
   * @param {{ QueueUrl: string }} params
   * @param {{ Messages?: object[] }} response
   * @param {import('../../../dd-trace/src/opentracing/span') | null} span
   * @param {Array<Record<string, string> | undefined>} [carriers] Per-message carriers already
   *   parsed by `responseExtract`; reused so each message body is parsed once. When omitted, the
   *   carriers are parsed here.
   */
  responseExtractDSMContext (operation, params, response, span, carriers) {
    if (!this.config.dsmEnabled) return
    if (operation !== 'receiveMessage') return
    if (!response?.Messages?.length) return

    const messages = response.Messages
    // Only attribute payloadSize to the span when there is a single message.
    span = messages.length > 1 ? null : span

    // QueueUrl is the same for the whole receive batch.
    const queue = params.QueueUrl.slice(params.QueueUrl.lastIndexOf('/') + 1)

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]
      const carrier = carriers === undefined ? this.parseMessageCarrier(message) : carriers[i]
      if (carrier) {
        // Inert for EventBridge until its producer emits a pathway (separate
        // change) — no `dd-pathway-ctx-base64` to decode yet; SQS/SNS decode now.
        this.tracer.decodeDataStreamsContext(carrier)
      }
      const payloadSize = getHeadersSize({
        Body: message.Body,
        MessageAttributes: message.MessageAttributes,
      })
      this.tracer
        .setCheckpoint(['direction:in', `topic:${queue}`, 'type:sqs'], span, payloadSize)
    }
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
    let injected = false
    // For now we only inject to the first message; batches may change later.
    if (injectTraceContext) {
      this.tracer.inject(span, 'text_map', ddInfo)
      injected = true
    }

    if (this.config.dsmEnabled) {
      // Attach `_datadog` before measuring so the DSM payload size metric
      // matches the on-wire payload, then update with the encoded context.
      params.MessageAttributes._datadog = {
        DataType: 'String',
        StringValue: JSON.stringify(ddInfo),
      }
      const dataStreamsContext = this.setDSMCheckpoint(span, params, queueUrl)
      if (dataStreamsContext) {
        DsmPathwayCodec.encode(dataStreamsContext, ddInfo)
        params.MessageAttributes._datadog.StringValue = JSON.stringify(ddInfo)
      } else if (!injected) {
        delete params.MessageAttributes._datadog
      }
      return
    }

    if (!injected) return

    params.MessageAttributes._datadog = {
      DataType: 'String',
      StringValue: JSON.stringify(ddInfo),
    }
  }

  setDSMCheckpoint (span, params, queueUrl) {
    const payloadSize = getHeadersSize({
      Body: params.MessageBody,
      MessageAttributes: params.MessageAttributes,
    })
    const queue = queueUrl.slice(queueUrl.lastIndexOf('/') + 1)
    return this.tracer
      .setCheckpoint(['direction:out', `topic:${queue}`, 'type:sqs'], span, payloadSize)
  }
}

module.exports = Sqs
