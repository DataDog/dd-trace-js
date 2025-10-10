import 'dd-trace/init.js'
import mysql from 'mysql'

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

