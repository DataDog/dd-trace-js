'use strict'
const {
  CONTEXT_PROPAGATION_KEY,
  getSizeOrZero
} = require('../../../dd-trace/src/datastreams/processor')
const { encodePathwayContext } = require('../../../dd-trace/src/datastreams/pathway')
const log = require('../../../dd-trace/src/log')
const BaseAwsSdkPlugin = require('../base')
const { storage } = require('../../../datadog-core')

class Kinesis extends BaseAwsSdkPlugin {
  static get id () { return 'kinesis' }
  static get peerServicePrecursors () { return ['streamname'] }

  constructor (...args) {
    super(...args)

    // TODO(bengl) Find a way to create the response span tags without this WeakMap being populated
    // in the base class
    this.requestTags = new WeakMap()

    this.addSub('apm:aws:response:start:kinesis', obj => {
      const { request, response } = obj
      const store = storage.getStore()
      const plugin = this
      const streamName = this.getStreamName(request.params, request.operation)
      if (streamName) {
        this.requestTags.streamName = streamName
      }
      const responseExtraction = this.responseExtract(request.params, request.operation, response)
      if (responseExtraction && responseExtraction.maybeChildOf) {
        obj.needsFinish = true
        const options = {
          childOf: responseExtraction.maybeChildOf,
          tags: Object.assign(
            {},
            this.requestTags.get(request) || {},
            { 'span.kind': 'server' }
          )
        }
        const span = plugin.tracer.startSpan('aws.response', options)
        this.responseExtractDSMContext(response, responseExtraction.traceContext, this.requestTags.streamName, span)
        this.enter(span, store)
      }
    })

    this.addSub('apm:aws:response:finish:kinesis', err => {
      const { span } = storage.getStore()
      this.finish(span, null, err)
    })
  }

  generateTags (params, operation, response) {
    if (!params || !params.StreamName) return {}

    return {
      'resource.name': `${operation} ${params.StreamName}`,
      'aws.kinesis.stream_name': params.StreamName,
      'streamname': params.StreamName
    }
  }

  getStreamName (params, operation) {
    if (!operation || operation !== 'getShardIterator') return null
    if (!params || !params.StreamName) return null

    return params.StreamName
  }

  responseExtract (params, operation, response) {
    if (operation !== 'getRecords') return
    if (params.Limit && params.Limit !== 1) return
    if (!response || !response.Records || !response.Records[0] || response.Records.length > 1) return

    const record = response.Records[0]

    try {
      const decodedData = JSON.parse(Buffer.from(record.Data).toString())

      return {
        maybeChildOf: this.tracer.extract('text_map', decodedData._datadog),
        traceContext: decodedData._datadog
      }
    } catch (e) {
      log.error(e)
    }
  }

  responseExtractDSMContext (response, context, streamName, span) {
    if (this.config.dsmEnabled && context && context[CONTEXT_PROPAGATION_KEY] && streamName) {
      let payloadSize = 0
      if (response && response.Records) {
        for (const record of response.Records) {
          payloadSize += getSizeOrZero(record.Data)
        }
      }
      this.tracer.decodeDataStreamsContext(Buffer.from(context[CONTEXT_PROPAGATION_KEY]))
      this.tracer
        .setCheckpoint(['direction:in', `topic:${streamName}`, 'type:kinesis'], span, payloadSize)
    }
  }

  // AWS-SDK will b64 kinesis payloads
  // or will accept an already b64 encoded payload
  // This method handles both
  _tryParse (body) {
    try {
      return JSON.parse(body)
    } catch (e) {
      log.info('Not JSON string. Trying Base64 encoded JSON string')
    }
    try {
      return JSON.parse(Buffer.from(body, 'base64').toString('ascii'), true)
    } catch (e) {
      return null
    }
  }

  requestInject (span, request) {
    const operation = request.operation
    if (operation === 'putRecord' || operation === 'putRecords') {
      if (!request.params) {
        return
      }
      const traceData = {}

      // inject data with DD context
      this.tracer.inject(span, 'text_map', traceData)
      let injectPath
      if (request.params.Records && request.params.Records.length > 0) {
        injectPath = request.params.Records[0]
      } else if (request.params.Data) {
        injectPath = request.params
      } else {
        log.error('No valid payload passed, unable to pass trace context')
        return
      }

      const parsedData = this._tryParse(injectPath.Data)
      if (parsedData) {
        parsedData._datadog = traceData

        // set DSM hash if enabled
        if (this.config.dsmEnabled) {
          // get payload size of request data
          const payloadSize = Buffer.from(JSON.stringify(parsedData)).byteLength
          let stream
          // users can optionally use either stream name or stream arn
          if (request.params && request.params.StreamArn) {
            stream = request.params.StreamArn
          } else if (request.params && request.params.StreamName) {
            stream = request.params.StreamName
          }
          const dataStreamsContext = this.tracer
            .setCheckpoint(['direction:out', `topic:${stream}`, 'type:kinesis'], span, payloadSize)
          if (dataStreamsContext) {
            const pathwayCtx = encodePathwayContext(dataStreamsContext)
            parsedData._datadog[CONTEXT_PROPAGATION_KEY] = pathwayCtx.toJSON()
          }
        }

        const finalData = Buffer.from(JSON.stringify(parsedData))
        const byteSize = finalData.length
        // Kinesis max payload size is 1MB
        // So we must ensure adding DD context won't go over that (512b is an estimate)
        if (byteSize >= 1048576) {
          log.info('Payload size too large to pass context')
          return
        }
        injectPath.Data = finalData
      } else {
        log.error('Unable to parse payload, unable to pass trace context')
      }
    }
  }
}

module.exports = Kinesis
