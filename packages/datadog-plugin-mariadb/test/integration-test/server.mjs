import 'dd-trace/init.js'
import mariadb from 'mariadb'

const pool = mariadb.createPool({
  host: 'localhost',
  user: 'root',
  database: 'db',
  port: 3306,
})
await pool.query('SELECT 1 AS pool_query')
await pool.execute('SELECT 2 AS pool_execute')

const pooledConnection = await pool.getConnection()
await pooledConnection.query('SELECT 3 AS connection_query')
await pooledConnection.execute('SELECT 4 AS connection_execute')
await pooledConnection.release()

const connection = await mariadb.createConnection({
  host: 'localhost',
  user: 'root',
  database: 'db',
  port: 3306,
})
await connection.query('SELECT 5 AS direct_query')
await connection.execute('SELECT 6 AS direct_execute')
await connection.end()

await pool.end()
