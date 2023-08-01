'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { prepareTestServerForIast } = require('../utils')
const { storage } = require('../../../../../datadog-core')
const iastContextFunctions = require('../../../../src/appsec/iast/iast-context')
const { newTaintedString } = require('../../../../src/appsec/iast/taint-tracking/operations')
const vulnerabilityReporter = require('../../../../src/appsec/iast/vulnerability-reporter')

describe('sql-injection-analyzer with mysql', () => {
  let mysql
  withVersions('mysql', 'mysql', version => {
    prepareTestServerForIast('mysql', (testThatRequestHasVulnerability, testThatRequestHasNoVulnerability) => {
      const srcFilePath = path.join(__dirname, 'resources', 'sql-injection-methods.js')
      const dstFilePath = path.join(os.tmpdir(), 'sql-injection-methods.js')
      let queryMethods

      beforeEach(() => {
        vulnerabilityReporter.clearCache()
        mysql = require(`../../../../../../versions/mysql@${version}`).get()

        fs.copyFileSync(srcFilePath, dstFilePath)
        queryMethods = require(dstFilePath)
      })

      afterEach(() => {
        fs.unlinkSync(dstFilePath)
      })

      describe('with connection', () => {
        let connection

        beforeEach((done) => {
          connection = mysql.createConnection({
            host: 'localhost',
            user: 'root',
            database: 'db'
          })
          connection.connect((err) => done(err))
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
            queryMethods.executeQueryWithCallback(sql, connection, function (err) {
              if (err) {
                reject(err)
              } else {
                resolve()
              }
            })
          })
        }, 'SQL_INJECTION', {
          occurrences: 1,
          location: { path: 'sql-injection-methods.js' }
        })

        testThatRequestHasNoVulnerability(() => {
          return new Promise((resolve, reject) => {
            const sql = 'SELECT 1'
            queryMethods.executeQueryWithCallback(sql, connection, function (err) {
              if (err) {
                reject(err)
              } else {
                resolve()
              }
            })
          })
        }, 'SQL_INJECTION')
      })

      describe('with pool', () => {
        let pool

        beforeEach(() => {
          pool = mysql.createPool({
            connectionLimit: 10,
            host: 'localhost',
            user: 'root',
            database: 'db'
          })
        })

        afterEach((done) => {
          pool.end(done)
        })

        testThatRequestHasVulnerability(() => {
          return new Promise((resolve, reject) => {
            const store = storage.getStore()
            const iastCtx = iastContextFunctions.getIastContext(store)
            let sql = 'SELECT 1'
            sql = newTaintedString(iastCtx, sql, 'param', 'Request')
            queryMethods.executeQueryWithCallback(sql, pool, function (err) {
              if (err) {
                reject(err)
              } else {
                resolve()
              }
            })
          })
        }, 'SQL_INJECTION', {
          occurrences: 1,
          location: { path: 'sql-injection-methods.js' }
        })

        testThatRequestHasNoVulnerability(() => {
          return new Promise((resolve, reject) => {
            const sql = 'SELECT 1'
            queryMethods.executeQueryWithCallback(sql, pool, function (err) {
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
