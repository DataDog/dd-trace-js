'use strict'

const { prepareTestServerForIast } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')
const vulnerabilityReporter = require('../../../../src/appsec/iast/vulnerability-reporter')

describe('sql-injection-analyzer with mysql', () => {
  let mysql
  let connection
  withVersions('mysql', 'mysql', version => {
    prepareTestServerForIast('mysql', (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
      beforeEach(() => {
        vulnerabilityReporter.clearCache()
        mysql = require(`../../../../../../versions/mysql@${version}`).get()
        connection = mysql.createConnection({
          host: 'localhost',
          user: 'root',
          database: 'db'
        })
        connection.connect()
      })

      afterEach((done) => {
        connection.end(done)
      })

      testThatRequestHasVulnerability(() => {
        return new Promise((resolve, reject) => {
          const store = storage.getStore()
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
