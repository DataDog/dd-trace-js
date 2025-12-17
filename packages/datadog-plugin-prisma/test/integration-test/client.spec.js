'use strict'

const assert = require('node:assert')
const { execSync } = require('node:child_process')

const { describe, it, beforeEach, afterEach } = require('mocha')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  spawnPluginIntegrationTestProc,
  assertObjectContains,
  varySandbox
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { SCHEMA_FIXTURES, TEST_DATABASE_URL } = require('../prisma-fixtures')

const prismaClientConfigs = [{
    name: 'default @prisma/client',
    schema: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.clientJs}`,
    serverFile: 'server.mjs',
    importPath: '@prisma/client'
  },
  {
    name: 'custom output path',
    serverFile: 'server-custom-output.mjs',
    importPath: './generated/prisma/index.js',
    schema: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.clientOutputJs}`,
    env: { PRISMA_CLIENT_OUTPUT: './generated/prisma' }
  },
  {
    name: 'non JS client generator',
    serverFile: 'server-non-js-generator.mjs',
    importPath: './dist/client.js',
    schema: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.tsEsmV6}`,
    env: { PRISMA_CLIENT_OUTPUT: './generated/prisma', DATABASE_URL: TEST_DATABASE_URL },
    ts: true
  },
  {
    name: 'non JS client generator v7',
    serverFile: 'server-non-js-adapter.mjs',
    importPath: './dist/client.js',
    schema: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.tsEsmV7}`,
    configFile: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.tsEsmV7Config}`,
    env: { PRISMA_CLIENT_OUTPUT: './generated/prisma', DATABASE_URL: TEST_DATABASE_URL },
    ts: true
  }]

describe('esm', () => {
  let agent
  let proc
  let versionRange
  prismaClientConfigs.forEach(config => {
    describe(config.name, () => {
      versionRange = config.configFile ? '>=7.0.0' : '<7.0.0'
      withVersions('prisma', '@prisma/client', versionRange, version => {
        if (config.ts && version === '6.1.0') return
        let variants
        const paths = ['./packages/datadog-plugin-prisma/test/integration-test/*', config.schema]

        if (config.configFile) paths.push(config.configFile)

        useSandbox([`prisma@${version}`, `@prisma/client@${version}`, 'typescript', '@prisma/adapter-pg'], false, paths)

        before(function () {
          variants = varySandbox(config.serverFile, config.importPath, 'PrismaClient')
        })

        beforeEach(async function () {
          this.timeout(60000)
          agent = await new FakeAgent().start()
          const commands = [
            './node_modules/.bin/prisma migrate reset --force',
            './node_modules/.bin/prisma db push --accept-data-loss',
            './node_modules/.bin/prisma generate'
          ]
          const cwd = sandboxCwd()

          if (config.ts) {
            commands.push(
              './node_modules/.bin/tsc ./generated/**/*.ts' +
              ' --outDir ./dist' +
              ' --target ES2023' +
              ' --module ESNext' +
              ' --strict true' +
              ' --moduleResolution node' +
              ' --esModuleInterop true'
            )
          }

          execSync(commands.join(' && '), {
            cwd,
            stdio: 'inherit',
            env: {
              ...process.env,
              ...config.env
            }
          })
        })

        afterEach(async () => {
          proc?.kill()
          await agent.stop()
        })

        for (const variant of varySandbox.VARIANTS) {
          it(`is instrumented with ${variant} import`, async function () {
            this.timeout(60000)
            const res = agent.assertMessageReceived(({ headers, payload }) => {
              assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
              assertObjectContains(payload, [[{
                name: 'prisma.client',
                resource: 'User.create',
                service: 'node-prisma'
              }], [{
                name: config.configFile ? 'pg.query' : 'prisma.engine',
                service: config.configFile ? 'node-postgres' : 'node-prisma',
                meta: {
                  'db.user': 'postgres',
                  'db.name': 'postgres',
                  'db.type': 'postgres'
                }
              }]])
            })

            const procPromise = spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port, {
              DD_TRACE_FLUSH_INTERVAL: '2000',
              ...config.env
            })

            await Promise.all([
              procPromise.then((res) => {
                proc = res
              }),
              res
            ])
          })
        }
      })
    })
  })
})
