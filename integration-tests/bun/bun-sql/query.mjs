import tracer from 'dd-trace'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { sql, SQL } from 'bun'

import finish from '../finish.js'

tracer.init({ startupLogs: false, flushInterval: 10 })

const mode = process.env.SQL_TEST_MODE
const url = 'postgres://postgres:postgres@127.0.0.1:5432/postgres'
const db = mode === 'sqlite'
  ? new SQL(':memory:')
  : mode === 'mysql' ? new SQL('mysql://root@127.0.0.1:3306/db') : new SQL(url)

try {
  await tracer.trace('bun.sql.parent', async () => {
    switch (mode) {
      case 'tagged':
      case 'disabled':
      case 'sqlite':
      case 'mysql':
        assert.equal((await sql`SELECT ${7} as n`)[0].n, 7)
        assert.equal((await db`SELECT ${8} as n`)[0].n, 8)
        break
      case 'unsafe':
        assert.equal((await db.unsafe('SELECT 9 as n'))[0].n, 9)
        assert.equal((await db.unsafe('SELECT $1::int as n', [10]))[0].n, 10)
        break
      case 'transaction': {
        await db.begin(async tx => {
          assert.equal((await tx`SELECT ${11} as n`)[0].n, 11)
        })
        const reserved = await db.reserve()
        try {
          assert.equal((await reserved`SELECT ${12} as n`)[0].n, 12)
        } finally {
          reserved.release()
        }
        break
      }
      case 'error':
        await assert.rejects(db`SELECT invalid_column`, {
          name: 'PostgresError',
          code: 'ERR_POSTGRES_SERVER_ERROR',
          errno: '42703',
          message: 'column "invalid_column" does not exist',
        })
        break
      case 'dbm':
      case 'dbm-full':
      case 'dbm-simple':
      case 'dbm-prepared': {
        const rows = mode === 'dbm-full'
          ? await db.unsafe('SELECT current_query() as statement')
          : mode === 'dbm-simple'
            ? await db`SELECT current_query() as statement`.simple()
            : await db`SELECT current_query() as statement, ${13}::int as n`
        assert.match(rows[0].statement, /dddbs='/)
        assert.match(rows[0].statement, /ddps='bun-sql-test'/)
        if (mode === 'dbm-full' || mode === 'dbm-simple') assert.match(rows[0].statement, /traceparent='/)
        else assert.doesNotMatch(rows[0].statement, /traceparent='/)
        break
      }
      case 'lifecycle': {
        const query = db`SELECT ${14} as n`
        assert.strictEqual(query.execute(), query)
        await query
        await query
        assert.equal((await db`SELECT ${15} as n`.run())[0].n, 15)
        await db`SELECT invalid_column`.catch(err => assert.equal(err.errno, '42703'))
        let finalized = false
        await db`SELECT ${16} as n`.finally(() => { finalized = true })
        assert.ok(finalized)
        assert.equal((await db.file(fileURLToPath(new URL('./query.sql', import.meta.url))))[0].n, 23)
        assert.equal((await db`SELECT 1 WHERE false`).length, 0)
        break
      }
      default:
        throw new Error(`Unknown SQL test mode: ${mode}`)
    }
  })
} finally {
  await Promise.all([db.close(), sql.close()])
}

finish()
