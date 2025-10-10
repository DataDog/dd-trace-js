import mysql from 'mysql2'

const conn = {
  host: '127.0.0.1',
  user: 'root',
  database: 'db',
  port: 3306
}

const connection = mysql.createConnection(conn)

connection.connect()

connection.query('SELECT NOW() AS now', function (error, results, fields) {})

connection.end()
