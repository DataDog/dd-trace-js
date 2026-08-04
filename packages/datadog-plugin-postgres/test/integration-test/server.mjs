import 'dd-trace/init.js'
import postgres from 'postgres'

const sql = postgres({
  database: 'postgres',
  host: 'localhost',
  password: 'postgres',
  port: 5432,
  user: 'postgres',
})

await sql`SELECT 1 AS value`
await sql.end()
