'use strict'

const { prepareTestServerForIast, invokeCommandInjectionSink } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')

describe('command injection analyzer', () => {
  prepareTestServerForIast('command injection analyzer',
    (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
      testThatRequestHasVulnerability(() => {
        const store = storage('legacy').getStore()
        const iastContext = iastContextFunctions.getIastContext(store)
        const command = newTaintedString(iastContext, 'ls -la', 'param', 'Request')
        invokeCommandInjectionSink(command)
      }, 'COMMAND_INJECTION')

      testThatRequestHasNoVulnerability(() => {
        invokeCommandInjectionSink('ls -la')
      }, 'COMMAND_INJECTION')
    })
})
