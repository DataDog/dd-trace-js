'use strict'
const log = require('../../../dd-trace/src/log')
class Kinesis {
  generateTags (params, operation, response) {
    if (!params || !params.StreamName) return {}

    return {
      'resource.name': `${operation} ${params.StreamName}`,
      'aws.kinesis.stream_name': params.StreamName
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

  requestInject (span, request, tracer) {
    const operation = request.operation
    if (operation === 'putRecord' || operation === 'putRecords') {
      if (!request.params) {
        return
      }

      const traceData = {}
      tracer.inject(span, 'text_map', traceData)
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
        const finalData = JSON.stringify(parsedData)
        const byteSize = Buffer.byteLength(finalData, 'ascii')
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
