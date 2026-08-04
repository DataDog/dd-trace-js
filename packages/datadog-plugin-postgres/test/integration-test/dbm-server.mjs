import 'dd-trace/init.js'

import tracer from 'dd-trace'
import assert from 'node:assert/strict'

import postgres from 'postgres'

tracer.use('postgres', {
  dbmPropagationMode: 'service',
  service: 'serviced',
})

const sql = postgres({
  database: 'postgres',
  host: 'localhost',
  password: 'postgres',
  port: 5432,
  user: 'postgres',
})

const result = await sql.unsafe('SELECT current_query() AS query')

assert.match(result[0].query, /^\/\*dddb='postgres',dddbs='serviced'/)
await sql.end()
