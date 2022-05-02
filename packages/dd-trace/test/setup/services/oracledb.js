const RetryOperation = require('../operation')
const oracledb = require('../../../../../versions/oracledb').get()

const hostname = process.env.CI ? 'oracledb' : 'localhost'

function waitForOracledb () {
  return new Promise((resolve, reject) => {
    const operation = new RetryOperation('oracledb')
    operation.attempt(currentAttempt => {
      oracledb
        .getConnection({
          user: 'sys',
          password: 'Oracle18',
          connectString: `${hostname}:1521/xepdb1`,
          privilege: 2
        })
        .then(connection => {
          return ensureTestUser(connection)
        })
        .then(resolve)
        .catch(err => {
          if (!operation.retry(err)) reject(err)
        })
    })
  })
}

async function ensureTestUser (connection) {
  const result = await connection.execute('select * from dba_users where username = \'TEST\'')
  if (result.rows.length) {
    return
  }

  await connection.execute('create user test identified by "Oracle18"')
  await connection.execute('grant connect to test')
}

module.exports = waitForOracledb
