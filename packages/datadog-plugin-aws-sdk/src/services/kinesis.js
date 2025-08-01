'use strict'
const { DsmPathwayCodec, getSizeOrZero } = require('../../../dd-trace/src/datastreams')
const log = require('../../../dd-trace/src/log')
const BaseAwsSdkPlugin = require('../base')

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
              'span.kind': 'server'
            },
            integrationName: 'aws-sdk'
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
      streamname: params.StreamName
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
      const decodedData = JSON.parse(Buffer.from(record.Data).toString())

      return {
        maybeChildOf: this.tracer.extract('text_map', decodedData._datadog),
        parsedAttributes: decodedData._datadog
      }
    } catch (e) {
      log.error('Kinesis error extracting response', e)
    }
  }

  responseExtractDSMContext (operation, params, response, span, kwargs = {}) {
    const { streamName } = kwargs
    if (!this.config.dsmEnabled) return
    if (operation !== 'getRecords') return
    if (!response || !response.Records || !response.Records[0]) return

    // we only want to set the payloadSize on the span if we have one message, not repeatedly
    span = response.Records.length > 1 ? null : span

    response.Records.forEach(record => {
      const parsedAttributes = JSON.parse(Buffer.from(record.Data).toString())

      const payloadSize = getSizeOrZero(record.Data)
      if (parsedAttributes?._datadog) {
        this.tracer.decodeDataStreamsContext(parsedAttributes._datadog)
      }
      const tags = streamName
        ? ['direction:in', `topic:${streamName}`, 'type:kinesis']
        : ['direction:in', 'type:kinesis']
      this.tracer
        .setCheckpoint(tags, span, payloadSize)
    })
  }

  // AWS-SDK will b64 kinesis payloads
  // or will accept an already b64 encoded payload
  // This method handles both
  _tryParse (body) {
    try {
      return JSON.parse(body)
    } catch {
      log.info('Not JSON string. Trying Base64 encoded JSON string')
    }
    try {
      return JSON.parse(Buffer.from(body, 'base64').toString('ascii'), true)
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
    // for now, we only want to inject to the first message, this may change for batches in the future
    if (injectTraceContext) { this.tracer.inject(span, 'text_map', ddInfo) }

    // set DSM hash if enabled
    if (this.config.dsmEnabled) {
      parsedData._datadog = ddInfo
      const dataStreamsContext = this.setDSMCheckpoint(span, parsedData, stream)
      DsmPathwayCodec.encode(dataStreamsContext, ddInfo)
    }

    if (Object.keys(ddInfo).length !== 0) {
      parsedData._datadog = ddInfo
      const finalData = Buffer.from(JSON.stringify(parsedData))
      const byteSize = finalData.length
      // Kinesis max payload size is 1MB
      // So we must ensure adding DD context won't go over that (512b is an estimate)
      if (byteSize >= 1_048_576) {
        log.info('Payload size too large to pass context')
        return
      }
      params.Data = finalData
    }
  }

  setDSMCheckpoint (span, parsedData, stream) {
    // get payload size of request data
    const payloadSize = Buffer.byteLength(JSON.stringify(parsedData))
    const dataStreamsContext = this.tracer
      .setCheckpoint(['direction:out', `topic:${stream}`, 'type:kinesis'], span, payloadSize)
    return dataStreamsContext
  }
}

module.exports = Kinesis
