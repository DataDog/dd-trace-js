import tracer from 'dd-trace'

import assert from 'node:assert/strict'

import postgres from 'postgres'

tracer.init()

const sql = postgres({
  database: 'postgres',
  host: '127.0.0.1',
  max: 1,
  password: 'postgres',
  port: 5432,
  user: 'postgres',
})

try {
  const tagged = await sql`SELECT ${7}::int AS value`
  assert.strictEqual(tagged[0].value, 7)

  const resource = 'SELECT current_query() AS query'
  for (const prepare of [false, true]) {
    const query = sql.unsafe(resource, [], { prepare, simple: false })
    assert.strictEqual(query.text, resource)
    const result = await query
    assert.strictEqual(query.text, resource)
    const mode = process.env.DD_DBM_PROPAGATION_MODE
    if (mode === 'disabled') {
      assert.strictEqual(result[0].query, resource)
    } else {
      assert.match(result[0].query, /^\/\*dddb='postgres',.*\*\/ SELECT current_query\(\) AS query$/)
      assert.strictEqual(result[0].query.includes('traceparent='), mode === 'full' && !prepare)
    }
  }

  await assert.rejects(sql.unsafe('INVALID NATIVE SQL'), { code: '42601' })
} finally {
  await sql.end({ timeout: 0 })
}
