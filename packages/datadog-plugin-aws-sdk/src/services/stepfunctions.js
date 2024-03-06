'use strict'
const log = require('../../../dd-trace/src/log')
const BaseAwsSdkPlugin = require('../base')

class Stepfunctions extends BaseAwsSdkPlugin {
  static get id () { return 'stepfunctions' }

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
    return {
      'resource.name': params.name ? `${operation} ${params.name}` : `${operation}`,
      'statemachinearn': `${params.stateMachineArn}`
    }
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
