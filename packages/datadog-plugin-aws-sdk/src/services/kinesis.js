'use strict'
const {
  CONTEXT_PROPAGATION_KEY,
  getSizeOrZero
} = require('../../../dd-trace/src/datastreams/processor')
const { encodePathwayContext } = require('../../../dd-trace/src/datastreams/pathway')
const log = require('../../../dd-trace/src/log')
const BaseAwsSdkPlugin = require('../base')

class Kinesis extends BaseAwsSdkPlugin {
  static get id () { return 'kinesis' }
  static get peerServicePrecursors () { return ['streamname'] }

  generateTags (params, operation, response) {
    if (!params || !params.StreamName) return {}

    return {
      'resource.name': `${operation} ${params.StreamName}`,
      'aws.kinesis.stream_name': params.StreamName,
      'streamname': params.StreamName
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
          const payloadSize = getSizeOrZero(JSON.stringify(parsedData))
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
