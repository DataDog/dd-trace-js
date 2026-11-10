'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const dc = require('dc-polyfill')

const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

require('../../../register')

/**
 * @template T
 * @param {string} resource
 * @param {() => PromiseLike<T>} run
 * @param {(span: import('../../dd-trace/test/plugins/agent').SerializedSpan) => void} [check]
 */
async function traced (resource, run, check) {
  const received = agent.assertSomeTraces(traces => {
    const spans = traces.flat().filter(span => span.meta.component === 'postgres' && span.resource === resource)
    assert.strictEqual(spans.length, 1)
    check?.(spans[0])
  }, { spanResourceMatch: new RegExp(`^${resource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
  const [result] = await Promise.all([run(), received])
  return result
}

describe('postgres native query lifecycle', () => {
  withVersions('postgres', 'postgres', '>=4', version => {
    let postgres
    let sql
    let tracer

    before(() => agent.load('postgres'))
    beforeEach(async () => {
      const postgresModule = require(`../../../versions/postgres@${version}`)
      postgres = (await import(pathToFileURL(postgresModule.getPath()).href)).default
      sql = postgres({
        database: 'postgres',
        host: '127.0.0.1',
        max: 1,
        password: 'postgres',
        port: 5432,
        user: 'postgres',
      })
      tracer = require('../../dd-trace')
      tracer.use('postgres', { dbmPropagationMode: 'full', service: 'native-postgres' })
    })
    afterEach(() => sql.end({ timeout: 0 }))
    after(() => agent.close())

    it('preserves tagged query text, identity and repeated settlement', async () => {
      const query = sql`SELECT ${7}::int AS value`
      assert.strictEqual(query.execute(), query)
      const result = await traced('SELECT $1::int AS value', () => query, span => {
        assert.strictEqual(span.meta['out.host'], '127.0.0.1')
        assert.strictEqual(span.metrics['network.destination.port'], 5432)
        assert.ok(span.metrics['db.pool.wait_time_ms'] >= 0)
        assert.strictEqual(span.meta['db.pid'], undefined)
      })
      assert.strictEqual(result[0].value, 7)
      assert.strictEqual(query.text, 'SELECT $1::int AS value')
      assert.strictEqual(await query, result)
    })

    it('inherits the active parent through native runStores', async () => {
      let parentId
      const received = agent.assertSomeTraces(traces => {
        const span = traces.flat().find(span => span.resource === 'SELECT 16 AS child')
        assert.strictEqual(span.parent_id.toString(), parentId)
      })
      await tracer.trace('native-parent', async parent => {
        parentId = parent.context().toSpanId()
        assert.strictEqual((await sql`SELECT 16 AS child`)[0].child, 16)
      })
      await received
    })

    it('preserves unsafe and file preparation defaults and falsey options', async () => {
      const values = [undefined, null, 0, false, '', NaN, true]
      const resource = 'SELECT 9::int AS boundary\n'
      const file = path.join(__dirname, 'fixtures', 'boundary.sql')
      for (const api of ['unsafe', 'file']) {
        for (const overload of ['options', 'args-options']) {
          for (const field of ['prepare', 'simple']) {
            for (const value of ['absent', ...values]) {
              const options = field === 'prepare' ? { simple: false } : {}
              if (value !== 'absent') options[field] = value
              const statement = 'SELECT 9::int AS boundary'
              const query = api === 'unsafe'
                ? overload === 'options' ? sql.unsafe(statement, options) : sql.unsafe(statement, [], options)
                : overload === 'options' ? sql.file(file, options) : sql.file(file, [], options)
              const result = await traced(api === 'file' ? resource : statement, () => query)
              assert.strictEqual(result[0].boundary, 9)
              assert.strictEqual(query.text, api === 'file' ? resource : statement)
              const prepared = (!query.options.simple || query.args.length > 0) && query.options.prepare !== false
              assert.strictEqual(Boolean(query.statement.name), prepared)
            }
          }
        }
      }
      for (const api of ['unsafe', 'file']) {
        const statement = 'SELECT $1::text AS message\n'
        const input = api === 'file' ? path.join(__dirname, 'fixtures', 'select.sql') : statement
        const query = sql[api](input, ['boundary'], { simple: true })
        assert.strictEqual((await traced(statement, () => query))[0].message, 'boundary')
        assert.strictEqual(Boolean(query.statement.name), api === 'file')
      }
    }).timeout(30000)

    it('changes cached comments with service and DBM configuration', async () => {
      const resource = 'SELECT current_query() AS cached'
      const execute = () => sql`SELECT current_query() AS cached`
      for (const [mode, service] of [
        ['service', 'first'], ['service', 'second'], ['disabled', 'second'], ['full', 'third'],
      ]) {
        tracer.use('postgres', { dbmPropagationMode: mode, service })
        const query = execute()
        const result = await traced(resource, () => query, span => assert.strictEqual(span.service, service))
        assert.strictEqual(query.text, resource)
        if (mode === 'disabled') {
          assert.strictEqual(result[0].cached, resource)
        } else {
          assert.ok(result[0].cached.includes(`dddbs='${service}'`))
          assert.strictEqual(result[0].cached.includes('traceparent='), false)
        }
      }
    })

    it('preserves callback, iterator and early-return cursors', async () => {
      const resource = 'SELECT generate_series(1,3) AS value'
      const rows = []
      await traced(resource, () => sql.unsafe(resource).cursor(1, batch => rows.push(...batch)))
      assert.strictEqual(rows.length, 3)
      await traced(resource, async () => {
        const values = []
        for await (const batch of sql.unsafe(resource).cursor(1)) values.push(...batch)
        assert.strictEqual(values.length, 3)
      })
      await traced(resource, async () => {
        const iterator = sql.unsafe(resource).cursor(1)[Symbol.asyncIterator]()
        assert.strictEqual((await iterator.next()).value[0].value, 1)
        await iterator.return()
      })
    })

    it('preserves describe, simple, values, raw and forEach results', async () => {
      const resource = 'SELECT 18 AS value'
      const description = await traced(resource, () => sql.unsafe(resource).describe())
      assert.strictEqual(description.columns[0].name, 'value')
      assert.strictEqual((await traced(resource, () => sql.unsafe(resource).simple()))[0].value, 18)
      assert.deepStrictEqual((await traced(resource, () => sql.unsafe(resource).values()))[0], [18])
      const raw = await traced(resource, () => sql.unsafe(resource).raw())
      assert.strictEqual(raw[0][0].toString(), '18')
      const values = []
      await traced(resource, () => sql.unsafe(resource).forEach(row => values.push(row.value)))
      assert.deepStrictEqual(values, [18])
    })

    it('finishes native server, build, file and cancellation errors', async () => {
      await traced('INVALID NATIVE SQL', () => assert.rejects(sql.unsafe('INVALID NATIVE SQL'), { code: '42601' }),
        span => assert.strictEqual(span.error, 1))
      await traced('postgres.query', () => assert.rejects(sql`SELECT ${undefined}`,
        { message: /Undefined values are not allowed/ }), span => assert.strictEqual(span.error, 1))
      await traced('postgres.query', () => assert.rejects(sql.file(path.join(__dirname, 'missing.sql')),
        { code: 'ENOENT' }), span => assert.strictEqual(span.error, 1))
      const cancelled = sql`SELECT 10 AS cancelled`
      await cancelled.cancel()
      await traced('SELECT 10 AS cancelled', () => assert.rejects(cancelled, { code: '57014' }),
        span => assert.strictEqual(span.error, 1))
    })

    it('adds no listeners to COPY streams', async () => {
      await sql.unsafe('CREATE TEMP TABLE native_copy_listeners(value int)')
      for (const direction of ['readable', 'writable']) {
        const statement = direction === 'readable'
          ? 'COPY (SELECT 3) TO STDOUT'
          : 'COPY native_copy_listeners FROM STDIN'
        await traced(statement, async () => {
          const stream = await sql.unsafe(statement)[direction]()
          try {
            assert.deepStrictEqual(stream.eventNames(), [])
          } finally {
            const closed = once(stream, 'close')
            stream.destroy()
            stream.destroy()
            await closed
          }
        })
      }
    })

    it('finishes COPY spans when disabled after the stream is returned', async () => {
      await sql.unsafe('CREATE TEMP TABLE native_copy_disabled(value int)')
      const statement = 'COPY native_copy_disabled FROM STDIN'
      await traced(statement, async () => {
        const stream = await sql.unsafe(statement).writable()
        tracer.use('postgres', { enabled: false })
        const completed = once(stream, 'finish')
        stream.end('4\n')
        await completed
      })
    })

    it('records COPY connection failures after the stream is returned', async () => {
      await sql.unsafe('CREATE TEMP TABLE native_copy_disconnected(value int)')
      const statement = 'COPY native_copy_disconnected FROM STDIN'
      await traced(statement, async () => {
        const stream = await sql.unsafe(statement).writable()
        const failed = once(stream, 'error')
        const ended = sql.end({ timeout: 0 })
        const [errors] = await Promise.all([failed, ended])
        assert.strictEqual(errors[0].code, 'CONNECTION_DESTROYED')
      }, span => assert.strictEqual(span.error, 1))
    })

    it('ignores COPY completion when another subscriber observed a disabled start', async () => {
      await sql.unsafe('CREATE TEMP TABLE native_copy_late(value int)')
      const channel = dc.channel('tracing:postgres:query:start')
      const observed = []
      const observe = ctx => { observed.push(ctx.query) }
      channel.subscribe(observe)
      try {
        for (const direction of ['readable', 'writable']) {
          tracer.use('postgres', { enabled: false })
          const statement = direction === 'readable'
            ? 'COPY (SELECT 5) TO STDOUT'
            : 'COPY native_copy_late FROM STDIN'
          const stream = await sql.unsafe(statement)[direction]()
          tracer.use('postgres', {})
          const absent = agent.assertNoTraces(() => assert.fail('disabled COPY created a span'), {
            spanResourceMatch: /^COPY/, timeoutMs: 200,
          })
          const closed = once(stream, 'close')
          stream.destroy()
          await Promise.all([closed, absent])
          assert.strictEqual(observed.includes(statement), true)
        }
      } finally {
        channel.unsubscribe(observe)
      }
    })

    it('keeps COPY spans open until their streams finish', async () => {
      const resource = 'COPY (SELECT 1) TO STDOUT'
      await traced(resource, async () => {
        const readable = await sql.unsafe(resource).readable()
        let output = ''
        for await (const chunk of readable) output += chunk
        assert.strictEqual(output, '1\n')
      })
      await sql.unsafe('CREATE TEMP TABLE native_copy(value int)')
      const writableResource = 'COPY native_copy FROM STDIN'
      const writable = await sql.unsafe(writableResource).writable()
      await agent.assertNoTraces(() => assert.fail('COPY finished before stream completion'), {
        spanResourceMatch: /^COPY native_copy FROM STDIN$/, timeoutMs: 200,
      })
      await traced(writableResource, async () => {
        const finished = once(writable, 'finish')
        writable.end('1\n2\n')
        await finished
      })
      const result = await traced('SELECT sum(value)::int AS total FROM native_copy',
        () => sql`SELECT sum(value)::int AS total FROM native_copy`)
      assert.strictEqual(result[0].total, 3)
    })

    it('records late COPY errors and closes abandoned streams', async () => {
      await sql.unsafe('CREATE TEMP TABLE native_copy_error(value int)')
      const resource = 'COPY native_copy_error FROM STDIN'
      await traced(resource, async () => {
        const stream = await sql.unsafe(resource).writable()
        const failed = once(stream, 'error')
        stream.end('invalid\n')
        assert.strictEqual((await failed)[0].code, '22P02')
      }, span => assert.strictEqual(span.error, 1))
      const failingRead = 'COPY (SELECT generate_series(1,100)) TO STDOUT'
      await traced(failingRead, async () => {
        const stream = await sql.unsafe(failingRead).readable()
        const failed = once(stream, 'error')
        const error = new Error('reader failed')
        stream.destroy(error)
        assert.strictEqual((await failed)[0], error)
      }, span => assert.strictEqual(span.error, 1))
      for (const direction of ['readable', 'writable']) {
        const statement = direction === 'readable' ? 'COPY (SELECT 2) TO STDOUT' : resource
        await traced(statement, async () => {
          const stream = await sql.unsafe(statement)[direction]()
          const closed = once(stream, 'close')
          stream.destroy()
          await closed
        })
      }
    })

    it('traces reserved and transaction queries with their original resources', async () => {
      const reserved = await sql.reserve()
      try {
        const result = await traced('SELECT 11 AS reserved', () => reserved`SELECT 11 AS reserved`)
        assert.strictEqual(result[0].reserved, 11)
      } finally {
        await reserved.release()
      }
      const result = await traced('SELECT 12 AS transaction', () => sql.begin(tx => tx`SELECT 12 AS transaction`))
      assert.strictEqual(result[0].transaction, 12)
    })

    it('keeps an automatic COMMIT behind an open cursor', async () => {
      let release
      let ready
      let first = true
      const gate = new Promise(resolve => { release = resolve })
      const entered = new Promise(resolve => { ready = resolve })
      const channel = dc.channel('tracing:postgres:query:start')
      const observe = ctx => {
        if (ctx.query === 'commit') queueMicrotask(release)
      }
      channel.subscribe(observe)
      try {
        let cursor
        const transaction = sql.begin(async tx => {
          cursor = tx`SELECT generate_series(1, 3) AS value`.cursor(1, async () => {
            if (first) {
              first = false
              ready()
              await gate
            }
          }).execute()
          await entered
        })
        const cursorDone = async () => {
          await entered
          await cursor
        }
        await traced('commit', () => Promise.all([transaction, cursorDone()]))
      } finally {
        release()
        channel.unsubscribe(observe)
      }
    })

    for (const mode of ['disabled', 'service', 'full']) {
      it(`preserves cursor completion before COMMIT in ${mode} mode`, async () => {
        tracer.use('postgres', { dbmPropagationMode: mode })
        const variants = ['simple', 'prepared', 'unprepared']
        if (sql.batch) variants.push('batch')
        for (const variant of variants) {
          const reserved = await sql.reserve()
          let release
          let ready
          const gate = new Promise(resolve => { release = resolve })
          const entered = new Promise(resolve => { ready = resolve })
          const values = []
          const writes = []
          sql.options.debug = (connection, text) => {
            if (text.includes('commit')) {
              assert.strictEqual(text.includes('dddbs='), mode !== 'disabled')
              writes.push(values.length)
            }
          }
          const channel = dc.channel('tracing:orchestrion:postgres:query:prepare:start')
          const observe = () => queueMicrotask(release)
          try {
            await reserved.unsafe('begin')
            const cursor = reserved`SELECT generate_series(1, 3) AS value`.cursor(1, async rows => {
              values.push(rows[0].value)
              if (values.length === 1) {
                ready()
                await gate
              }
            }).execute()
            const commit = async () => {
              await entered
              const options = { simple: variant === 'simple', prepare: variant !== 'unprepared' }
              const query = reserved.unsafe('commit', [], options)
              channel.subscribe(observe)
              const ending = (variant === 'batch' ? reserved.batch([query]) : query).execute()
              await ending
            }
            await traced('commit', () => Promise.all([cursor, commit()]))
            assert.deepStrictEqual(writes, [3])
            assert.deepStrictEqual(values, [1, 2, 3])
          } finally {
            release()
            channel.unsubscribe(observe)
            sql.options.debug = undefined
            await reserved.release()
          }
        }
      })
    }

    it('traces a batch once and propagates comments to each statement', async function () {
      if (!sql.batch) {
        // sql.batch was added in Postgres.js 4.1.
        this.skip()
      }
      for (const mode of ['disabled', 'service', 'full']) {
        tracer.use('postgres', { dbmPropagationMode: mode, service: 'native-postgres' })
        const first = sql`SELECT current_query() AS first`
        const second = sql.unsafe('SELECT current_query() AS second')
        const result = await traced('SELECT current_query() AS first; SELECT current_query() AS second',
          () => sql.batch([first, second]))
        assert.strictEqual(result[0][0].first.includes("dddbs='native-postgres'"), mode !== 'disabled')
        assert.strictEqual(result[0][0].first.includes('traceparent='), false)
        assert.strictEqual(result[1][0].second.includes('traceparent='), mode === 'full')
        assert.strictEqual(first.text, 'SELECT current_query() AS first')
        assert.strictEqual(second.text, 'SELECT current_query() AS second')
      }
      const empty = await traced('postgres.query', () => sql.batch([]))
      assert.deepStrictEqual(empty, [])
      await traced('postgres.query', () => assert.rejects(sql.batch([sql`SELECT ${undefined}`]),
        { message: /Undefined values are not allowed/ }), span => assert.strictEqual(span.error, 1))
    })

    it('does not trace unused queries or queries executed while disabled', async () => {
      sql`SELECT 13 AS unused`
      tracer.use('postgres', { enabled: false })
      assert.strictEqual((await sql`SELECT 14 AS disabled`)[0].disabled, 14)
      const absent = agent.assertNoTraces(() => assert.fail('disabled or unused query was traced'), {
        spanResourceMatch: /SELECT 1[34] AS (?:unused|disabled)/, timeoutMs: 200,
      })
      tracer.use('postgres', {})
      await Promise.all([traced('SELECT 15 AS enabled', () => sql`SELECT 15 AS enabled`), absent])
    })

    it('ignores completion when enabled after another subscriber observes the start', async () => {
      tracer.use('postgres', { enabled: false })
      let starts = 0
      const observe = () => { starts++ }
      const channel = dc.channel('tracing:postgres:query:start')
      channel.subscribe(observe)
      const late = postgres({
        database: 'postgres',
        host: '127.0.0.1',
        max: 1,
        password: 'postgres',
        port: 5432,
        user: 'postgres',
        debug: () => tracer.use('postgres', {}),
      })
      try {
        assert.strictEqual((await late`SELECT 17 AS late_enabled`)[0].late_enabled, 17)
        await agent.assertNoTraces(() => assert.fail('completion created a span without its start'), {
          spanResourceMatch: /^SELECT 17 AS late_enabled$/, timeoutMs: 200,
        })
        assert.strictEqual(starts, 1)
      } finally {
        channel.unsubscribe(observe)
        await late.end({ timeout: 0 })
      }
    })
  })
})
