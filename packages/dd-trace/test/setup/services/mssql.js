'use strict'

const semver = require('semver')

const RetryOperation = require('../operation')

function waitForMssql (isSandbox) {
  const tediousPackage = isSandbox ? require('tedious') : require('../../../../../versions/tedious')
  const tedious = isSandbox ? tediousPackage : tediousPackage.get()
  // tedious <10 starts connecting on construction, while >=10 requires an explicit connect(); calling connect() on
  // the older line throws "No event 'socketConnect' in state 'SentPrelogin'". The version expansion can resolve the
  // unversioned folder to an older major (e.g. the >=1 <7 shard), so mirror the guard the plugin specs already use.
  const needsExplicitConnect = isSandbox || semver.intersects(tediousPackage.version(), '>=10.0.0')

  return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    const operation = new RetryOperation('mssql')

    operation.attempt(currentAttempt => {
      const connection = new tedious.Connection({
        server: 'localhost',
        options: {
          trustServerCertificate: true,
        },
        authentication: {
          options: {
            userName: 'sa',
            password: 'DD_HUNTER2',
          },
          type: 'default',
        },
      }).on('connect', err => {
        if (operation.retry(err)) return
        if (err) return reject(err)

        // Create a stored procedure for tests
        const storedProc = 'CREATE OR ALTER PROCEDURE dbo.ddTestProc @num INT AS SELECT @num + 1 GO;'
        const request = new tedious.Request(storedProc, (err) => {
          connection.close()
          if (err) reject(err)
          else resolve()
        })

        connection.execSql(request)
      })
      if (needsExplicitConnect) connection.connect()
    })
  }))
}

module.exports = waitForMssql
