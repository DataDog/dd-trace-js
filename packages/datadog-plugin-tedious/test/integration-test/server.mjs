import tds from 'tedious'

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

let connection
let connectionIsClosed = false

function connectToDatabase (done) {
  connection = new tds.Connection(config)
  connection = new tds.Connection(config)

  connection.on('connect', () => {
    const sql = 'SELECT 1 + 1 AS solution'
    const request = new tds.Request(sql, () => {})
    connection.execSql(request)
    connectionIsClosed = false
    done()
  })

  connection.connect()
}

function closeConnection (done) {
  if (!connectionIsClosed && connection) {
    connection.on('end', () => {
      connectionIsClosed = true
      done()
    })
    connection.close()
  } else {
    done()
  }
}
connectToDatabase(() => {
  closeConnection(() => {})
})
