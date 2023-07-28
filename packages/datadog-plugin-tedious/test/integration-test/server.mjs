import 'dd-trace/init.js'
import tedious from 'tedious'

const config = {
  server: 'localhost',
  options: {
    database: 'master',
    trustServerCertificate: true
  },
  authentication: {
    type: 'default',
    options: {
      userName: 'sa',
      password: 'DD_HUNTER2'
    }
  }
}

const connection = new tedious.Connection(config)

connection.on('connect', () => {
  const sql = 'SELECT 1 + 1 AS solution'
  const request = new tedious.Request(sql, () => {})
  connection.execSql(request)
})

connection.connect()

process.send({ port: -1 })
