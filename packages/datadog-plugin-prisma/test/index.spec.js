'use strict'

const assert = require('node:assert/strict')
const { execSync } = require('node:child_process')
const fs = require('node:fs/promises')
const path = require('node:path')

const { after, before, beforeEach, describe, it } = require('mocha')
const semifies = require('semifies')

const { assertObjectContains } = require('../../../integration-tests/helpers')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectedSchema, rawExpectedSchema } = require('./naming')
describe('Plugin', () => {
  let prisma
  let prismaClient
  let tracingHelper

  describe('prisma', () => {
    // Prisma 7.0.0+ is not supported in Node.js < 20.19.0
    const supportedRange = semifies(process.version, '>=20.19.0') ? '*' : '>=7.0.0'

    withVersions('prisma', ['@prisma/client'], supportedRange, async (range, _moduleName_, version) => {
      describe('without configuration', () => {
        before(async () => {
          const cwd = path.resolve(__dirname, `../../../versions/@prisma/client@${range}`)
          await fs.cp(
            path.resolve(__dirname, './schema.prisma'),
            cwd + '/schema.prisma',
          )
          await agent.load('prisma')
          execSync('./node_modules/.bin/prisma generate', {
            cwd, // Ensure the current working directory is where the schema is located
            stdio: 'inherit'
          })
          prisma = require(`../../../versions/@prisma/client@${range}`).get()
          prismaClient = new prisma.PrismaClient()
          const matched = version.match(/(\d+)\.\d+\.\d+$/)
          const majorVersion = matched[1]
          tracingHelper = global.PRISMA_INSTRUMENTATION?.helper ||
            global[`V${majorVersion}_PRISMA_INSTRUMENTATION`]?.helper
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        it('should do automatic instrumentation', async () => {
          const tracingPromise = agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].resource, 'queryRaw')
            assert.strictEqual(traces[0][0].meta['prisma.type'], 'client')
            assert.strictEqual(traces[0][0].meta['prisma.method'], 'queryRaw')
            assert.strictEqual(traces[0][0].name, expectedSchema.client.opName)
            assert.strictEqual(traces[0][0].service, expectedSchema.client.serviceName)

            // grabbing actual db query span
            const engineDBSpan = traces[0].find(span => span.meta['prisma.name'] === 'db_query')
            assert.strictEqual(engineDBSpan.resource, 'SELECT 1')
            assert.strictEqual(engineDBSpan.type, 'sql')
            assert.strictEqual(engineDBSpan.meta['span.kind'], 'client')
            assert.strictEqual(engineDBSpan.name, expectedSchema.engine.opName)
            assert.strictEqual(engineDBSpan.service, expectedSchema.engine.serviceName)
          })

          await Promise.all([
            prismaClient.$queryRaw`SELECT 1`,
            tracingPromise
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
              }
            })
          })
          await Promise.all([
            // This will throw an error because no data object is provided
            prismaClient.User.create({}).catch(e => {
              error = e
            }),
            tracingPromise
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
            }
          })

          tracingHelper.runInChildSpan(
            {
              name: 'operation',
              attributes: { method: 'findMany', model: 'users' }
            },
            () => {
              return 'Test Function'
            }
          )

          await Promise.all([
            tracingPromise
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
              kind: 'internal'
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
                'db.query.text': 'SELECT 1'
              }
            }
          ]
          tracingHelper.dispatchEngineSpans(engineSpans)
          await Promise.all([
            tracingPromise
          ])
        })

        it('should include database connection attributes in db_query spans', async () => {
          // Set up database config that should be parsed from connection URL
          const dbConfig = {
            user: 'foo',
            host: 'localhost',
            port: '5432',
            database: 'postgres'
          }
          tracingHelper.setDbString(dbConfig)

          const tracingPromise = agent.assertSomeTraces(traces => {
            // Find the db_query span
            const dbQuerySpan = traces[0].find(span => span.meta['prisma.name'] === 'db_query')
            assert.ok(dbQuerySpan != null)

            // Verify database connection attributes are present
            assert.strictEqual(dbQuerySpan.meta['db.name'], 'postgres')
            assert.strictEqual(dbQuerySpan.meta['db.user'], 'foo')
            assert.strictEqual(dbQuerySpan.meta['out.host'], 'localhost')
            assert.strictEqual(dbQuerySpan.meta['network.destination.port'], '5432')
            assert.strictEqual(dbQuerySpan.meta['db.type'], 'postgres')
          })

          const engineSpans = [
            {
              id: '1',
              parentId: null,
              name: 'prisma:engine:db_query',
              startTime: [1745340876, 436861000],
              endTime: [1745340876, 438601541],
              kind: 'client',
              attributes: {
                'db.system': 'postgresql',
                'db.query.text': 'SELECT 1'
              }
            }
          ]
          tracingHelper.dispatchEngineSpans(engineSpans)
          await Promise.all([
            tracingPromise
          ])
        })

        it('should return real traceparent from active span context', async () => {
          let capturedTraceparent
          const tracingPromise = agent.assertSomeTraces(traces => {
            // Get the trace ID and span ID from the created span
            const clientSpan = traces[0].find(span => span.meta['prisma.type'] === 'client')
            assert.ok(clientSpan != null)

            // Verify the traceparent is not the hardcoded fallback
            assert.notEqual(capturedTraceparent, '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01')

            // Verify it matches W3C traceparent format
            const traceparentRegex = /^00-[a-f0-9]{32}-[a-f0-9]{16}-[0-9]{2}$/
            assert.ok(traceparentRegex.test(capturedTraceparent),
              `Invalid traceparent format: ${capturedTraceparent}`)

            // Extract trace ID from traceparent (format: version-traceid-spanid-flags)
            const [, traceparentTraceId] = capturedTraceparent.split('-')

            // Convert the span's trace_id to hex for comparison
            const spanTraceIdHex = clientSpan.trace_id.toString(16).padStart(32, '0')

            // The last 16 characters of the traceparent trace ID should match
            // the span's trace ID (dd-trace uses 64-bit trace IDs by default)
            assert.ok(traceparentTraceId.endsWith(spanTraceIdHex.slice(-16)),
              `Traceparent trace ID ${traceparentTraceId} should contain span trace ID ${spanTraceIdHex}`)
          })

          // Capture the traceparent during the query
          await prismaClient.$queryRaw`SELECT 1`.then(() => {
            // Get traceparent while span is still active
            capturedTraceparent = tracingHelper.getTraceParent()
          })

          await tracingPromise
        })

        it('should return fallback traceparent when no active span', () => {
          // Get traceparent outside of a traced operation
          // This should return the fallback value since there's no active span
          const result = tracingHelper.getTraceParent()

          // Should be the valid sampled fallback traceparent
          assert.strictEqual(result, '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01')
        })
      })

      describe('with configuration', () => {
        describe('with custom service name', () => {
          before(() => {
            const config = {
              service: 'custom'
            }
            return agent.load('prisma', config)
          })

          after(() => { return agent.close({ ritmReset: false }) })

          beforeEach(() => {
            prisma = require(`../../../versions/@prisma/client@${range}`).get()
            prismaClient = new prisma.PrismaClient()
          })

          it('should be configured with the correct values', async () => {
            const tracingPromise = agent.assertFirstTraceSpan({
              service: 'custom'
            })

            await Promise.all([
              prismaClient.$queryRaw`SELECT 1`,
              tracingPromise
            ])
          })
        })

        describe('with prisma client disabled', () => {
          before(() => {
            const config = {
              client: false
            }
            return agent.load('prisma', config)
          })

          after(() => { return agent.close({ ritmReset: false }) })

          beforeEach(() => {
            prisma = require(`../../../versions/@prisma/client@${range}`).get()
            prismaClient = new prisma.PrismaClient()
          })

          it('should disable prisma client', async () => {
            const tracingPromise = agent.assertSomeTraces(traces => {
              const clientSpans = traces[0].find(span => span.meta['prisma.type'] === 'client')
              assert.ok(clientSpans == null)
            })

            await Promise.all([
              prismaClient.$queryRaw`SELECT 1`,
              tracingPromise
            ])
          })

          withNamingSchema(
            done => prismaClient.$queryRaw`SELECT 1`.catch(done),
            rawExpectedSchema.engine,
            { desc: 'Prisma Engine' }
          )
        })

        describe('with prisma engine disabled', () => {
          before(() => {
            const config = {
              engine: false
            }
            return agent.load('prisma', config)
          })

          after(() => { return agent.close({ ritmReset: false }) })

          beforeEach(() => {
            prisma = require(`../../../versions/@prisma/client@${range}`).get()
            prismaClient = new prisma.PrismaClient()
          })

          it('should disable prisma engine', async () => {
            const tracingPromise = agent.assertSomeTraces(traces => {
              const engineSpans = traces[0].find(span => span.meta['prisma.type'] === 'engine')
              assert.ok(engineSpans == null)
            })

            await Promise.all([
              prismaClient.$queryRaw`SELECT 1`,
              tracingPromise
            ])
          })

          withNamingSchema(
            done => prismaClient.$queryRaw`SELECT 1`.catch(done),
            rawExpectedSchema.client,
            { desc: 'Prisma Client' }
          )
        })
      })
    })
  })
})
