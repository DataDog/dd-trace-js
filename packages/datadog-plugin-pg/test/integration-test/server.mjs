import 'dd-trace/init.js'
import pg from 'pg'

const conn = {
  user: 'postgres',
  host: 'localhost',
  database: 'postgres',
  password: 'postgres',
  port: 5432
}

const client = new pg.Client(conn)
client.connect()

await client.query('SELECT NOW() AS now')
client.end()
