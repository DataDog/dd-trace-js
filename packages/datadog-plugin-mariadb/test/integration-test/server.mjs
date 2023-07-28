import 'dd-trace/init.js'
import mariadb from 'mariadb'

const pool = mariadb.createPool({
  host: 'localhost',
  user: 'root',
  database: 'db',
  port: 3306
})
const conn = await pool.getConnection()
await conn.query('SELECT NOW() AS now')
conn.release()

process.send({ port: -1 }) 