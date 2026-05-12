'use strict'
const log = require('../../../dd-trace/src/log')
const BaseAwsSdkPlugin = require('../base')

class Stepfunctions extends BaseAwsSdkPlugin {
  static id = 'stepfunctions'

  // This is the shape of StartExecutionInput, as defined in
  // https://github.com/aws/aws-sdk-js/blob/master/apis/states-2016-11-23.normal.json
  // "StartExecutionInput": {
  //   "type": "structure",
  //   "required": [
  //     "stateMachineArn"
  //   ],
  //   "members": {
  //     "stateMachineArn": {
  //       "shape": "Arn",
  //     },
  //     "name": {
  //       "shape": "Name",
  //     },
  //     "input": {
  //       "shape": "SensitiveData",
  //     },
  //     "traceHeader": {
  //       "shape": "TraceHeader",
  //     }
  //   }

  generateTags (params, operation, response) {
    if (!params) return
    const tags = { 'resource.name': params.name ? `${operation} ${params.name}` : `${operation}` }
    if (operation === 'startExecution' || operation === 'startSyncExecution') {
      tags.statemachinearn = `${params.stateMachineArn}`
    }
    return tags
  }

  requestInject (span, request) {
    const operation = request.operation
    if ((operation !== 'startExecution' && operation !== 'startSyncExecution') || !request.params?.input) return

    const input = request.params.input
    if (typeof input !== 'string' || input.length < 2) return

    // Skip non-object payloads up front to avoid a `JSON.parse` round-trip.
    // `trimEnd` is the identity on payloads with no trailing whitespace;
    // for the rare whitespace-suffixed object the slow path inside
    // `injectFieldIntoJsonObject` handles the parse + restringify.
    const trimmed = input.trimEnd()
    if (trimmed.length < 2 || trimmed.charCodeAt(trimmed.length - 1) !== 0x7D) return

    const injected = {}
    this.tracer.inject(span, 'text_map', injected)

    // `injectFieldIntoJsonObject` is the only throwing call path
    // (`JSON.parse` slow path for non-trivial JSON shapes).
    try {
      request.params.input = BaseAwsSdkPlugin.injectFieldIntoJsonObject(input, '_datadog', injected)
    } catch {
      log.info('Unable to treat input as JSON')
    }
  }
}

module.exports = Stepfunctions
