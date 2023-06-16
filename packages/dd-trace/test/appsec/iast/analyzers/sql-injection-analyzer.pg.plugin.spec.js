'use strict'

const semver = require('semver')
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

const range = semver.satisfies(process.versions.node, '^12.0.0') ? '>=4.5.5' : '>=8.0.3'

describe('sql-injection-analyzer with pg', () => {
  let pg
  let client
  withVersions('pg', 'pg', range, version => {
    Object.keys(clients).forEach(implementation => {
      describe(`when using ${implementation}.Client`, () => {
        prepareTestServerForIast('pg', (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
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

          testThatRequestHasVulnerability(() => {
            const store = storage.getStore()
            const iastCtx = iastContextFunctions.getIastContext(store)
            let sql = 'SELECT 1'
            sql = newTaintedString(iastCtx, sql, 'param', 'Request')
            return client.query(sql)
          }, 'SQL_INJECTION')

          testThatRequestHasNoVulnerability(() => {
            const sql = 'SELECT 1'
            return client.query(sql)
          }, 'SQL_INJECTION')
        })
      })
    })
  })
})
