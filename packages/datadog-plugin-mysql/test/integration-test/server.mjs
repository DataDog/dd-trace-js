import 'dd-trace/init.js'
import * as pluginHelpers from './plugin-helpers.mjs'
import mysql from 'mysql'

pluginHelpers.onMessage(async () => {
  const conn = {
    host: 'localhost',
    user: 'root',
    database: 'db',
    port: 3306
  }

  const connection = mysql.createConnection(conn)
  connection.connect()

  connection.query('SELECT NOW() AS now')
})