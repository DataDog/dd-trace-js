import 'dd-trace/init.js'
import mysql from 'mysql2'

const conn = {
  host: 'localhost',
  user: 'root',
  database: 'db',
  port: 3306
}

const connection = mysql.createConnection(conn)

connection.connect()

connection.query('SELECT NOW() AS now')

process.send({ port: -1 })
