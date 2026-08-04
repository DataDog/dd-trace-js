'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const path = require('node:path')

const semver = require('semver')

const ddpv = require('mocha/package.json').version
const { ERROR_MESSAGE, ERROR_STACK, ERROR_TYPE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectedSchema, rawExpectedSchema } = require('./naming')

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
 * @param {() => PromiseLike<unknown>} run
 */
async function assertQuerySpan (resource, run) {
  const spanPromise = agent.assertFirstTraceSpan({ resource }, { spanResourceMatch: resourcePattern(resource) })
  const [result] = await Promise.all([run(), spanPromise])
  return result
}

/**
 * @param {string} resource
 */
function resourcePattern (resource) {
  return new RegExp(`^${resource.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
}

/**
 * @param {PromiseLike<unknown>} query
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

      it('starts the span when a lazy query executes', async () => {
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

      it('does not add correlation fields to Query objects', async () => {
        const query = sql`SELECT 1 AS value`

        assert.strictEqual(
          Reflect.ownKeys(query).some(key => typeof key === 'symbol' && String(key).includes('ddTrace')),
          false
        )

        await assertQuerySpan('SELECT 1 AS value', () => query)
      })

      it('uses the final query strings and options after user mutation', async () => {
        const query = sql.unsafe('SELECT 1 AS value')
        query.strings[0] = 'SELECT 2 AS value'
        query.options = { prepare: false, simple: true }

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

      it('handles query modifiers that mutate execution and result options', async () => {
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

      it('finishes callback and async-iterator cursors once', async () => {
        const callbackRows = []
        await assertQuerySpan(
          'SELECT generate_series(1, 2) AS value',
          () => sql`SELECT generate_series(1, 2) AS value`.cursor(1, rows => callbackRows.push(...rows))
        )
        assert.strictEqual(callbackRows.length, 2)

        const iteratorRows = []
        await assertQuerySpan('SELECT generate_series(1, 2) AS value', async () => {
          for await (const rows of sql`SELECT generate_series(1, 2) AS value`.cursor(1)) {
            iteratorRows.push(...rows)
          }
        })
        assert.strictEqual(iteratorRows.length, 2)
      })

      it('reports errors through an async-iterator cursor replacement', async () => {
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
        const readable = await assertQuerySpan(
          'COPY (SELECT 1 AS value) TO STDOUT',
          () => sql.unsafe('COPY (SELECT 1 AS value) TO STDOUT').readable()
        )
        let output = ''
        for await (const chunk of readable) {
          output += chunk
        }
        assert.strictEqual(output, '1\n')

        await sql.unsafe('CREATE TEMP TABLE dd_trace_postgres_copy (value int)')
        const writable = await assertQuerySpan(
          'COPY dd_trace_postgres_copy (value) FROM STDIN',
          () => sql.unsafe('COPY dd_trace_postgres_copy (value) FROM STDIN').writable()
        )
        const finished = once(writable, 'finish')
        writable.end('1\n2\n')
        await finished

        const result = await assertQuerySpan(
          'SELECT sum(value)::int AS value FROM dd_trace_postgres_copy',
          () => sql.unsafe('SELECT sum(value)::int AS value FROM dd_trace_postgres_copy')
        )
        assert.strictEqual(result[0].value, 3)
      })

      it('instruments file queries and preserves pre-execution file errors', async () => {
        const result = await assertQuerySpan(
          'SELECT $1::text AS message\n',
          () => sql.file(path.join(__dirname, 'fixtures', 'select.sql'), ['file'])
        )
        assert.strictEqual(result[0].message, 'file')

        const missingFile = path.join(__dirname, 'fixtures', 'missing.sql')

        await assert.rejects(sql.file(missingFile), { code: 'ENOENT' })
      })

      it('reports SQL and pre-build errors without leaking spans', async () => {
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
        await sql`SELECT ${1}::int AS value`
        await sql.unsafe('DISCARD ALL')

        const result = await assertQuerySpan('SELECT $1::int AS value', () => sql`SELECT ${2}::int AS value`)
        assert.strictEqual(result[0].value, 2)
      })

      it('finishes active and queued cancellations with their errors', async () => {
        let startedFirst
        const firstStarted = new Promise(resolve => { startedFirst = resolve })
        const first = sql.unsafe('SELECT pg_sleep(10)', [], {
          onexecute: () => {
            startedFirst()
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
        await queuedRejection
        await queuedSpanPromise

        await first.cancel()
        await Promise.all([firstRejection, firstSpanPromise])
      })

      it('reports handler errors before a connection can execute the query', async () => {
        await sql.end({ timeout: 0 })

        const spanPromise = agent.assertFirstTraceSpan(span => {
          assert.strictEqual(span.resource, 'SELECT 1 AS value')
          assert.strictEqual(span.meta[ERROR_TYPE], 'Error')
          assert.strictEqual(span.meta[ERROR_MESSAGE], 'write CONNECTION_ENDED 127.0.0.1:5432')
        }, { spanResourceMatch: /^SELECT 1 AS value$/ })

        await assert.rejects(sql.unsafe('SELECT 1 AS value'), { code: 'CONNECTION_ENDED' })
        await spanPromise
      })

      it('instruments transaction and reserved-connection handlers', async () => {
        const transactionSpanPromise = agent.assertFirstTraceSpan(
          { resource: 'SELECT 42 AS value' },
          { spanResourceMatch: /^SELECT 42 AS value$/ }
        )
        const transactionResult = await sql.begin(transaction => transaction`SELECT 42 AS value`)

        assert.strictEqual(transactionResult[0].value, 42)
        await transactionSpanPromise

        if (typeof sql.reserve === 'function') {
          const reserved = await sql.reserve()
          try {
            const reservedResult = await assertQuerySpan('SELECT 43 AS value', () => reserved`SELECT 43 AS value`)
            assert.strictEqual(reservedResult[0].value, 43)
          } finally {
            reserved.release()
          }
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

      it('supports service functions with parsed connection options', async () => {
        let connectionOptions
        tracer.use('postgres', {
          service: options => {
            connectionOptions = options
            return 'custom-postgres'
          },
        })
        const spanPromise = agent.assertFirstTraceSpan({ service: 'custom-postgres' })

        await sql`SELECT 1 AS value`
        await spanPromise

        assert.deepStrictEqual(connectionOptions.host, ['127.0.0.1'])
        assert.deepStrictEqual(connectionOptions.port, [5432])
        assert.strictEqual(connectionOptions.database, 'postgres')
        assert.strictEqual(connectionOptions.user, 'postgres')
      })

      it('injects service DBM tags without changing the span resource', async () => {
        tracer.use('postgres', { dbmPropagationMode: 'service', service: 'serviced' })
        const query = sql`SELECT ${'service'}::text AS message`

        const result = await assertQuerySpan('SELECT $1::text AS message', () => query)

        assert.strictEqual(result[0].message, 'service')
        assert.strictEqual(
          query.string,
          '/*dddb=\'postgres\',dddbs=\'serviced\',dde=\'tester\',ddh=\'127.0.0.1\',ddps=\'test\',' +
            `ddpv='${ddpv}'*/ SELECT $1::text AS message`
        )
      })

      it('appends service DBM tags on the wire without changing the span resource', async () => {
        tracer.use('postgres', { appendComment: true, dbmPropagationMode: 'service', service: 'serviced' })
        const query = sql.unsafe('SELECT current_query() AS query')

        const result = await assertQuerySpan('SELECT current_query() AS query', () => query)

        assert.match(result[0].query, /^SELECT current_query\(\) AS query \/\*dddb='postgres',dddbs='serviced'/)
        assert.strictEqual(result[0].query, query.string)
      })

      it('preserves DBM propagation when simple-query strings are frozen', async () => {
        tracer.use('postgres', { dbmPropagationMode: 'service', service: 'serviced' })
        const query = sql.unsafe('SELECT current_query() AS query')
        query.strings = Object.freeze(query.strings)

        const result = await assertQuerySpan('SELECT current_query() AS query', () => query)

        assert.match(result[0].query, /^\/\*dddb='postgres',dddbs='serviced'/)
      })

      it('injects service DBM tags into tagged simple-protocol queries', async () => {
        tracer.use('postgres', { dbmPropagationMode: 'service', service: 'serviced' })
        const query = sql`COPY (SELECT current_query()) TO STDOUT`
        const readable = await assertQuerySpan('COPY (SELECT current_query()) TO STDOUT', () => query.readable())
        let output = ''

        for await (const chunk of readable) {
          output += chunk
        }

        assert.match(output, /^\/\*dddb='postgres',dddbs='serviced'.*COPY \(SELECT current_query\(\)\) TO STDOUT/)
      })

      it('injects a full DBM trace only for unprepared queries', async () => {
        tracer.use('postgres', { dbmPropagationMode: 'full', service: 'serviced' })
        const unprepared = sql.unsafe('SELECT $1::text AS message', ['full'], { prepare: false })
        const unpreparedSpanPromise = agent.assertFirstTraceSpan(span => {
          assert.strictEqual(span.resource, 'SELECT $1::text AS message')
          assert.strictEqual(span.meta['_dd.dbm_trace_injected'], 'true')
        }, { spanResourceMatch: /^SELECT \$1::text AS message$/ })

        await unprepared
        await unpreparedSpanPromise
        assert.match(unprepared.string, /traceparent='00-[0-9a-f]{32}-[0-9a-f]{16}-01'/)

        const prepared = sql`SELECT ${'prepared'}::text AS message`
        const preparedSpanPromise = agent.assertFirstTraceSpan(span => {
          assert.strictEqual(span.resource, 'SELECT $1::text AS message')
          assert.strictEqual(span.meta['_dd.dbm_trace_injected'], undefined)
        }, { spanResourceMatch: /^SELECT \$1::text AS message$/ })

        await prepared
        await preparedSpanPromise
        assert.doesNotMatch(prepared.string, /traceparent=/)
      })
    })
  })
})
