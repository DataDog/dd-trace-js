'use strict'

const fs = require('fs/promises')
const path = require('path')
const agent = require('../../dd-trace/test/plugins/agent')
const { execSync } = require('node:child_process')
const { expectedSchema, rawExpectedSchema } = require('./naming')
const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const os = require('os')

/*
 * Creates a temporary project directory for the Prisma client
 * This is necessary because Prisma CLI expects a package.json and node_modules
 * otherwise it will try to install @prisma/client in the root node_modules
*/
async function createTempProject (version) {
  const tempDir = await fs.mkdtemp((path.join(os.tmpdir(), `prisma-test-@${version}-`)))
  await fs.writeFile(
    path.join(tempDir, 'package.json'),
    JSON.stringify({}, null, 2)
  )
  return tempDir
}

// Ensure a fake @prisma/client installed in temporary directory path otherwise prisma generate
// will automatically install a version of @prisma/client in the root node_modules
async function createMockPrismaClient (targetPath, version) {
  const matched = version.match(/(\d+\.\d+\.\d+)$/)
  version = matched[1]

  // trick the prisma CLI to think that the client is installed in this directory
  execSync(`npm install @prisma/client@${version} --no-save --legacy-peer-deps`, {
    cwd: path.dirname(targetPath),
    stdio: 'inherit'
  })
}

/*
  * Generates the Prisma client in the specified version
  * This function creates a temporary project directory, writes a Prisma schema,
  * and runs the Prisma CLI to generate the client.
*/
async function generatePrismaClient (version) {
  const tempDir = await createTempProject(version)
  await createMockPrismaClient(tempDir, version)

  const generatedClientPath = path.join(
    __dirname,
    `../../../versions/@prisma/client@${version}/node_modules/.prisma/client`
  )

  const generatedSchemaPath = path.join(tempDir, 'schema.prisma')
  const prismaBin = path.join(__dirname, '/../../../versions/prisma/node_modules/.bin/prisma')

  const schema = `
      generator client {
        provider = "prisma-client-js"
        output   = "${generatedClientPath}"
      }
      
      datasource db {
        provider = "postgresql"
        url      = "postgres://postgres:postgres@localhost:5432/postgres"
      }

      model User {
      id    Int     @id @default(autoincrement())
      email String  @unique
      name  String?
    }
  `
  await fs.writeFile(generatedSchemaPath, schema)
  execSync(`${prismaBin} generate --schema="${generatedSchemaPath}"`, {
    cwd: tempDir, // Ensure the current working directory is where the schema is located
    stdio: 'inherit'
  })
  return tempDir
}
// Cleanup function to remove the mock Prisma client and its dependencies
// from the temporary directory after tests are done
async function cleanupMockPrismaClient (directory) {
  const nodeModulesPath = path.join(directory, 'node_modules')
  const packageJsonPath = path.join(directory, 'package.json')
  const prismaSchemaPath = path.join(directory, 'schema.prisma')

  await fs.rm(nodeModulesPath, { recursive: true, force: true })
  await fs.rm(packageJsonPath, { force: true })

  await fs.rm(prismaSchemaPath, { force: true })
}

describe('Plugin', () => {
  let prisma
  let prismaClient
  let tracingHelper

  describe('prisma', () => {
    withVersions('prisma', ['@prisma/client'], version => {
      let tempDir

      before(async () => {
        tempDir = await generatePrismaClient(version)
      })
      after(async () => {
        if (tempDir) {
          await cleanupMockPrismaClient(tempDir)
        }
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load('prisma')
        })

        beforeEach(() => {
          prisma = require(`../../../versions/@prisma/client@${version}`).get()
          prismaClient = new prisma.PrismaClient()
          const matched = version.match(/(\d+)\.\d+\.\d+$/)
          const majorVersion = matched[1]
          tracingHelper = global.PRISMA_INSTRUMENTATION.helper ||
            [`V${majorVersion}_PRISMA_INSTRUMENTATION`].helper
        })

        after(() => { return agent.close({ ritmReset: false }) })

        it('should do automatic instrumentation', async () => {
          const tracingPromise = agent.assertSomeTraces(traces => {
            expect(traces[0][0].resource).to.equal('queryRaw')
            expect(traces[0][0].meta).to.have.property('prisma.type', 'client')
            expect(traces[0][0].meta).to.have.property('prisma.method', 'queryRaw')
            expect(traces[0][0]).to.have.property('name', expectedSchema.client.opName)
            expect(traces[0][0]).to.have.property('service', expectedSchema.client.serviceName)

            // grabbing actual db query span
            const engineDBSpan = traces[0].find(span => span.meta['prisma.name'] === 'db_query')
            expect(engineDBSpan).to.have.property('resource', 'SELECT 1')
            expect(engineDBSpan).to.have.property('type', 'sql')
            expect(engineDBSpan.meta).to.have.property('span.kind', 'client')
            expect(engineDBSpan).to.have.property('name', expectedSchema.engine.opName)
            expect(engineDBSpan).to.have.property('service', expectedSchema.engine.serviceName)
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
            expect(traces[0].length).to.equal(2)
            expect(traces[0][0].span_id).to.equal(traces[0][1].parent_id)
            expect(traces[0][0].name).to.equal('prisma.engine')
            expect(traces[0][0].resource).to.equal('query')
            expect(traces[0][0].meta).to.have.property('prisma.type', 'engine')
            expect(traces[0][0].meta).to.have.property('prisma.name', 'query')
            expect(traces[0][1].name).to.equal('prisma.engine')
            expect(traces[0][1].resource).to.equal('SELECT 1')
            expect(traces[0][1].type).to.equal('sql')
            expect(traces[0][1].meta).to.have.property('prisma.type', 'engine')
            expect(traces[0][1].meta).to.have.property('prisma.name', 'db_query')
            expect(traces[0][1].meta).to.have.property('db.type', 'postgres')
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
            prisma = require(`../../../versions/@prisma/client@${version}`).get()
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
            prisma = require(`../../../versions/@prisma/client@${version}`).get()
            prismaClient = new prisma.PrismaClient()
          })

          it('should disable prisma client', async () => {
            const tracingPromise = agent.assertSomeTraces(traces => {
              const clientSpans = traces[0].find(span => span.meta['prisma.type'] === 'client')
              expect(clientSpans).not.to.exist
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
            prisma = require(`../../../versions/@prisma/client@${version}`).get()
            prismaClient = new prisma.PrismaClient()
          })

          it('should disable prisma engine', async () => {
            const tracingPromise = agent.assertSomeTraces(traces => {
              const engineSpans = traces[0].find(span => span.meta['prisma.type'] === 'engine')
              expect(engineSpans).not.to.exist
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
