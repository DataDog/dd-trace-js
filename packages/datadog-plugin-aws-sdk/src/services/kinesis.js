'use strict'
const { DsmPathwayCodec, getSizeOrZero } = require('../../../dd-trace/src/datastreams')
const log = require('../../../dd-trace/src/log')
const BaseAwsSdkPlugin = require('../base')
const { isEmpty } = require('../util')

function recordDataAsString (data) {
  return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8')
}

class Kinesis extends BaseAwsSdkPlugin {
  static id = 'kinesis'
  static peerServicePrecursors = ['streamname']
  static isPayloadReporter = true

  constructor (...args) {
    super(...args)

    // TODO(bengl) Find a way to create the response span tags without this WeakMap being populated
    // in the base class
    this.requestTags = new WeakMap()

    this.addBind('apm:aws:response:start:kinesis', ctx => {
      const { request, response } = ctx
      const plugin = this

      let store = this._parentMap.get(request)

      // if we have either of these operations, we want to store the streamName param
      // since it is not typically available during get/put records requests
      if (request.operation === 'getShardIterator' || request.operation === 'listShards') {
        return this.storeStreamName(request.params, request.operation, store)
      }

      if (request.operation === 'getRecords') {
        let span
        const responseExtraction = this.responseExtract(request.params, request.operation, response)
        if (responseExtraction && responseExtraction.maybeChildOf) {
          ctx.needsFinish = true
          const options = {
            childOf: responseExtraction.maybeChildOf,
            meta: {
              ...this.requestTags.get(request),
              'span.kind': 'server',
            },
            integrationName: 'aws-sdk',
          }
          span = plugin.startSpan('aws.response', options, ctx)
          store = ctx.currentStore
        }

        // get the stream name that should have been stored previously
        const { streamName } = store

        // extract DSM context after as we might not have a parent-child but may have a DSM context
        this.responseExtractDSMContext(
          request.operation, request.params, response, span || null, { streamName }
        )
      }

      return store
    })

    this.addSub('apm:aws:response:finish:kinesis', ctx => {
      if (!ctx.needsFinish) return
      this.finish(ctx)
    })
  }

  generateTags (params, operation, response) {
    if (!params || !params.StreamName) return {}

    return {
      'resource.name': `${operation} ${params.StreamName}`,
      'aws.kinesis.stream_name': params.StreamName,
      'messaging.system': 'aws_kinesis',
      streamname: params.StreamName,
    }
  }

  storeStreamName (params, operation, store) {
    if (!operation) return store
    if (operation !== 'getShardIterator' && operation !== 'listShards') return store
    if (!params || !params.StreamName) return store

    const streamName = params.StreamName
    return { ...store, streamName }
  }

  responseExtract (params, operation, response) {
    if (operation !== 'getRecords') return
    if (params.Limit && params.Limit !== 1) return
    if (!response || !response.Records || !response.Records[0]) return

    const record = response.Records[0]

    try {
      const decodedData = JSON.parse(recordDataAsString(record.Data))

      return {
        maybeChildOf: this.tracer.extract('text_map', decodedData._datadog),
        parsedAttributes: decodedData._datadog,
      }
    } catch (error) {
      log.error('Kinesis error extracting response', error)
    }
  }

  responseExtractDSMContext (operation, params, response, span, kwargs = {}) {
    const { streamName } = kwargs
    if (!this.config.dsmEnabled) return
    if (operation !== 'getRecords') return
    if (!response || !response.Records || !response.Records[0]) return

    // Only attribute payloadSize to the span when there is a single record.
    span = response.Records.length > 1 ? null : span

    const tags = streamName
      ? ['direction:in', `topic:${streamName}`, 'type:kinesis']
      : ['direction:in', 'type:kinesis']

    for (const record of response.Records) {
      let parsedAttributes
      try {
        parsedAttributes = JSON.parse(recordDataAsString(record.Data))
      } catch {
        // Non-JSON record. Skip DSM context for this entry; the
        // checkpoint payload size below is still reported.
      }

      const payloadSize = getSizeOrZero(record.Data)
      if (parsedAttributes?._datadog) {
        this.tracer.decodeDataStreamsContext(parsedAttributes._datadog)
      }
      this.tracer.setCheckpoint(tags, span, payloadSize)
    }
  }

  // AWS-SDK base64-encodes kinesis payloads but also accepts an already
  // base64-encoded payload; both shapes land here.
  _tryParse (body) {
    try {
      return JSON.parse(body)
    } catch {
      log.info('Not JSON string. Trying Base64 encoded JSON string')
    }
    try {
      return JSON.parse(Buffer.from(body, 'base64').toString('ascii'))
    } catch {
      return null
    }
  }

  requestInject (span, request) {
    const { operation, params } = request
    if (!params) return

    let stream
    switch (operation) {
      case 'putRecord':
        stream = params.StreamArn ?? params.StreamName ?? ''
        this.injectToMessage(span, params, stream, true)
        break
      case 'putRecords':
        stream = params.StreamArn ?? params.StreamName ?? ''
        for (let i = 0; i < params.Records.length; i++) {
          this.injectToMessage(
            span,
            params.Records[i],
            stream,
            i === 0 || this.config.batchPropagationEnabled
          )
        }
    }
  }

  injectToMessage (span, params, stream, injectTraceContext) {
    if (!params) {
      return
    }

    let parsedData
    if (injectTraceContext || this.config.dsmEnabled) {
      parsedData = this._tryParse(params.Data)
      if (!parsedData) {
        log.error('Unable to parse payload, unable to pass trace context or set DSM checkpoint (if enabled)')
        return
      }
    }

    const ddInfo = {}
    // For now we only inject to the first message; batches may change later.
    if (injectTraceContext) {
      this.tracer.inject(span, 'text_map', ddInfo)
    }

    if (this.config.dsmEnabled) {
      parsedData._datadog = ddInfo
      const dataStreamsContext = this.setDSMCheckpoint(span, params, stream)
      if (dataStreamsContext) {
        DsmPathwayCodec.encode(dataStreamsContext, ddInfo)
      }
    }

    if (isEmpty(ddInfo)) return

    parsedData._datadog = ddInfo
    const serialized = JSON.stringify(parsedData)
    const byteSize = Buffer.byteLength(serialized, 'utf8')
    // Kinesis max payload size is 1 MiB; bail if our context push tipped us over.
    if (byteSize >= 1_048_576) {
      log.info('Payload size too large to pass context')
      return
    }
    params.Data = Buffer.from(serialized, 'utf8')
  }

  setDSMCheckpoint (span, params, stream) {
    const payloadSize = getSizeOrZero(params.Data)
    return this.tracer
      .setCheckpoint(['direction:out', `topic:${stream}`, 'type:kinesis'], span, payloadSize)
  }
}

module.exports = Kinesis
