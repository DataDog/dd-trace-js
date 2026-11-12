import 'dd-trace/init.js'
import assert from 'node:assert/strict'

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
try {
  await connection.query("SET GLOBAL log_output = 'TABLE'")
  await connection.query("SET GLOBAL general_log = 'ON'")
  const command = Object.freeze({ sql: 'SELECT 5 AS direct_query' })
  const rows = await connection.query(command)
  const logged = await connection.query(
    'SELECT argument FROM mysql.general_log WHERE thread_id = CONNECTION_ID() ' +
    "AND argument LIKE '%SELECT 5 AS direct_query' AND argument NOT LIKE '%general_log%' " +
    'ORDER BY event_time DESC LIMIT 1'
  )

  assert.strictEqual(Number(rows[0].direct_query), 5)
  assert.strictEqual(command.sql, 'SELECT 5 AS direct_query')
  assert.match(logged[0].argument.toString(), /^\/\*dddb='db',.*\*\/ SELECT 5 AS direct_query$/)
  await connection.execute('SELECT 6 AS direct_execute')
} finally {
  await connection.query("SET GLOBAL general_log = 'OFF'")
  await connection.end()
  await pool.end()
}
