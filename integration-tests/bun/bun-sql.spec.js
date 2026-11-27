'use strict'

const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const path = require('node:path')

const { BUN } = require('../helpers/bun')
const { FakeAgent, useSandbox, sandboxCwd } = require('../helpers')

/**
 * @param {Record<string, string>} env
 * @param {string} [filename]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runBun (env, filename = 'query.mjs') {
  return new Promise((resolve, reject) => {
    const cwd = sandboxCwd()
    const proc = spawn(BUN, [path.join(cwd, 'bun/bun-sql', filename)], {
      cwd,
      env: {
        ...process.env,
        DD_SERVICE: 'bun-sql-test',
        DD_TRACE_SPAN_ATTRIBUTE_SCHEMA: 'v0',
        DD_TRACE_REMOVE_INTEGRATION_SERVICE_NAMES_ENABLED: 'false',
        DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
        DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5432/postgres',
        ...env,
      },
      stdio: 'pipe',
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', data => { stdout += data })
    proc.stderr.on('data', data => { stderr += data })
    proc.once('error', reject)
    proc.once('exit', code => resolve({ code, stdout, stderr }))
  })
}

describe('Bun SQL', function () {
  this.timeout(30_000)
  useSandbox([])
  let agent

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    await agent?.stop()
  })

  it('does not load Bun SQL instrumentation or modify Bun globals under Node', () => {
    const result = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict')
      const SQL = function () {}
      globalThis.Bun = { SQL }
      require('dd-trace').init({ startupLogs: false })
      assert.equal(globalThis.Bun.SQL, SQL)
      assert.ok(!Object.keys(require.cache).some(file => file.endsWith('/src/bun-sql.js')))
    `], { cwd: sandboxCwd(), encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  })

  for (const failure of ['false', 'true', 'wrap']) {
    it(`discovers internals without network connections and safely handles discovery failure=${failure}`, async () => {
      const result = await runBun({ SQL_DISCOVERY_FAILURE: failure }, 'discovery.js')
      assert.equal(result.code, 0, result.stderr)
      assert.ok(result.stdout.includes('ok'))
    })
  }

  const cases = [
    ['tagged', {}, 2],
    ['unsafe', {}, 2],
    ['transaction', {}, 4],
    ['error', {}, 1],
    ['lifecycle', {}, 6],
    ['dbm', { DD_DBM_PROPAGATION_MODE: 'service' }, 1],
    ['dbm-full', { DD_DBM_PROPAGATION_MODE: 'full' }, 1],
    ['dbm-simple', { DD_DBM_PROPAGATION_MODE: 'full' }, 1],
    ['dbm-prepared', { DD_DBM_PROPAGATION_MODE: 'full' }, 1],
    ['disabled', { DD_TRACE_BUN_SQL_ENABLED: 'false' }, 0],
    ['disabled', { DD_TRACE_DISABLED_INSTRUMENTATIONS: 'bun-sql' }, 0],
    ['sqlite', { DD_DBM_PROPAGATION_MODE: 'full' }, 2],
    ['mysql', {}, 2],
    ['tagged', { DD_TRACE_SPAN_ATTRIBUTE_SCHEMA: 'v1' }, 2],
  ]

  for (const [mode, env, expectedCount] of cases) {
    it(`traces ${mode} queries with ${JSON.stringify(env)}`, async () => {
      const message = agent.assertMessageReceived(({ payload }) => {
        const spans = payload.flat()
        const parent = spans.find(span => span.name === 'bun.sql.parent')
        assert.ok(parent)
        const queries = spans.filter(span => span.meta.component === 'bun-sql')
        assert.equal(queries.length, expectedCount)
        const v1 = env.DD_TRACE_SPAN_ATTRIBUTE_SCHEMA === 'v1'
        for (const span of queries) {
          const system = span.meta['db.type']
          assert.equal(span.name, v1 ? 'postgresql.query' : 'bun-sql.query')
          assert.equal(span.service, v1 ? 'bun-sql-test' : `bun-sql-test-${system}`)
          assert.equal(span.type, 'sql')
          assert.equal(span.meta['span.kind'], 'client')
          assert.equal(span.parent_id.toString(), parent.span_id.toString())
          assert.equal(span.trace_id.toString(), parent.trace_id.toString())
          assert.doesNotMatch(span.resource, /dddbs=/)
          if (system === 'sqlite') {
            assert.equal(span.meta['db.name'], ':memory:')
            assert.equal(span.meta['_dd.dbm_trace_injected'], undefined)
          } else {
            assert.equal(span.meta['db.name'], system === 'mysql' ? 'db' : 'postgres')
            assert.equal(span.meta['db.user'], system === 'mysql' ? 'root' : 'postgres')
            assert.equal(span.meta['out.host'], '127.0.0.1')
            assert.equal(span.metrics['network.destination.port'], system === 'mysql' ? 3306 : 5432)
          }
        }
        if (mode === 'tagged') {
          assert.ok(queries.every(span => /^SELECT \$1\s+as n$/.test(span.resource)))
        }
        if (mode === 'error') {
          assert.equal(queries[0].error, 1)
          assert.equal(queries[0].meta['error.type'], 'PostgresError')
          assert.match(queries[0].meta['error.message'], /invalid_column/)
        }
        if (mode === 'dbm-full' || mode === 'dbm-simple') {
          assert.equal(queries[0].meta['_dd.dbm_trace_injected'], 'true')
        }
        if (mode === 'dbm-prepared') assert.equal(queries[0].meta['_dd.dbm_trace_injected'], undefined)
        if (mode === 'sqlite') assert.ok(queries.some(span => span.meta['db.type'] === 'sqlite'))
        if (mode === 'mysql') assert.ok(queries.some(span => span.meta['db.type'] === 'mysql'))
      })
      const [result] = await Promise.all([
        runBun({ SQL_TEST_MODE: mode, DD_TRACE_AGENT_URL: `http://127.0.0.1:${agent.port}`, ...env }).then(result => {
          assert.equal(result.code, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`)
          return result
        }),
        message,
      ])
      assert.equal(result.code, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`)
      assert.ok(result.stdout.includes('ok'))
    })
  }
})
