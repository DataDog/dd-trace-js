const { testThatRequestHasVulnerability, testThatRequestHasNotVulnerability } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')
const vulnerabilityReporter = require('../../../../src/appsec/iast/vulnerability-reporter')

describe('sql-injection-analyzer with pg', () => {
  let pg
  let client
  withVersions('pg', 'pg', version => {
    describe('pg', () => {
      beforeEach((done) => {
        pg = require(`../../../../../../versions/pg@${version}`).get()
        client = new pg.Client({
          user: 'postgres',
          password: 'postgres',
          database: 'postgres',
          application_name: 'test'
        })
        vulnerabilityReporter.clearCache()
        client.connect(err => done(err))
      })

      afterEach((done) => {
        client.end((err) => {
          done(err)
        })
      })

      describe('has vulnerability', () => {
        testThatRequestHasVulnerability(function () {
          const store = storage.getStore()
          const iastCtx = iastContextFunctions.getIastContext(store)
          let sql = 'SELECT 1'
          sql = newTaintedString(iastCtx, sql, 'param', 'Request')
          return client.query(sql)
        }, 'SQL_INJECTION')
      })

      describe('not has vulnerability', () => {
        testThatRequestHasNotVulnerability(function () {
          const sql = 'SELECT 1'
          return client.query(sql)
        }, 'SQL_INJECTION')
      })
    })
  })
})
