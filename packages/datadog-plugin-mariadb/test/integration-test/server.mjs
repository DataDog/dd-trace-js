import mariadb from 'mariadb'

const pool = mariadb.createPool({
  host: 'localhost',
  user: 'root',
  database: 'db',
  port: 3306
})
await pool.query('SELECT 1 + 1 AS solution')
await pool.end()
