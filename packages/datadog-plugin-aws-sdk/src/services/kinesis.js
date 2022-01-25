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
        const byteSize = Buffer.byteLength(request.params, 'base64')
        if (byteSize >= 1000000) {
          log.info('Payload size too large to pass context')
          return
        }
        const traceData = {}
        tracer.inject(span, 'text_map', traceData)
        if (request.params.Records && request.params.Records.length > 0) {
          const injectedData = Kinesis.tryParse(request.params.Records[0].data)
          injectedData._datadog = traceData
          // No need to re-b64, the sdk will do that for us
          request.params.Records[0] = JSON.stringify(injectedData)
        } else if (request.params.Data) {
          const injectedData = Kinesis.tryParse(request.params.Data)
          injectedData['_datadog'] = traceData
          // No need to re-b64, the sdk will do that for us
          request.params.Data = JSON.stringify(injectedData)
        }
      } catch (e) {
        log.error(e)
      }
    }
  }
}

module.exports = Kinesis
