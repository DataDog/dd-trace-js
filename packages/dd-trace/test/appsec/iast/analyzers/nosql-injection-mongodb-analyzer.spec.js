'use strict'

const assert = require('node:assert/strict')

const { afterEach, before, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { storage } = require('../../../../../datadog-core')
const { channel } = require('../../../../../datadog-instrumentations/src/helpers/instrument')
const {
  createTransaction,
  newTaintedString,
  removeTransaction,
  getRanges,
} = require('../../../../src/appsec/iast/taint-tracking/operations')
const { IAST_CONTEXT_KEY } = require('../../../../src/appsec/iast/iast-context')
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
              },
            },
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
            req,
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
            req,
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
            sanitizedObject,
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
            sanitizedObject,
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

  describe('per-query analysis scoping', () => {
    const legacyStorage = storage('legacy')
    const nosqlAnalyzer = require('../../../../src/appsec/iast/analyzers/nosql-injection-mongodb-analyzer')
    const mongooseFilterStart = channel('datadog:mongoose:model:filter:start')
    const mongooseFilterExec = channel('datadog:mongoose:model:filter:exec')
    const mongodbFilterStart = channel('datadog:mongodb:collection:filter:start')

    let analyze

    // Drive an outer mongoose query the way the instrumentation does: the filters
    // are analyzed at the synchronous build (`model:filter:start`), then the query
    // executes inside `model:filter:exec`'s `runStores`, which enters the marked
    // store the analyzer's bound transform returns. The nested mongodb driver start
    // fires a turn later, from inside that execution scope, mirroring mongoose
    // deferring to the driver after the build has returned. `model:filter:start`
    // uses `runStores` to match the instrumentation: that is what makes the build
    // analysis run, so a marker missing at execution time surfaces as a second
    // analysis on the deferred driver call.
    function runMongooseQuery (store, filter) {
      return new Promise((resolve, reject) => {
        legacyStorage.run(store, () => {
          mongooseFilterStart.runStores({ filters: [filter] }, () => {})

          mongooseFilterExec.runStores({ filters: [filter] }, () => {
            setImmediate(() => {
              try {
                mongodbFilterStart.publish({ filters: [filter] })
                resolve()
              } catch (error) {
                reject(error)
              }
            })
          })
        })
      })
    }

    beforeEach(() => {
      nosqlAnalyzer.configure({ enabled: true })
      analyze = sinon.spy(nosqlAnalyzer, 'analyze')
    })

    afterEach(() => {
      analyze.restore()
      nosqlAnalyzer.configure({ enabled: false })
    })

    it('analyzes an outer query once and skips its deferred driver call', async () => {
      const store = { [IAST_CONTEXT_KEY]: {} }

      await runMongooseQuery(store, { name: 'value' })

      assert.strictEqual(analyze.callCount, 1)
    })

    it('analyzes a direct mongodb driver query with no outer mongoose layer', () => {
      const store = { [IAST_CONTEXT_KEY]: {} }

      legacyStorage.run(store, () => {
        mongodbFilterStart.publish({ filters: [{ name: 'value' }] })
      })

      assert.strictEqual(analyze.callCount, 1)
    })

    it('does not analyze when there is no IAST context in the store', async () => {
      await runMongooseQuery({}, { name: 'value' })

      assert.strictEqual(analyze.callCount, 0)
    })

    it('skips a query whose store is already marked as analyzed', async () => {
      const store = { [IAST_CONTEXT_KEY]: {}, nosqlAnalyzed: true }

      await runMongooseQuery(store, { name: 'value' })

      assert.strictEqual(analyze.callCount, 0)
    })

    it('analyzes both of two concurrent queries in the same request', async () => {
      // Two queries of the same request run concurrently: each execution scope
      // branches from the shared request store, not from the sibling's child
      // store, so neither query's marker suppresses the other. Both outer filters
      // are analyzed and each deferred driver call is skipped.
      const requestStore = { [IAST_CONTEXT_KEY]: {} }
      const filterA = { name: 'a' }
      const filterB = { name: 'b' }

      await new Promise((resolve, reject) => {
        legacyStorage.run(requestStore, () => {
          Promise.all([
            runMongooseQuery(requestStore, filterA),
            runMongooseQuery(requestStore, filterB),
          ]).then(resolve, reject)
        })
      })

      assert.strictEqual(analyze.callCount, 2)
      const analyzedFilters = new Set(analyze.args.map(([value]) => value.filter))
      assert.ok(analyzedFilters.has(filterA), 'query A filter analyzed')
      assert.ok(analyzedFilters.has(filterB), 'query B filter analyzed')
    })
  })
})
