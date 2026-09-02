'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const path = require('node:path')

const dc = require('dc-polyfill')
const semver = require('semver')

const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectedSchema, rawExpectedSchema } = require('./naming')

const postgresStartChannel = dc.channel('tracing:orchestrion:postgres:query:start')

const POSTGRES_TARGET = {
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  password: 'postgres',
  database: 'postgres',
  max: 1,
}

/**
 * @param {string} resource
 */
function resourcePattern (resource) {
  return new RegExp(`^${resource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
}

/**
 * @param {string} resource
 * @returns {Promise<void>}
 */
function assertNoQuerySpan (resource) {
  return agent.assertNoTraces(() => {
    assert.fail(`query was traced: ${resource}`)
  }, {
    spanResourceMatch: resourcePattern(resource),
    timeoutMs: 200,
  })
}

/**
 * @param {string} allowedResource
 * @returns {Promise<void>}
 */
function assertNoOtherQuerySpans (allowedResource) {
  return agent.assertNoTraces(traces => {
    const span = traces.flat().find(span =>
      span.meta.component === 'postgres' && span.resource !== allowedResource
    )
    if (span !== undefined) {
      assert.fail(`unexpected query span: ${span.resource}`)
    }
  }, { timeoutMs: 200 })
}

/**
 * @template T
 * @param {string} resource
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
async function assertQuerySpan (resource, run) {
  const spanPromise = agent.assertSomeTraces(traces => {
    const spans = traces.flat().filter(span => span.meta.component === 'postgres' && span.resource === resource)
    assert.strictEqual(spans.length, 1)
  }, { spanResourceMatch: resourcePattern(resource) })
  const [result] = await Promise.all([run(), spanPromise])
  return result
}

/**
 * @template T
 * @param {Promise<T>} query
 * @returns {Promise<T>}
 */
function executeQuery (query) {
  return new Promise((resolve, reject) => query.then(resolve, reject))
}

describe('Plugin', () => {
  describe('postgres', () => {
    withVersions('postgres', 'postgres', version => {
      let postgres
      let resolvedVersion
      let sql
      let tracer

      before(() => agent.load('postgres'))

      beforeEach(() => {
        const postgresModule = require(`../../../versions/postgres@${version}`)
        postgres = postgresModule.get()
        resolvedVersion = postgresModule.version()
        sql = postgres(POSTGRES_TARGET)
        tracer = require('../../dd-trace')
        tracer.use('postgres', {})
      })

      afterEach(() => sql.end({ timeout: 0 }))

      after(() => agent.close())

      withPeerService(
        () => tracer,
        'postgres',
        () => executeQuery(sql`SELECT 1 AS value`),
        'postgres',
        'db.name',
        { resource: 'SELECT 1 AS value' }
      )

      withNamingSchema(
        () => sql`SELECT 1 AS value`,
        rawExpectedSchema.outbound
      )

      it('instruments tagged queries without changing their result', async () => {
        const spanPromise = agent.assertFirstTraceSpan({
          name: expectedSchema.outbound.opName,
          service: expectedSchema.outbound.serviceName,
          resource: 'SELECT $1::text AS message',
          type: 'sql',
          meta: {
            component: 'postgres',
            'span.kind': 'client',
            'db.type': 'postgres',
            'db.name': 'postgres',
            'db.user': 'postgres',
            'out.host': '127.0.0.1',
          },
          metrics: {
            'network.destination.port': 5432,
          },
        })

        const result = await sql`SELECT ${'Hello world!'}::text AS message`

        assert.strictEqual(result[0].message, 'Hello world!')
        await spanPromise
      })

      it('does not trace connection bootstrap queries', async () => {
        const noTracePromise = assertNoOtherQuerySpans('SELECT 1 AS value')

        await assertQuerySpan('SELECT 1 AS value', () => sql`SELECT 1 AS value`)
        await noTracePromise
      })

      it('does not trace an unexecuted lazy query', async () => {
        sql`SELECT 2 AS value`
        await assertNoQuerySpan('SELECT 2 AS value')
      })

      it('does not trace a query cancelled before dispatch', async () => {
        const cancelledSql = postgres(POSTGRES_TARGET)
        const query = cancelledSql`SELECT 2 AS value`
        const rejection = Promise.prototype.then.call(query)
        const noTracePromise = assertNoQuerySpan('SELECT 2 AS value')
        let starts = 0
        const onStart = ctx => {
          if (ctx.query === query) starts++
        }

        postgresStartChannel.subscribe(onStart)

        try {
          query.cancel()
          await assert.rejects(rejection, { code: '57014', message: /canceling statement/ })

          assert.strictEqual(Reflect.apply(Reflect.get(query, 'execute'), query, []), query)
          await new Promise(setImmediate)
          await cancelledSql.end({ timeout: 0 })
        } finally {
          postgresStartChannel.unsubscribe(onStart)
        }

        assert.strictEqual(starts, 0)
        await noTracePromise
      })

      it('executes queued queries once without tracing while the plugin is disabled', async () => {
        await sql`CREATE TEMP TABLE dd_trace_postgres_disabled (value int)`

        tracer.use('postgres', { enabled: false })
        let markStarted
        const started = new Promise(resolve => { markStarted = resolve })
        const activeQuery = executeQuery(sql.unsafe('SELECT pg_sleep(0.05)', [], {
          onexecute: () => {
            markStarted()
            return true
          },
        }))
        await started

        const resource = 'INSERT INTO dd_trace_postgres_disabled VALUES (1)'
        const noTracePromise = assertNoQuerySpan(resource)
        await Promise.all([activeQuery, sql.unsafe(resource)])
        await noTracePromise

        tracer.use('postgres', {})
        const result = await sql`SELECT count(*)::int AS count FROM dd_trace_postgres_disabled`
        assert.strictEqual(result[0].count, 1)
      })

      it('uses the execution context of a lazy query', async () => {
        const query = sql`SELECT ${1}::int AS value`
        const tracesPromise = agent.assertSomeTraces(traces => {
          const spans = traces[0]
          const parent = spans.find(span => span.name === 'parent')
          const child = spans.find(span => span.resource === 'SELECT $1::int AS value')

          assert.ok(parent)
          assert.ok(child)
          assert.strictEqual(child.parent_id.toString(), parent.span_id.toString())
        })

        await tracer.trace('parent', () => executeQuery(query))
        await tracesPromise
      })

      it('preserves Query identity', async () => {
        const query = sql`SELECT 1 AS value`

        assert.ok(query instanceof Promise)
        assert.strictEqual(Reflect.apply(Reflect.get(query, 'execute'), query, []), query)

        await assertQuerySpan('SELECT 1 AS value', () => query)
      })

      it('uses the final query source after user mutation', async () => {
        const query = sql.unsafe('SELECT 1 AS value')
        Reflect.get(query, 'strings')[0] = 'SELECT 2 AS value'
        Reflect.set(query, 'options', { prepare: false, simple: true })

        const result = await assertQuerySpan('SELECT 2 AS value', () => query)

        assert.strictEqual(result[0].value, 2)
      })

      it('starts and finishes once when multiple Promise methods observe one query', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const spans = traces[0]
          const parent = spans.find(span => span.name === 'promise.parent')
          const children = spans.filter(span => span.resource === 'SELECT 1 AS value')

          assert.ok(parent)
          assert.strictEqual(children.length, 1)
          assert.strictEqual(children[0].parent_id.toString(), parent.span_id.toString())
        })

        await tracer.trace('promise.parent', () => {
          const query = sql`SELECT 1 AS value`
          return Promise.all([
            query.then(() => {}),
            query.catch(() => {}),
            query.finally(() => {}),
          ])
        })
        await tracesPromise
      })

      it('handles query execution and result modifiers', async () => {
        const unsafe = await assertQuerySpan(
          'SELECT $1::text AS message',
          () => sql.unsafe('SELECT $1::text AS message', ['unsafe'])
        )
        assert.strictEqual(unsafe[0].message, 'unsafe')

        const raw = await assertQuerySpan('SELECT 1 AS value', () => sql`SELECT 1 AS value`.raw())
        assert.ok(Buffer.isBuffer(raw[0][0]))

        const rows = []
        await assertQuerySpan('SELECT 1 AS value', () => sql`SELECT 1 AS value`.forEach(row => rows.push(row)))
        assert.strictEqual(rows[0].value, 1)

        const description = await assertQuerySpan(
          'SELECT $1::int AS value',
          () => sql`SELECT ${1}::int AS value`.describe()
        )
        assert.strictEqual(description.columns[0].name, 'value')

        if (semver.gte(resolvedVersion, '3.4.0')) {
          const simple = await assertQuerySpan('SELECT 1 AS value', () => sql`SELECT 1 AS value`.simple())
          assert.strictEqual(simple[0].value, 1)

          const values = await assertQuerySpan('SELECT 1 AS value', () => sql`SELECT 1 AS value`.values())
          assert.deepStrictEqual(values[0], [1])
        }

        const explicit = sql`SELECT 2 AS value`.execute()
        const explicitResult = await assertQuerySpan('SELECT 2 AS value', () => explicit)
        assert.strictEqual(explicitResult[0].value, 2)

        const notified = await assertQuerySpan(
          'select pg_notify($1, $2)',
          () => sql.notify('dd_trace_postgres', 'payload')
        )
        assert.ok(Array.isArray(notified))
      })

      it('finishes callback, multi-batch, and early-return cursors once', async () => {
        const callbackRows = []
        await assertQuerySpan(
          'SELECT generate_series(1, 3) AS value',
          () => sql`SELECT generate_series(1, 3) AS value`.cursor(1, rows => callbackRows.push(...rows))
        )
        assert.strictEqual(callbackRows.length, 3)

        const iteratorRows = []
        await assertQuerySpan('SELECT generate_series(1, 3) AS value', async () => {
          for await (const rows of sql`SELECT generate_series(1, 3) AS value`.cursor(1)) {
            iteratorRows.push(...rows)
          }
        })
        assert.strictEqual(iteratorRows.length, 3)

        const partialRows = []
        await assertQuerySpan('SELECT generate_series(1, 4) AS value', async () => {
          const iterator = sql`SELECT generate_series(1, 4) AS value`.cursor(1)[Symbol.asyncIterator]()
          const first = await iterator.next()
          partialRows.push(...first.value)
          await iterator.return()
        })
        assert.strictEqual(partialRows.length, 1)
      })

      it('reports errors after an async cursor replaces settlement functions', async () => {
        const spanPromise = agent.assertFirstTraceSpan(span => {
          assert.strictEqual(span.resource, 'INVALID CURSOR SQL')
          assert.strictEqual(span.meta[ERROR_TYPE], 'PostgresError')
          assert.match(span.meta[ERROR_MESSAGE], /syntax error/)
        }, { spanResourceMatch: /^INVALID CURSOR SQL$/ })

        await assert.rejects(async () => {
          for await (const rows of sql.unsafe('INVALID CURSOR SQL').cursor(1)) {
            assert.fail(`unexpected cursor rows: ${rows.length}`)
          }
        }, { name: 'PostgresError', message: /syntax error/ })
        await spanPromise
      })

      it('preserves COPY readable and writable streams', async () => {
        const readableResource = 'COPY (SELECT 1 AS value) TO STDOUT'
        const readableSpan = agent.assertFirstTraceSpan({ resource: readableResource }, {
          spanResourceMatch: resourcePattern(readableResource),
        })
        const readable = await sql.unsafe(readableResource).readable()
        let output = ''
        for await (const chunk of readable) {
          output += chunk
        }
        assert.strictEqual(output, '1\n')
        await readableSpan

        await assertQuerySpan(
          'CREATE TEMP TABLE dd_trace_postgres_copy (value int)',
          () => sql.unsafe('CREATE TEMP TABLE dd_trace_postgres_copy (value int)')
        )
        const writableResource = 'COPY dd_trace_postgres_copy (value) FROM STDIN'
        const writable = await sql.unsafe(writableResource).writable()
        await assertNoQuerySpan(writableResource)

        const writableSpan = agent.assertFirstTraceSpan({ resource: writableResource }, {
          spanResourceMatch: resourcePattern(writableResource),
        })
        const finished = once(writable, 'finish')
        writable.end('1\n2\n')
        await Promise.all([finished, writableSpan])

        const result = await assertQuerySpan(
          'SELECT sum(value)::int AS value FROM dd_trace_postgres_copy',
          () => sql.unsafe('SELECT sum(value)::int AS value FROM dd_trace_postgres_copy')
        )
        assert.strictEqual(result[0].value, 3)
      })

      it('reports COPY errors after the writable stream is acquired', async () => {
        await sql.unsafe('CREATE TEMP TABLE dd_trace_postgres_copy_error (value int)')

        const resource = 'COPY dd_trace_postgres_copy_error (value) FROM STDIN'
        const writable = await sql.unsafe(resource).writable()
        const spanPromise = agent.assertFirstTraceSpan(span => {
          assert.strictEqual(span.resource, resource)
          assert.strictEqual(span.meta[ERROR_TYPE], 'PostgresError')
          assert.match(span.meta[ERROR_MESSAGE], /invalid input syntax for (?:type )?integer/)
        }, { spanResourceMatch: resourcePattern(resource) })
        writable.once('error', () => {})

        writable.end('invalid\n')

        await spanPromise
        writable.destroy()
      })

      it('instruments file queries without tracing pre-dispatch file errors', async () => {
        const result = await assertQuerySpan(
          'SELECT $1::text AS message\n',
          () => sql.file(path.join(__dirname, 'fixtures', 'select.sql'), ['file'])
        )
        assert.strictEqual(result[0].message, 'file')

        const missingFile = path.join(__dirname, 'fixtures', 'missing.sql')
        const noTracePromise = assertNoOtherQuerySpans('SELECT 1 AS value')

        await assert.rejects(sql.file(missingFile), { code: 'ENOENT' })
        await assertQuerySpan('SELECT 1 AS value', () => sql`SELECT 1 AS value`)
        await noTracePromise
      })

      it('reports server and build errors without leaking spans', async () => {
        const sqlErrorSpanPromise = agent.assertFirstTraceSpan(span => {
          assert.strictEqual(span.resource, 'INVALID SQL')
          assert.match(span.meta[ERROR_MESSAGE], /syntax error/)
          assert.strictEqual(span.meta[ERROR_TYPE], 'PostgresError')
          assert.strictEqual(typeof span.meta[ERROR_STACK], 'string')
        })

        await assert.rejects(sql.unsafe('INVALID SQL'), { name: 'PostgresError', message: /syntax error/ })
        await sqlErrorSpanPromise

        const buildErrorSpanPromise = agent.assertFirstTraceSpan(span => {
          assert.strictEqual(span.name, expectedSchema.outbound.opName)
          assert.match(span.meta[ERROR_MESSAGE], /Undefined values are not allowed/)
        })

        await assert.rejects(sql`SELECT ${undefined}`, { message: /Undefined values are not allowed/ })
        await buildErrorSpanPromise
      })

      it('preserves one span when Postgres.js retries a prepared statement', async () => {
        await assertQuerySpan('SELECT $1::int AS value', () => sql`SELECT ${1}::int AS value`)
        await assertQuerySpan('DISCARD ALL', () => sql.unsafe('DISCARD ALL'))

        const result = await assertQuerySpan('SELECT $1::int AS value', () => sql`SELECT ${2}::int AS value`)
        assert.strictEqual(result[0].value, 2)
      })

      it('finishes active and queued cancellations with their original errors', async function () {
        let startFirst
        const firstStarted = new Promise(resolve => { startFirst = resolve })
        const first = sql.unsafe('SELECT pg_sleep(10)', [], {
          onexecute: () => {
            startFirst()
            return true
          },
        })
        const firstSpanPromise = agent.assertFirstTraceSpan(span => {
          assert.strictEqual(span.resource, 'SELECT pg_sleep(10)')
          assert.strictEqual(span.meta[ERROR_TYPE], 'PostgresError')
          assert.match(span.meta[ERROR_MESSAGE], /canceling statement/)
        }, { spanResourceMatch: /^SELECT pg_sleep\(10\)$/ })
        const firstRejection = assert.rejects(first, { code: '57014', message: /canceling statement/ })

        await firstStarted

        const queued = sql.unsafe('SELECT 2 AS value')
        const queuedSpanPromise = agent.assertFirstTraceSpan(span => {
          assert.strictEqual(span.resource, 'SELECT 2 AS value')
          assert.strictEqual(span.meta[ERROR_TYPE], 'Error')
          assert.match(span.meta[ERROR_MESSAGE], /canceling statement/)
        }, { spanResourceMatch: /^SELECT 2 AS value$/ })
        const queuedRejection = assert.rejects(queued, { code: '57014', message: /canceling statement/ })

        await new Promise(setImmediate)
        await queued.cancel()
        await Promise.all([queuedRejection, queuedSpanPromise])

        await first.cancel()
        await Promise.all([firstRejection, firstSpanPromise])
      }).timeout(10000)

      it('reports handler errors before a connection executes the query', async () => {
        await sql.end({ timeout: 0 })

        const spanPromise = agent.assertFirstTraceSpan(span => {
          assert.strictEqual(span.resource, 'SELECT 1 AS value')
          assert.strictEqual(span.meta[ERROR_TYPE], 'Error')
          assert.strictEqual(span.meta[ERROR_MESSAGE], 'write CONNECTION_ENDED 127.0.0.1:5432')
        }, { spanResourceMatch: /^SELECT 1 AS value$/ })

        await assert.rejects(sql.unsafe('SELECT 1 AS value'), { code: 'CONNECTION_ENDED' })
        await spanPromise

        const taggedSpanPromise = agent.assertFirstTraceSpan(span => {
          assert.strictEqual(span.resource, 'SELECT 2 AS value')
          assert.strictEqual(span.meta[ERROR_TYPE], 'Error')
          assert.strictEqual(span.meta[ERROR_MESSAGE], 'write CONNECTION_ENDED 127.0.0.1:5432')
        }, { spanResourceMatch: /^SELECT 2 AS value$/ })

        await assert.rejects(sql`SELECT 2 AS value`, { code: 'CONNECTION_ENDED' })
        await taggedSpanPromise
      })

      it('instruments transaction and reserved-connection handlers', async () => {
        const transactionSpanPromise = agent.assertFirstTraceSpan(
          { resource: 'SELECT 42 AS value' },
          { spanResourceMatch: /^SELECT 42 AS value$/ }
        )
        const transactionResult = await sql.begin(transaction => transaction`SELECT 42 AS value`)

        assert.strictEqual(transactionResult[0].value, 42)
        await transactionSpanPromise

        if (typeof sql.reserve !== 'function') return

        const reserved = await sql.reserve()
        try {
          const reservedResult = await assertQuerySpan('SELECT 43 AS value', () => reserved`SELECT 43 AS value`)
          assert.strictEqual(reservedResult[0].value, 43)
        } finally {
          reserved.release()
        }
      })

      it('keeps concurrent pipelined queries under their execution parent', async () => {
        const tracesPromise = agent.assertSomeTraces(traces => {
          const spans = traces[0]
          const parent = spans.find(span => span.name === 'pipeline.parent')
          const children = spans.filter(span => span.meta.component === 'postgres')

          assert.ok(parent)
          assert.strictEqual(children.length, 2)
          for (const child of children) {
            assert.strictEqual(child.parent_id.toString(), parent.span_id.toString())
          }
        })

        const result = await tracer.trace('pipeline.parent', () => Promise.all([
          sql`SELECT 1 AS value`,
          sql`SELECT 2 AS value`,
        ]))

        assert.strictEqual(result[0][0].value, 1)
        assert.strictEqual(result[1][0].value, 2)
        await tracesPromise
      })

      it('omits endpoint tags when Postgres.js can fail over between hosts', async () => {
        const multiHost = postgres({
          ...POSTGRES_TARGET,
          host: ['127.0.0.1', '127.0.0.2'],
          port: [5432, 5432],
        })
        const spanPromise = agent.assertFirstTraceSpan(span => {
          assert.strictEqual(span.meta['out.host'], undefined)
          assert.strictEqual(span.metrics['network.destination.port'], undefined)
        }, { spanResourceMatch: /^SELECT 1 AS value$/ })

        try {
          await multiHost`SELECT 1 AS value`
          await spanPromise
        } finally {
          await multiHost.end({ timeout: 0 })
        }
      })

      it('supports a configured service name', async () => {
        tracer.use('postgres', { service: 'custom-postgres' })
        const spanPromise = agent.assertFirstTraceSpan({ service: 'custom-postgres' })

        await sql`SELECT 1 AS value`
        await spanPromise
      })

      it('truncates the first resource beyond the configured boundary', async () => {
        tracer.use('postgres', { truncate: 12 })

        await assertQuerySpan('SELECT 12345', () => sql.unsafe('SELECT 12345'))

        const spanPromise = agent.assertFirstTraceSpan(
          { resource: 'SELECT 12...' },
          { spanResourceMatch: /^SELECT 12\.\.\.$/ }
        )
        await sql.unsafe('SELECT 123456')
        await spanPromise
      })
    })
  })
})
