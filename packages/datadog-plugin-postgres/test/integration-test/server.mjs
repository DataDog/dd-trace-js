import assert from 'node:assert/strict'

import 'dd-trace/init.js'
import postgres from 'postgres'

const sql = postgres({
  database: 'postgres',
  host: 'localhost',
  password: 'postgres',
  port: 5432,
  user: 'postgres',
})

const result = await sql.unsafe('SELECT current_query() AS query', [], { prepare: false, simple: true })

assert.match(result[0].query, /^\/\*dddb='postgres',.*\*\/ SELECT current_query\(\) AS query$/)
await sql.end()
