'use strict'
const log = require('../../../dd-trace/src/log')
class Kinesis {
  generateTags (params, operation, response) {
    const tags = {}

    if (!params || !params.StreamName) return tags

    return Object.assign(tags, {
      'resource.name': `${operation} ${params.StreamName}`,
      'aws.kinesis.stream_name': params.StreamName
    })
  }

  // AWS-SDK will b64 kinesis payloads
  // or will accept an already b64 encoded payload
  // This method handles both
  static tryParse (body, final = false) {
    try {
      return JSON.parse(body)
    } catch (e) {
      if (final) {
        return null
      }
      return Kinesis.tryParse(Buffer.from(body, 'base64').toString('ascii'), true)
    }
  }

  requestInject (span, request, tracer) {
    const operation = request.operation
    if (operation === 'putRecord' || operation === 'putRecords') {
      try {
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
        const byteSize = Buffer.byteLength(injectPath.Data, 'base64')
        // DD trace context must be less than 512B
        if (byteSize + 512 >= 1000000) {
          log.info('Payload size too large to pass context')
          return
        }
        const parsedData = Kinesis.tryParse(injectPath.Data)
        if (parsedData) {
          parsedData._datadog = traceData
          injectPath.Data = JSON.stringify(parsedData)
        } else {
          log.error('Unable to parse payload, unable to pass trace context')
        }
      } catch (e) {
        log.error(e)
      }
    }
  }
}

module.exports = Kinesis
