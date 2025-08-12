'use strict'

const fs = require('fs')
const path = require('path')

const { prepareTestServerForIast, copyFileToTmp } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString, isTainted, getRanges } = require('../../../../src/appsec/iast/taint-tracking/operations')
const { clearCache } = require('../../../../src/appsec/iast/vulnerability-reporter')
const { expect } = require('chai')

const propagationFns = [
  'appendStr',
  'arrayInVariableJoin',
  'arrayJoin',
  'arrayProtoJoin',
  'concatProtoStr',
  'concatStr',
  'concatSuffix',
  'concatTaintedStr',
  'insertStr',
  'replaceRegexStr',
  'replaceStr',
  'sliceStr',
  'substrStr',
  'substringStr',
  'templateLiteralEndingWithNumberParams',
  'templateLiteralWithTaintedAtTheEnd',
  'toLowerCaseStr',
  'toUpperCaseStr',
  'trimEndStr',
  'trimProtoStr',
  'trimStartStr',
  'trimStr'
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

  prepareTestServerForIast('should propagate strings', (testThatRequestHasVulnerability) => {
    propagationFns.forEach((propFn) => {
      describe(`using ${propFn}()`, () => {
        commands.forEach((command) => {
          describe(`with command: '${command}'`, () => {
            testThatRequestHasVulnerability(function () {
              const store = storage('legacy').getStore()
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

    describe('using JSON.parse', () => {
      testThatRequestHasVulnerability(function () {
        const store = storage('legacy').getStore()
        const iastContext = iastContextFunctions.getIastContext(store)

        const json = '{"command":"ls -la"}'
        const jsonTainted = newTaintedString(iastContext, json, 'param', 'request.type')

        const propFnInstrumented = require(instrumentedFunctionsFile).jsonParseStr
        const propFnOriginal = propagationFunctions.jsonParseStr

        const result = propFnInstrumented(jsonTainted)
        expect(isTainted(iastContext, result.command)).to.be.true
        expect(getRanges(iastContext, result.command)).to.be.deep
          .eq([{
            start: 0,
            end: 6,
            iinfo: {
              parameterName: 'command',
              parameterValue: 'ls -la',
              type: 'request.type'
            },
            secureMarks: 0
          }])

        const resultOrig = propFnOriginal(jsonTainted)
        expect(result).deep.eq(resultOrig)

        try {
          const childProcess = require('child_process')
          childProcess.execSync(result.command, { stdio: 'ignore' })
        } catch (e) {
          // do nothing
        }
      }, 'COMMAND_INJECTION')
    })
  })

  describe('should not catch original Error', () => {
    const filtered = [
      'appendStr',
      'arrayInVariableJoin',
      'arrayJoin',
      'arrayProtoJoin',
      'concatSuffix',
      'concatTaintedStr',
      'insertStr',
      'templateLiteralEndingWithNumberParams',
      'templateLiteralWithTaintedAtTheEnd'
    ]
    propagationFns.forEach((propFn) => {
      if (filtered.includes(propFn)) return
      it(`invoking ${propFn} with null argument`, () => {
        const propFnInstrumented = require(instrumentedFunctionsFile)[propFn]
        expect(() => propFnInstrumented(null)).to.throw()
      })
    })
  })
})
