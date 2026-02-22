'use strict'

const assert = require('node:assert/strict')
const { execFileSync, execSync } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')

const { after, before, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const semifies = require('semifies')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const { storage } = require('../../datadog-core')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectedSchema } = require('./naming')

const {
  FALLBACK_DATABASE_URL,
  PRISMA_CLIENT_OUTPUT_RELATIVE,
  SCHEMA_FIXTURES,
  TEST_DATABASE_ENV_NAME,
  TEST_DATABASE_URL,
} = require('./prisma-fixtures')

function execPrismaGenerate (config, cwd) {
  if (config.ts) {
    const outDir = config.v7 ? '../v7/dist' : '../dist'
    execSync([
      './node_modules/.bin/prisma generate',
      [
        './node_modules/.bin/tsc ../generated/**/*.ts',
        `--outDir ${outDir}`,
        '--target esnext',
        '--module commonjs',
        '--allowJs true',
        '--moduleResolution node',
      ].join(' '),
    ].join(' && '), {
      cwd,
      stdio: 'inherit',
    })
  } else {
    execSync('./node_modules/.bin/prisma generate', {
      cwd,
      stdio: 'inherit',
    })
  }
}

function loadPrismaModule (config, range) {
  if (config.file.includes('generated')) {
    return require(config.file)
  }

  const file = config.file.replace('range', range)
  const prismaModule = require(file)
  return config.ts ? prismaModule : prismaModule.get()
}

function clearPrismaEnv () {
  delete process.env.PRISMA_CLIENT_OUTPUT
  delete process.env.DATABASE_URL
  delete process.env[TEST_DATABASE_ENV_NAME]
}

function setPrismaEnv (config) {
  process.env[TEST_DATABASE_ENV_NAME] = TEST_DATABASE_URL
  process.env.DATABASE_URL = FALLBACK_DATABASE_URL
  process.env.PRISMA_TEST_DATABASE_URL = TEST_DATABASE_URL
  if (config.usesGeneratedClientOutput) {
    process.env.PRISMA_CLIENT_OUTPUT = PRISMA_CLIENT_OUTPUT_RELATIVE
  }
}

async function copySchemaToVersionDir (schemaPath, range) {
  const cwd = path.resolve(__dirname, `../../../versions/@prisma/client@${range}`)
  await fs.cp(
    path.resolve(__dirname, schemaPath),
    path.join(cwd, 'schema.prisma')
  )
  return cwd
}

function createPrismaClient (prisma, config) {
  // With the introduction of v7 prisma now enforces the use of adapters
  if (config.v7) {
    const { PrismaPg } = require('@prisma/adapter-pg')
    const adapter = new PrismaPg({ connectionString: process.env[TEST_DATABASE_ENV_NAME] })
    return new prisma.PrismaClient({ adapter })
  }
  if (config.usesGeneratedClientOutput) {
    return new prisma.PrismaClient({ datasourceUrl: process.env[TEST_DATABASE_ENV_NAME] })
  }
  return new prisma.PrismaClient()
}

function createEngineDbQuerySpan (queryText) {
  return [{
    id: '1',
    parentId: null,
    name: 'prisma:engine:db_query',
    startTime: [1745340876, 436861000],
    endTime: [1745340876, 438601541],
    kind: 'client',
    attributes: {
      'db.system': 'postgresql',
      'db.query.text': queryText,
    },
  }]
}

