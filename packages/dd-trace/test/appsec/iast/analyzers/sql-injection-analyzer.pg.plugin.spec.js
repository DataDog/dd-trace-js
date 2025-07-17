'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { prepareTestServerForIast } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')
const vulnerabilityReporter = require('../../../../src/appsec/iast/vulnerability-reporter')

const clients = {
  pg: pg => pg.Client
}

if (process.env.PG_TEST_NATIVE === 'true') {
  clients['pg.native'] = pg => pg.native.Client
}

describe('sql-injection-analyzer with pg', () => {
  let pg
  withVersions('pg', 'pg', '>=8.0.3', version => {
    Object.keys(clients).forEach(implementation => {
      describe(`when using ${implementation}.Client`, () => {
        prepareTestServerForIast('pg', (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          const srcFilePath = path.join(__dirname, 'resources', 'sql-injection-methods.js')
          const dstFilePath = path.join(os.tmpdir(), 'sql-injection-methods.js')
          let queryMethods

          beforeEach(() => {
            pg = require(`../../../../../../versions/pg@${version}`).get()
            vulnerabilityReporter.clearCache()
            fs.copyFileSync(srcFilePath, dstFilePath)
            queryMethods = require(dstFilePath)
          })

          afterEach(() => {
            fs.unlinkSync(dstFilePath)
          })

          describe('with client', () => {
            let client

            beforeEach((done) => {
              client = new pg.Client({
                host: '127.0.0.1',
                user: 'postgres',
                password: 'postgres',
                database: 'postgres',
                application_name: 'test'
              })
              client.connect(err => done(err))
            })

            afterEach(async () => {
              await client.end()
            })

            testThatRequestHasVulnerability(() => {
              const store = storage('legacy').getStore()
              const iastCtx = iastContextFunctions.getIastContext(store)
              let sql = 'SELECT 1'
              sql = newTaintedString(iastCtx, sql, 'param', 'Request')

              return queryMethods.executeQuery(sql, client)
            }, 'SQL_INJECTION', {
              occurrences: 1,
              location: { path: 'sql-injection-methods.js' }
            })

            testThatRequestHasNoVulnerability(() => {
              const sql = 'SELECT 1'
              return queryMethods.executeQuery(sql, client)
            }, 'SQL_INJECTION')
          })

          describe('with pool', () => {
            let pool

            beforeEach(() => {
              pool = new pg.Pool({
                host: '127.0.0.1',
                user: 'postgres',
                password: 'postgres',
                database: 'postgres',
                application_name: 'test'
              })
            })

            afterEach(async () => {
              await pool.end()
            })

            testThatRequestHasVulnerability(() => {
              const store = storage('legacy').getStore()
              const iastCtx = iastContextFunctions.getIastContext(store)
              let sql = 'SELECT 1'
              sql = newTaintedString(iastCtx, sql, 'param', 'Request')

              return queryMethods.executeQuery(sql, pool)
            }, 'SQL_INJECTION', {
              occurrences: 1,
              location: { path: 'sql-injection-methods.js' }
            })

            testThatRequestHasVulnerability(() => {
              const store = storage('legacy').getStore()
              const iastCtx = iastContextFunctions.getIastContext(store)
              let sql = 'SELECT 1'
              sql = newTaintedString(iastCtx, sql, 'param', 'Request')

              return new Promise((resolve) => {
                queryMethods.executeQueryWithCallback(sql, pool, () => resolve())
              })
            }, 'SQL_INJECTION', {
              occurrences: 1,
              location: { path: 'sql-injection-methods.js' }
            })

            testThatRequestHasNoVulnerability(() => {
              const sql = 'SELECT 1'
              return queryMethods.executeQuery(sql, pool)
            }, 'SQL_INJECTION')
          })
        })
      })
    })
  })
})
