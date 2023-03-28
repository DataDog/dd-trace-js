'use strict'

const childProcess = require('child_process')
const { prepareTestServerForIast } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')

describe('command injection analyzer', () => {
  prepareTestServerForIast('command injection analyzer',
    (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
      testThatRequestHasVulnerability(() => {
        const store = storage.getStore()
        const iastContext = iastContextFunctions.getIastContext(store)
        const command = newTaintedString(iastContext, 'ls -la', 'param', 'Request')
        childProcess.execSync(command)
      }, 'COMMAND_INJECTION')

      testThatRequestHasNoVulnerability(() => {
        childProcess.execSync('ls -la')
      }, 'COMMAND_INJECTION')
    })
})
