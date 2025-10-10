import 'dd-trace/init.js'
import { createConnection } from 'mysql'
const mysql = { createConnection }

const conn = {
  host: 'localhost',
  user: 'root',
  database: 'db',
  port: 3306
}

const connection = mysql.createConnection(conn)
connection.connect()

connection.query('SELECT NOW() AS now', function (error, results, fields) {})

connection.end()

