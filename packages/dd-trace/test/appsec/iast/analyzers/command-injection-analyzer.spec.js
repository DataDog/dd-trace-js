'use strict'

const { prepareTestServerForIast } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString, addSecureMark } = require('../../../../src/appsec/iast/taint-tracking/operations')
const { COMMAND_INJECTION_MARK, SQL_INJECTION_MARK } =
  require('../../../../src/appsec/iast/taint-tracking/secure-marks')

describe('command injection analyzer', () => {
  prepareTestServerForIast('command injection analyzer',
    (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
      testThatRequestHasVulnerability(() => {
        const store = storage.getStore()
        const iastContext = iastContextFunctions.getIastContext(store)
        const command = newTaintedString(iastContext, 'ls -la', 'param', 'Request')
        const childProcess = require('child_process')
        childProcess.execSync(command)
      }, 'COMMAND_INJECTION')

      testThatRequestHasVulnerability(() => {
        const store = storage.getStore()
        const iastContext = iastContextFunctions.getIastContext(store)
        let command = newTaintedString(iastContext, 'ls -la', 'param', 'Request')
        command = addSecureMark(iastContext, command, SQL_INJECTION_MARK)
        const childProcess = require('child_process')
        childProcess.execSync(command)
      }, 'COMMAND_INJECTION', undefined, undefined, undefined,
      'should have COMMAND_INJECTION vuln due even with SQL_INJECTION_MARK')

      testThatRequestHasNoVulnerability(() => {
        const childProcess = require('child_process')
        childProcess.execSync('ls -la')
      }, 'COMMAND_INJECTION')

      testThatRequestHasNoVulnerability(() => {
        const store = storage.getStore()
        const iastContext = iastContextFunctions.getIastContext(store)
        let command = newTaintedString(iastContext, 'ls -la', 'param', 'Request')
        command = addSecureMark(iastContext, command, COMMAND_INJECTION_MARK)
        const childProcess = require('child_process')
        childProcess.execSync(command)
      }, 'COMMAND_INJECTION', undefined, 'should not have COMMAND_INJECTION vuln due to COMMAND_INJECTION_MARK')
    })
})
