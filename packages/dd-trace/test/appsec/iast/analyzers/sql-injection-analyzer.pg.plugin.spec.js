const { testThatRequestHasVulnerability, testThatRequestHasNoVulnerability } = require('../utils')
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

      afterEach(async () => {
        await client.end()
      })

      describe('has vulnerability', () => {
        testThatRequestHasVulnerability(() => {
          const store = storage.getStore()
          const iastCtx = iastContextFunctions.getIastContext(store)
          let sql = 'SELECT 1'
          sql = newTaintedString(iastCtx, sql, 'param', 'Request')
          return client.query(sql)
        }, 'SQL_INJECTION')
      })

      describe('has no vulnerability', () => {
        testThatRequestHasNoVulnerability(() => {
          const sql = 'SELECT 1'
          return client.query(sql)
        }, 'SQL_INJECTION')
      })
    })
  })
})
