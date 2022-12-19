'use strict'

const fs = require('fs')
const path = require('path')

const { testThatRequestHasVulnerability, copyFileToTmp } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString, isTainted } = require('../../../../src/appsec/iast/taint-tracking/operations')
const { clearCache } = require('../../../../src/appsec/iast/vulnerability-reporter')
const { expect } = require('chai')

const propagationFns = [
  'concatSuffix',
  'insertStr',
  'appendStr',
  'trimStr',
  'trimStartStr',
  'trimEndStr'
]

const commands = [
  '  ls -la  ',
  '  ls -la',
  'ls -la  ',
  'ls -la',
  ' ls -la  人 ',
  ' ls -la  𠆢𠆢𠆢 ',
  ' ls -ls �'
]

const propagationFunctionsFile = path.join(__dirname, 'resources/propagationFunctions.js')
const propagationFunctions = require(propagationFunctionsFile)

describe('TaintTracking', () => {
  let instrumentedFunctionsFile
  beforeEach(() => {
    instrumentedFunctionsFile = copyFileToTmp(propagationFunctionsFile)
  })

  afterEach(() => {
    fs.unlinkSync(instrumentedFunctionsFile)
    clearCache()
  })

  describe('should propagate strings', () => {
    propagationFns.forEach((propFn) => {
      describe(`using ${propFn}()`, () => {
        commands.forEach((command) => {
          describe(`with command: '${command}'`, () => {
            testThatRequestHasVulnerability(function () {
              const store = storage.getStore()
              const iastContext = iastContextFunctions.getIastContext(store)
              const commandTainted = newTaintedString(iastContext, command, 'param', 'Request')

              const propFnInstrumented = require(instrumentedFunctionsFile)[propFn]
              const propFnOriginal = propagationFunctions[propFn]

              const commandResult = propFnInstrumented(commandTainted)
              expect(isTainted(iastContext, commandResult)).to.be.true

              const commandResultOrig = propFnOriginal(commandTainted)
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

  describe('should not catch original Error', () => {
    propagationFns.slice(3).forEach((propFn) => {
      it(`invoking ${propFn} with null argument`, () => {
        const propFnInstrumented = require(instrumentedFunctionsFile)[propFn]
        expect(() => propFnInstrumented(null)).to.throw()
      })
    })
  })
})
