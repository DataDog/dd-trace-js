'use strict'

const assert = require('node:assert/strict')

require('dd-trace').init() // eslint-disable-line n/no-missing-require
const postgres = require('postgres') // eslint-disable-line n/no-missing-require

const sql = postgres({
  database: 'postgres',
  host: 'localhost',
  password: 'postgres',
  port: 5432,
  user: 'postgres',
})

async function run () {
  const resource = 'SELECT current_query() AS query'
  const result = await sql.unsafe(resource, [], { prepare: true, simple: true })

  assert.strictEqual(result[0].query, resource)
  await sql.end()
}

run().catch(error => {
  process.nextTick(() => { throw error })
})
