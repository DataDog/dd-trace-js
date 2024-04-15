'use strict'
const log = require('../../../dd-trace/src/log')
const BaseAwsSdkPlugin = require('../base')

class Stepfunctions extends BaseAwsSdkPlugin {
  static get id () { return 'stepfunctions' }

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
    if (!params) return {}
    const tags = { 'resource.name': params.name ? `${operation} ${params.name}` : `${operation}` }
    if (operation === 'startExecution' || operation === 'startSyncExecution') {
      tags.statemachinearn = `${params.stateMachineArn}`
    }
    return tags
  }

  requestInject (span, request) {
    const operation = request.operation
    if (operation === 'startExecution' || operation === 'startSyncExecution') {
      if (!request.params || !request.params.input) {
        return
      }

      const input = request.params.input

      try {
        const inputObj = JSON.parse(input)
        if (inputObj && typeof inputObj === 'object') {
          // We've parsed the input JSON string
          inputObj._datadog = {}
          this.tracer.inject(span, 'text_map', inputObj._datadog)
          const newInput = JSON.stringify(inputObj)
          request.params.input = newInput
        }
      } catch (e) {
        log.info('Unable to treat input as JSON')
      }
    }
  }
}

module.exports = Stepfunctions
