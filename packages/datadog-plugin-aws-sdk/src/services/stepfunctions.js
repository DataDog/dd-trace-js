'use strict'
const log = require('../../../dd-trace/src/log')
const BaseAwsSdkPlugin = require('../base')

class StepFunctions extends BaseAwsSdkPlugin {
  static get id () { return 'stepfunctions' }

  generateTags (params, operation, response) {
    if (!params || !params.source) return {}
    return {
      'resource.name': `${operation}`,
      'statemachinearn': `${params.stateMachineArn}`
    }
  }

  requestInject (span, request) {
    const operation = request.operation;
    if (operation === 'start_execution' || operation === 'start_sync_execution') {
      if (!request.params) {
        request.params = {}
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

module.exports = StepFunctions
