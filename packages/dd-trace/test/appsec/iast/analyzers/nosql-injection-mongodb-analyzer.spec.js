'use strict'

const assert = require('node:assert/strict')

const { afterEach, before, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')

const { channel } = require('../../../../../datadog-instrumentations/src/helpers/instrument')
const {
  createTransaction,
  newTaintedString,
  removeTransaction,
  getRanges
} = require('../../../../src/appsec/iast/taint-tracking/operations')
const { NOSQL_MONGODB_INJECTION_MARK } = require('../../../../src/appsec/iast/taint-tracking/secure-marks')

const sanitizeMiddlewareFinished = channel('datadog:express-mongo-sanitize:filter:finish')
const sanitizeMethodFinished = channel('datadog:express-mongo-sanitize:sanitize:finish')

describe('nosql injection detection in mongodb', () => {
  describe('SECURE_MARKS', () => {
    let iastContext
    const tid = 'transaction_id'
    let nosqlInjectionMongodbAnalyzer

    before(() => {
      nosqlInjectionMongodbAnalyzer =
        proxyquire('../../../../src/appsec/iast/analyzers/nosql-injection-mongodb-analyzer',
          {
            '../iast-context': {
              getIastContext () {
                return iastContext
              }
            }
          })
    })

    beforeEach(() => {
      iastContext = {}
      createTransaction(tid, iastContext)
      nosqlInjectionMongodbAnalyzer.configure({ enabled: true })
    })

    afterEach(() => {
      removeTransaction(iastContext)
      nosqlInjectionMongodbAnalyzer.configure({ enabled: false })
      iastContext = undefined
    })

    describe('express-mongo-sanitize', () => {
      describe('middleware', () => {
        it('Secure mark is added', () => {
          const taintedString = newTaintedString(iastContext, 'value', 'param', 'Request')
          const req = { query: { param: taintedString } }

          sanitizeMiddlewareFinished.publish({
            sanitizedProperties: ['body', 'query'],
            req
          })

          const sanitizedRanges = getRanges(iastContext, req.query.param)
          const notSanitizedRanges = getRanges(iastContext, taintedString)

          assert.strictEqual(sanitizedRanges.length, 1)
          assert.strictEqual(notSanitizedRanges.length, 1)

          assert.strictEqual(sanitizedRanges[0].secureMarks, NOSQL_MONGODB_INJECTION_MARK)
          assert.strictEqual(notSanitizedRanges[0].secureMarks, 0)
        })

        it('Secure mark is added in nested objects', () => {
          const taintedString = newTaintedString(iastContext, 'value', 'param', 'Request')
          const req = { body: { key1: { key2: taintedString } } }

          sanitizeMiddlewareFinished.publish({
            sanitizedProperties: ['body'],
            req
          })

          const sanitizedRanges = getRanges(iastContext, req.body.key1.key2)
          const notSanitizedRanges = getRanges(iastContext, taintedString)

          assert.strictEqual(sanitizedRanges.length, 1)
          assert.strictEqual(notSanitizedRanges.length, 1)

          assert.strictEqual(sanitizedRanges[0].secureMarks, NOSQL_MONGODB_INJECTION_MARK)
          assert.strictEqual(notSanitizedRanges[0].secureMarks, 0)
        })
      })

      describe('sanitize method', () => {
        it('Secure mark is added', () => {
          const taintedString = newTaintedString(iastContext, 'value', 'param', 'Request')
          const sanitizedObject = { param: taintedString }

          sanitizeMethodFinished.publish({
            sanitizedObject
          })

          const sanitizedRanges = getRanges(iastContext, sanitizedObject.param)
          const notSanitizedRanges = getRanges(iastContext, taintedString)

          assert.strictEqual(sanitizedRanges.length, 1)
          assert.strictEqual(notSanitizedRanges.length, 1)

          assert.strictEqual(notSanitizedRanges[0].secureMarks, 0)
          assert.strictEqual(sanitizedRanges[0].secureMarks, NOSQL_MONGODB_INJECTION_MARK)
        })

        it('Secure mark is added in nested objects', () => {
          const taintedString = newTaintedString(iastContext, 'value', 'param', 'Request')
          const sanitizedObject = { key1: { key2: taintedString } }

          sanitizeMethodFinished.publish({
            sanitizedObject
          })

          const sanitizedRanges = getRanges(iastContext, sanitizedObject.key1.key2)
          const notSanitizedRanges = getRanges(iastContext, taintedString)

          assert.strictEqual(sanitizedRanges.length, 1)
          assert.strictEqual(notSanitizedRanges.length, 1)

          assert.strictEqual(sanitizedRanges[0].secureMarks, NOSQL_MONGODB_INJECTION_MARK)
          assert.strictEqual(notSanitizedRanges[0].secureMarks, 0)
        })
      })
    })
  })
})