describe('Plugin', () => {
  let prisma
  let prismaClient
  let tracingHelper

  describe('DatadogTracingHelper', () => {
    beforeEach(() => {
      storage('legacy').enterWith({})
    })

    function getHelperClass (spies = {}) {
      const channel = {
        tracePromise: spies.tracePromise || ((fn) => fn()),
        traceSync: spies.traceSync || ((fn) => fn()),
        start: { hasSubscribers: spies.hasSubscribers !== false },
      }

      return proxyquire.noPreserveCache()('../src/datadog-tracing-helper', {
        'dc-polyfill': {
          tracingChannel: () => channel,
        },
      })
    }

    it('getTraceParent should be optimistic when there is no active span', () => {
      const DatadogTracingHelper = getHelperClass()
      const helper = new DatadogTracingHelper(undefined, {})

      const traceparent = helper.getTraceParent()

      assert.strictEqual(
        traceparent,
        '00-00000000000000000000000000000000-0000000000000000-01'
      )
    })

    it('getTraceParent should use active span IDs and always set sampled flag', () => {
      const DatadogTracingHelper = getHelperClass()
      const helper = new DatadogTracingHelper(undefined, {})

      const span = {
        _spanContext: {
          _sampling: { priority: 0 },
          _traceparent: { version: 'ff' },
          toTraceId: () => '00000000000000000000000000000001',
          toSpanId: () => '0000000000000001',
        },
      }

      storage('legacy').enterWith({ span })

      const traceparentWithExplicitNotSampledPriority = helper.getTraceParent()
      assert.strictEqual(
        traceparentWithExplicitNotSampledPriority,
        'ff-00000000000000000000000000000001-0000000000000001-01'
      )

      span._spanContext._sampling.priority = undefined

      const traceparentWithUndefinedPriority = helper.getTraceParent()
      assert.strictEqual(
        traceparentWithUndefinedPriority,
        'ff-00000000000000000000000000000001-0000000000000001-01'
      )
    })

    it('getActiveContext should return the active span context', () => {
      const DatadogTracingHelper = getHelperClass()
      const helper = new DatadogTracingHelper(undefined, {})

      const spanContext = { hello: 'world' }
      storage('legacy').enterWith({ span: { _spanContext: spanContext } })

      assert.strictEqual(helper.getActiveContext(), spanContext)
    })

    it('dispatchEngineSpans should only start root spans (parentId === null)', () => {
      const DatadogTracingHelper = getHelperClass()
      /** @type {Array<{ engineSpan: { id: string }, dbConfig: { database?: string } }>} */
      const started = []

      const prismaClient = {
        startEngineSpan: (ctx) => started.push(ctx),
      }
      const helper = new DatadogTracingHelper({ database: 'db' }, prismaClient)

      helper.dispatchEngineSpans([
        { id: '1', parentId: null, name: 'prisma:engine:query' },
        { id: '2', parentId: '1', name: 'prisma:engine:db_query' },
        { id: '3', parentId: null, name: 'prisma:engine:connect' },
      ])

      assert.strictEqual(started.length, 2)
      assert.strictEqual(started[0].engineSpan.id, '1')
      assert.strictEqual(started[1].engineSpan.id, '3')
      assert.strictEqual(started[0].dbConfig.database, 'db')
    })

    it('dispatchEngineSpans should ignore empty span arrays', () => {
      const DatadogTracingHelper = getHelperClass()
      /** @type {Array<unknown>} */
      const started = []

      const prismaClient = {
        startEngineSpan: (ctx) => started.push(ctx),
      }
      const helper = new DatadogTracingHelper({ database: 'db' }, prismaClient)

      helper.dispatchEngineSpans([])

      assert.strictEqual(started.length, 0)
    })

    it('runInChildSpan should use tracePromise for allowed non-serialize operations', () => {
      /** @type {Array<{ type: string, ctx?: { resourceName?: string, attributes?: Record<string, unknown> } }>} */
      const calls = []
      const DatadogTracingHelper = getHelperClass({
        tracePromise: (fn, ctx) => {
          calls.push({ type: 'promise', ctx })
          return fn()
        },
        traceSync: () => {
          calls.push({ type: 'sync' })
        },
      })

      const helper = new DatadogTracingHelper(undefined, {})
      const result = helper.runInChildSpan(
        { name: 'operation', attributes: { method: 'findMany', model: 'users' } },
        () => 'ok'
      )

      assert.strictEqual(result, 'ok')
      assert.strictEqual(calls.length, 1)
      assertObjectContains(calls[0], {
        ctx: {
          resourceName: 'operation',
          attributes: { method: 'findMany', model: 'users' },
        },
        type: 'promise',
      })
    })

    it('runInChildSpan should use traceSync for serialize', () => {
      /** @type {Array<{ type: string, ctx?: { resourceName?: string } }>} */
      const calls = []
      const DatadogTracingHelper = getHelperClass({
        tracePromise: () => { calls.push({ type: 'promise' }) },
        traceSync: (fn, ctx) => {
          calls.push({ type: 'sync', ctx })
          return fn()
        },
      })

      const helper = new DatadogTracingHelper(undefined, {})
      const result = helper.runInChildSpan(
        { name: 'serialize', attributes: { name: 'test' } },
        () => 'ok'
      )

      assert.strictEqual(result, 'ok')
      assert.strictEqual(calls.length, 1)
      assert.strictEqual(calls[0].type, 'sync')
      assert.strictEqual(calls[0].ctx.resourceName, 'serialize')
    })

    it('runInChildSpan should bypass tracing when there are no subscribers', () => {
      /** @type {Array<{ type: string }>} */
      const calls = []
      const DatadogTracingHelper = getHelperClass({
        hasSubscribers: false,
        tracePromise: () => { calls.push({ type: 'promise' }) },
        traceSync: () => { calls.push({ type: 'sync' }) },
      })

      const helper = new DatadogTracingHelper(undefined, {})
      const result = helper.runInChildSpan({ name: 'operation' }, () => 'ok')

      assert.strictEqual(result, 'ok')
      assert.strictEqual(calls.length, 0)
    })

    it('runInChildSpan should bypass tracing when operation is not in the allowlist', () => {
      /** @type {Array<{ type: string }>} */
      const calls = []
      const DatadogTracingHelper = getHelperClass({
        tracePromise: () => { calls.push({ type: 'promise' }) },
        traceSync: () => { calls.push({ type: 'sync' }) },
      })

      const helper = new DatadogTracingHelper(undefined, {})
      const result = helper.runInChildSpan({ name: 'query' }, () => 'ok')

      assert.strictEqual(result, 'ok')
      assert.strictEqual(calls.length, 0)
    })
  })

  describe('prisma', () => {
    const prismaClients = [{
      schema: `./${SCHEMA_FIXTURES.clientOutputJs}`,
      file: '../../../versions/@prisma/generated/prisma',
      usesGeneratedClientOutput: true,
    },
    {
      schema: `./${SCHEMA_FIXTURES.clientJs}`,
      file: '../../../versions/@prisma/client@range',
    },
    {
      schema: `./${SCHEMA_FIXTURES.tsCjsV6}`,
      file: '../../../versions/@prisma/dist/client.js',
      usesGeneratedClientOutput: true,
      ts: true,
    },
    {
      schema: `./${SCHEMA_FIXTURES.tsCjsV7}`,
      file: '../../../versions/@prisma/v7/dist/client.js',
      usesGeneratedClientOutput: true,
      ts: true,
      v7: true,
    }]

    prismaClients.forEach(config => {
      // Prisma 7.0.0+ is not supported in Node.js < 20.19.0
      if (config.v7 && !semifies(process.version.slice(1), '>=20.19.0')) return

      let supportedRange = config.v7 ? '>=7.0.0' : '<7.0.0'
      // prisma-generator is only available starting prisma >= 6.16.0
      if (config.ts && supportedRange === '<7.0.0') {
        supportedRange = '>=6.16.0 <7.0.0'
      }
      withVersions('prisma', ['@prisma/client'], supportedRange, async (range, _moduleName_, version) => {
        describe(`without configuration ${config.schema}`, () => {
          before(async function () {
            this.timeout(10000)
            clearPrismaEnv()
            setPrismaEnv(config)

            const cwd = await copySchemaToVersionDir(config.schema, range)

            await agent.load(['prisma', 'pg'])
            execPrismaGenerate(config, cwd)
            prisma = loadPrismaModule(config, range)

            prismaClient = createPrismaClient(prisma, config)

            tracingHelper = prismaClient._tracingHelper

            if (!tracingHelper) {
              throw new Error('Prisma tracing helper was not initialized')
            }
          })

          after(() => {
            return agent.close({ ritmReset: false })
          })

          it('should do automatic instrumentation', async () => {
            const tracingPromise = agent.assertSomeTraces(traces => {
              assertObjectContains(traces, [[{
                resource: 'queryRaw',
                meta: {
                  'prisma.type': 'client',
                  'prisma.method': 'queryRaw',
                },
                name: expectedSchema.client.opName,
                service: expectedSchema.client.serviceName,
              },
              {
                resource: 'SELECT 1',
                type: 'sql',
                meta: {
                  'span.kind': 'client',
                },
                name: config.v7 ? 'pg.query' : expectedSchema.engine.opName,
                service: config.v7 ? 'test-postgres' : expectedSchema.engine.serviceName,
              }]])
            })

            await Promise.all([
              prismaClient.$queryRaw`SELECT 1`,
              tracingPromise,
            ])
          })

          it('should handle errors', async () => {
            let error
            const tracingPromise = agent.assertFirstTraceSpan((trace) => {
              assertObjectContains(trace, {
                meta: {
                  [ERROR_TYPE]: error.name,
                  [ERROR_MESSAGE]: error.message,
                  [ERROR_STACK]: error.stack,
                },
              })
            })
            await Promise.all([
              // This will throw an error because no data object is provided
              prismaClient.User.create({}).catch(e => {
                error = e
              }),
              tracingPromise,
            ])
          })

          it('should create client spans from callback', async () => {
            const tracingPromise = agent.assertFirstTraceSpan({
              name: 'prisma.client',
              resource: 'users.findMany',
              meta: {
                'prisma.type': 'client',
                'prisma.method': 'findMany',
                'prisma.model': 'users',
              },
            })

            tracingHelper.runInChildSpan(
              {
                name: 'operation',
                attributes: { method: 'findMany', model: 'users' },
              },
              () => {
                return 'Test Function'
              }
            )

            await Promise.all([
              tracingPromise,
            ])
          })

          it('should generate engine span from array of spans', async () => {
            const tracingPromise = agent.assertSomeTraces(traces => {
              assert.strictEqual(traces[0].length, 2)
              assert.strictEqual(traces[0][0].span_id, traces[0][1].parent_id)
              assert.strictEqual(traces[0][0].name, 'prisma.engine')
              assert.strictEqual(traces[0][0].resource, 'query')
              assert.strictEqual(traces[0][0].meta['prisma.type'], 'engine')
              assert.strictEqual(traces[0][0].meta['prisma.name'], 'query')
              assert.strictEqual(traces[0][1].name, 'prisma.engine')
              assert.strictEqual(traces[0][1].resource, 'SELECT 1')
              assert.strictEqual(traces[0][1].type, 'sql')
              assert.strictEqual(traces[0][1].meta['prisma.type'], 'engine')
              assert.strictEqual(traces[0][1].meta['prisma.name'], 'db_query')
              assert.strictEqual(traces[0][1].meta['db.type'], 'postgres')
            })

            const engineSpans = [
              {
                id: '1',
                parentId: null,
                name: 'prisma:engine:query',
                startTime: [1745340876, 436692000],
                endTime: [1745340876, 438653250],
                kind: 'internal',
              },
              {
                id: '2',
                parentId: '1',
                name: 'prisma:engine:db_query',
                startTime: [1745340876, 436861000],
                endTime: [1745340876, 438601541],
                kind: 'client',
                attributes: {
                  'db.system': 'postgresql',
                  'db.query.text': 'SELECT 1',
                },
              },
            ]
            tracingHelper.dispatchEngineSpans(engineSpans)
            await Promise.all([
              tracingPromise,
            ])
          })

          it('should include database connection attributes in db_query spans', async () => {
            // Set up database config that should be parsed from connection URL

            const tracingPromise = agent.assertSomeTraces(traces => {
              // Find the db_query span
              const dbQuerySpan = traces[0].find(span => span.meta['prisma.name'] === 'db_query')
              // Verify database connection attributes are present
              assertObjectContains(dbQuerySpan, {
                meta: {
                  'db.name': 'postgres',
                  'db.user': 'postgres',
                  'out.host': 'localhost',
                  'network.destination.port': '5432',
                  'db.type': 'postgres',
                },
              })
            })

            const engineSpans = [
              ...createEngineDbQuerySpan('SELECT 1'),
            ]
            tracingHelper.dispatchEngineSpans(engineSpans)
            await Promise.all([
              tracingPromise,
            ])
          })

          if (config.v7) {
            it('should tag db_query spans with the active client adapter metadata in read-replica setups', async () => {
              const initialDbUrl = process.env[TEST_DATABASE_ENV_NAME]
              process.env[TEST_DATABASE_ENV_NAME] =
                'postgres://postgres:postgres@primary.db.internal:5432/postgres'
              const primaryClient = createPrismaClient(prisma, config)

              process.env[TEST_DATABASE_ENV_NAME] =
                'postgres://postgres:postgres@replica.db.internal:5433/postgres'
              const replicaClient = createPrismaClient(prisma, config)

              if (initialDbUrl === undefined) {
                delete process.env[TEST_DATABASE_ENV_NAME]
              } else {
                process.env[TEST_DATABASE_ENV_NAME] = initialDbUrl
              }

              assert.ok(primaryClient._tracingHelper)
              assert.ok(replicaClient._tracingHelper)

              const replicaReadTrace = agent.assertSomeTraces(traces => {
                const dbQuerySpan = traces[0].find(span => span.meta['prisma.name'] === 'db_query')
                assertObjectContains(dbQuerySpan, {
                  resource: 'SELECT 1',
                  meta: {
                    'out.host': 'replica.db.internal',
                    'network.destination.port': '5433',
                  },
                })
              })
              replicaClient._tracingHelper.dispatchEngineSpans(createEngineDbQuerySpan('SELECT 1'))
              await replicaReadTrace

              const primaryWriteTrace = agent.assertSomeTraces(traces => {
                const dbQuerySpan = traces[0].find(span => span.meta['prisma.name'] === 'db_query')
                assertObjectContains(dbQuerySpan, {
                  resource: 'INSERT INTO "User" ("name") VALUES ($1)',
                  meta: {
                    'out.host': 'primary.db.internal',
                    'network.destination.port': '5432',
                  },
                })
              })
              primaryClient._tracingHelper.dispatchEngineSpans(createEngineDbQuerySpan(
                'INSERT INTO "User" ("name") VALUES ($1)'
              ))
              await primaryWriteTrace
            })
          }
        })

        describe('with configuration', () => {
          describe('with custom service name', () => {
            before(async function () {
              this.timeout(10000)
              clearPrismaEnv()
              setPrismaEnv(config)

              const cwd = await copySchemaToVersionDir(config.schema, range)

              execPrismaGenerate(config, cwd)

              const pluginConfig = {
                service: 'custom',
              }
              return agent.load(['prisma', 'pg'], pluginConfig)
            })

            after(() => { return agent.close({ ritmReset: false }) })

            beforeEach(() => {
              prisma = loadPrismaModule(config, range)
              prismaClient = createPrismaClient(prisma, config)
            })

            it('should be configured with the correct values', async () => {
              const tracingPromise = agent.assertFirstTraceSpan({
                service: 'custom',
              })

              await Promise.all([
                prismaClient.$queryRaw`SELECT 1`,
                tracingPromise,
              ])
            })
          })
        })
      })
    })
  })
})
