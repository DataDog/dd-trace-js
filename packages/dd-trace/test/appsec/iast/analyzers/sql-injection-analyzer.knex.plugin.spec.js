'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const semver = require('semver')
const { prepareTestServerForIast } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')
const vulnerabilityReporter = require('../../../../src/appsec/iast/vulnerability-reporter')

describe('sql-injection-analyzer with knex', () => {
  withVersions('knex', 'knex', knexVersion => {
    if (!semver.satisfies(knexVersion, '>=2')) return
    withVersions('pg', 'pg', pgVersion => {
      let knex

      prepareTestServerForIast('knex + pg',
        (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
          const srcFilePath = path.join(__dirname, 'resources', 'sql-injection-methods.js')
          const dstFilePath = path.join(os.tmpdir(), 'sql-injection-methods.js')
          let queryMethods

          beforeEach(() => {
            vulnerabilityReporter.clearCache()

            const Knex = require(`../../../../../../versions/knex@${knexVersion}`).get()
            knex = Knex({
              client: 'pg',
              connection: {
                host: '127.0.0.1',
                database: 'postgres',
                user: 'postgres',
                password: 'postgres'
              }
            })

            fs.copyFileSync(srcFilePath, dstFilePath)
            queryMethods = require(dstFilePath)
          })

          afterEach(() => {
            knex.destroy()
            fs.unlinkSync(dstFilePath)
          })

          testThatRequestHasVulnerability(() => {
            const store = storage.getStore()
            const iastCtx = iastContextFunctions.getIastContext(store)

            let sql = 'SELECT 1'
            sql = newTaintedString(iastCtx, sql, 'param', 'Request')

            return queryMethods.executeKnexRawQuery(knex, sql)
          }, 'SQL_INJECTION', {
            occurrences: 1,
            location: {
              path: 'sql-injection-methods.js',
              line: 12
            }
          })

          testThatRequestHasNoVulnerability(() => {
            return knex.raw('SELECT 1')
          }, 'SQL_INJECTION')
        })
    })
  })
})
