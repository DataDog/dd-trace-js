'use strict'

const { prepareTestServerForIast } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')
const vulnerabilityReporter = require('../../../../src/appsec/iast/vulnerability-reporter')

describe('sql-injection-analyzer with mysql2', () => {
  let mysql2
  let connection
  withVersions('mysql2', 'mysql2', version => {
    prepareTestServerForIast('mysql2', (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
      beforeEach(() => {
        vulnerabilityReporter.clearCache()
        mysql2 = require(`../../../../../../versions/mysql2@${version}`).get()
        connection = mysql2.createConnection({
          host: 'localhost',
          user: 'root',
          database: 'db'
        })
        connection.connect()
      })

      afterEach((done) => {
        connection.end(done)
      })

      describe('has vulnerability', () => {
        testThatRequestHasVulnerability(() => {
          return new Promise((resolve, reject) => {
            const store = storage('legacy').getStore()
            const iastCtx = iastContextFunctions.getIastContext(store)
            let sql = 'SELECT 1'
            sql = newTaintedString(iastCtx, sql, 'param', 'Request')
            connection.query(sql, function (err) {
              if (err) {
                reject(err)
              } else {
                resolve()
              }
            })
          })
        }, 'SQL_INJECTION')
      })

      describe('has no vulnerability', () => {
        testThatRequestHasNoVulnerability(() => {
          return new Promise((resolve, reject) => {
            const sql = 'SELECT 1'
            connection.query(sql, function (err) {
              if (err) {
                reject(err)
              } else {
                resolve()
              }
            })
          })
        }, 'SQL_INJECTION')
      })
    })
  })
})
