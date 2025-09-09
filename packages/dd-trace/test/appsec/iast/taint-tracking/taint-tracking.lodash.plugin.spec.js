'use strict'

const path = require('node:path')
const fs = require('node:fs')
const { expect } = require('chai')
const { describe, it, beforeEach, afterEach } = require('mocha')

const { prepareTestServerForIast, copyFileToTmp } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString, isTainted } = require('../../../../src/appsec/iast/taint-tracking/operations')
const { clearCache } = require('../../../../src/appsec/iast/vulnerability-reporter')

const commands = [
  '  ls -la  ',
  '  ls -la',
  'ls -la  ',
  'ls -la',
  ' ls -la  人 ',
  ' ls -la  𠆢𠆢𠆢 ',
  ' ls -ls �',
  ' w ',
  'w'
]

const propagationLodashFns = [
  'toLowerLodash',
  'toUpperLodash',
  'trimLodash',
  'trimStartLodash',
  'trimEndLodash',
  'arrayJoinLodashWithoutSeparator',
  'arrayJoinLodashWithSeparator'
]

const propagationLodashFunctionsFile = path.join(__dirname, 'resources/propagationLodashFunctions.js')
const propagationLodashFunctions = require(propagationLodashFunctionsFile)

describe('TaintTracking lodash', () => {
  let instrumentedFunctionsFile

  beforeEach(() => {
    instrumentedFunctionsFile = copyFileToTmp(propagationLodashFunctionsFile)
  })

  afterEach(() => {
    fs.unlinkSync(instrumentedFunctionsFile)
    clearCache()
  })

  prepareTestServerForIast('should propagate strings with lodash', (testThatRequestHasVulnerability) => {
    propagationLodashFns.forEach((propFn) => {
      describe(`using ${propFn}()`, () => {
        commands.forEach((command) => {
          describe(`with command: '${command}'`, () => {
            testThatRequestHasVulnerability(function () {
              const _ = require('../../../../../../versions/lodash').get()
              const store = storage('legacy').getStore()
              const iastContext = iastContextFunctions.getIastContext(store)
              const commandTainted = newTaintedString(iastContext, command, 'param', 'Request')

              const propFnInstrumented = require(instrumentedFunctionsFile)[propFn]
              const propFnOriginal = propagationLodashFunctions[propFn]

              const commandResult = propFnInstrumented(_, commandTainted)
              expect(isTainted(iastContext, commandResult)).to.be.true

              const commandResultOrig = propFnOriginal(_, commandTainted)
              expect(commandResult).eq(commandResultOrig)

              try {
                const childProcess = require('child_process')
                childProcess.execSync(commandResult, { stdio: 'ignore' })
              } catch (e) {
                // do nothing
              }
            }, 'COMMAND_INJECTION')
          })
        })
      })
    })
  })

  describe('lodash method with no taint tracking', () => {
    it('should return the original result', () => {
      const _ = require('../../../../../../versions/lodash').get()
      const store = storage('legacy').getStore()
      const iastContext = iastContextFunctions.getIastContext(store)
      const taintedValue = newTaintedString(iastContext, 'tainted', 'param', 'Request')

      const propFnInstrumented = require(instrumentedFunctionsFile).startCaseLodash
      const propFnOriginal = propagationLodashFunctions.startCaseLodash

      const originalResult = propFnOriginal(_, taintedValue)
      const instrumentedResult = propFnInstrumented(_, taintedValue)
      expect(instrumentedResult).to.be.equal(originalResult)
      expect(isTainted(iastContext, instrumentedResult)).to.be.false
    })
  })
})
