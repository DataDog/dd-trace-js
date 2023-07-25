import 'dd-trace/init.js'
import * as pluginHelpers from './plugin-helpers.mjs'
import mariadb from 'mariadb'

pluginHelpers.onMessage(async () => {
  const pool = mariadb.createPool({
    host: 'localhost',
    user: 'root',
    database: 'db',
    port: 3306
  })
  const conn = await pool.getConnection()
  await conn.query('SELECT NOW() AS now')
  conn.release()
})
