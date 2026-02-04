'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { prepareTestServerForIast } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const { withVersions } = require('../../../setup/mocha')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')
const vulnerabilityReporter = require('../../../../src/appsec/iast/vulnerability-reporter')

describe('sql-injection-analyzer with knex', () => {
  const originalMaxStackTraces = process.env.DD_APPSEC_MAX_STACK_TRACES

  withVersions('knex', 'knex', '>=2', knexVersion => {
    withVersions('pg', 'pg', () => {
      let knex

      prepareTestServerForIast('knex + pg',
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          const srcFilePath = path.join(__dirname, 'resources', 'knex-sql-injection-methods.js')
          const dstFilePath = path.join(os.tmpdir(), 'knex-sql-injection-methods.js')
          let queryMethods

          before(() => {
            // This suite can emit multiple IAST vulnerabilities (e.g. WEAK_HASH during pg auth) before SQL_INJECTION.
            // The default stack trace budget is 2, which can be exhausted before SQL_INJECTION is reported.
            process.env.DD_APPSEC_MAX_STACK_TRACES = '10'
          })

          after(() => {
            if (originalMaxStackTraces === undefined) {
              delete process.env.DD_APPSEC_MAX_STACK_TRACES
            } else {
              process.env.DD_APPSEC_MAX_STACK_TRACES = originalMaxStackTraces
            }
          })

          beforeEach(() => {
            vulnerabilityReporter.clearCache()

            const Knex = require(`../../../../../../versions/knex@${knexVersion}`).get()
            knex = Knex({
              client: 'pg',
              connection: {
                host: '127.0.0.1',
                database: 'postgres',
                user: 'postgres',
                password: 'postgres',
              },
            })

            fs.copyFileSync(srcFilePath, dstFilePath)
            queryMethods = require(dstFilePath)
          })

          afterEach(() => {
            knex.destroy()
            fs.unlinkSync(dstFilePath)
          })

          describe('simple raw query', () => {
            testThatRequestHasVulnerability(() => {
              const store = storage('legacy').getStore()
              const iastCtx = iastContextFunctions.getIastContext(store)

              let sql = 'SELECT 1'
              sql = newTaintedString(iastCtx, sql, 'param', 'Request')

              return queryMethods.executeKnexRawQuery(knex, sql)
            }, 'SQL_INJECTION', {
              occurrences: 1,
              location: {
                path: 'knex-sql-injection-methods.js',
                line: 4,
              },
            })

            testThatRequestHasNoVulnerability(() => {
              return knex.raw('SELECT 1')
            }, 'SQL_INJECTION')
          })

          describe('nested raw query', () => {
            testThatRequestHasVulnerability(() => {
              const store = storage('legacy').getStore()
              const iastCtx = iastContextFunctions.getIastContext(store)

              let taintedSql = 'SELECT 1'
              taintedSql = newTaintedString(iastCtx, taintedSql, 'param', 'Request')

              const notTaintedSql = 'SELECT 1'

              return queryMethods.executeKnexNestedRawQuery(knex, taintedSql, notTaintedSql)
            }, 'SQL_INJECTION', {
              occurrences: 1,
              location: {
                path: 'knex-sql-injection-methods.js',
                line: 9,
              },
            })
          })

          describe('nested raw query - using async instead of then', () => {
            testThatRequestHasVulnerability(() => {
              const store = storage('legacy').getStore()
              const iastCtx = iastContextFunctions.getIastContext(store)

              let taintedSql = 'SELECT 1'
              taintedSql = newTaintedString(iastCtx, taintedSql, 'param', 'Request')

              const notTaintedSql = 'SELECT 1'

              return queryMethods.executeKnexAsyncNestedRawQuery(knex, taintedSql, notTaintedSql)
            }, 'SQL_INJECTION', {
              occurrences: 1,
              location: {
                path: 'knex-sql-injection-methods.js',
                line: 40,
              },
            })
          })

          describe('nested raw query - onRejected as then argument', () => {
            testThatRequestHasVulnerability(() => {
              const store = storage('legacy').getStore()
              const iastCtx = iastContextFunctions.getIastContext(store)

              let taintedSql = 'SELECT 1'
              taintedSql = newTaintedString(iastCtx, taintedSql, 'param', 'Request')

              const sqlToFail = 'SELECT * FROM NON_EXISTSING_TABLE'

              return queryMethods.executeKnexNestedRawQueryOnRejectedInThen(knex, taintedSql, sqlToFail)
            }, 'SQL_INJECTION', {
              occurrences: 1,
              location: {
                path: 'knex-sql-injection-methods.js',
                line: 17,
              },
            })
          })

          describe('nested raw query - with catch', () => {
            testThatRequestHasVulnerability(() => {
              const store = storage('legacy').getStore()
              const iastCtx = iastContextFunctions.getIastContext(store)

              let taintedSql = 'SELECT 1'
              taintedSql = newTaintedString(iastCtx, taintedSql, 'param', 'Request')

              const sqlToFail = 'SELECT * FROM NON_EXISTSING_TABLE'

              return queryMethods.executeKnexNestedRawQueryWitCatch(knex, taintedSql, sqlToFail)
            }, 'SQL_INJECTION', {
              occurrences: 1,
              location: {
                path: 'knex-sql-injection-methods.js',
                line: 28,
              },
            })
          })

          describe('nested raw query - async try catch', () => {
            testThatRequestHasVulnerability(() => {
              const store = storage('legacy').getStore()
              const iastCtx = iastContextFunctions.getIastContext(store)

              let taintedSql = 'SELECT 1'
              taintedSql = newTaintedString(iastCtx, taintedSql, 'param', 'Request')

              const sqlToFail = 'SELECT * FROM NON_EXISTSING_TABLE'

              return queryMethods.executeKnexAsyncNestedRawQueryAsAsyncTryCatch(knex, taintedSql, sqlToFail)
            }, 'SQL_INJECTION', {
              occurrences: 1,
              location: {
                path: 'knex-sql-injection-methods.js',
                line: 47,
              },
            })
          })

          describe('nested raw query - asCallback', () => {
            testThatRequestHasVulnerability(() => {
              return new Promise((resolve, reject) => {
                const store = storage('legacy').getStore()
                const iastCtx = iastContextFunctions.getIastContext(store)

                let taintedSql = 'SELECT 1'
                taintedSql = newTaintedString(iastCtx, taintedSql, 'param', 'Request')

                const sqlToFail = 'SELECT * FROM NON_EXISTSING_TABLE'

                queryMethods.executeKnexNestedRawQueryAsCallback(knex, taintedSql, sqlToFail, (err, result) => {
                  if (err) {
                    reject(err)
                  } else {
                    resolve(result)
                  }
                })
              })
            }, 'SQL_INJECTION', {
              occurrences: 1,
              location: {
                path: 'knex-sql-injection-methods.js',
                line: 34,
              },
            })
          })
        })
    })
  })
})
