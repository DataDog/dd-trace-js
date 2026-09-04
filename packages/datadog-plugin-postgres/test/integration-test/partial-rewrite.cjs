'use strict'

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
  const result = await sql`SELECT 1 AS value`
  if (result[0].value !== 1) throw new Error('unexpected query result')
  await sql.end()
}

run().catch(error => {
  process.nextTick(() => { throw error })
})
