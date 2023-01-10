const { testThatRequestHasVulnerability, testThatRequestHasNoVulnerability } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')

describe('command injection analyzer', () => {
  describe('full feature', () => {
    describe('must have', () => {
      testThatRequestHasVulnerability(() => {
        const store = storage.getStore()
        const iastContext = iastContextFunctions.getIastContext(store)
        const command = newTaintedString(iastContext, 'ls -la', 'param', 'Request')
        const childProcess = require('child_process')
        childProcess.execSync(command)
      }, 'COMMAND_INJECTION')
    })

    describe('must not have', () => {
      testThatRequestHasNoVulnerability(() => {
        const childProcess = require('child_process')
        childProcess.execSync('ls -la')
      }, 'COMMAND_INJECTION')
    })
  })
})
