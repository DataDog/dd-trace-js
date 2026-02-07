'use strict'

const assert = require('node:assert')
const { execSync } = require('node:child_process')

const { describe, it, beforeEach, afterEach } = require('mocha')

const semifies = require('semifies')
const semver = require('semver')
const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  spawnPluginIntegrationTestProcAndExpectExit,
  assertObjectContains,
  varySandbox,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const waitForMssql = require('../../../dd-trace/test/setup/services/mssql')
const {
  SCHEMA_FIXTURES,
  TEST_DATABASE_URL,
  TEST_MARIADB_DATABASE_URL,
  TEST_MSSQL_DATABASE_URL,
} = require('../prisma-fixtures')

const prismaClientConfigs = [{
  name: 'prisma-generator-js with no output',
  schema: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.clientJs}`,
  serverFile: 'server.mjs',
  importPath: '@prisma/client',
  variant: 'default',
},
{
  name: 'prisma-generator-js with custom output',
  serverFile: 'server-output.mjs',
  importPath: './generated/prisma/index.js',
  schema: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.clientOutputJs}`,
  env: { PRISMA_CLIENT_OUTPUT: './generated/prisma' },
  variant: 'star',
},
{
  name: 'prisma-generator v6 postgres',
  serverFile: 'server-ts-v6.mjs',
  importPath: './dist/client.js',
  schema: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.tsEsmV6}`,
  env: {
    PRISMA_CLIENT_OUTPUT: './generated/prisma',
    DATABASE_URL: TEST_DATABASE_URL,
  },
  ts: true,
  variant: 'star',
},
{
  name: 'prisma-generator v7 pg adapter (url)',
  serverFile: 'server-ts-v7.mjs',
  importPath: './dist/client.js',
  schema: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.tsEsmV7}`,
  configFile: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.tsEsmV7Config}`,
  env: {
    PRISMA_CLIENT_OUTPUT: './generated/prisma',
    DATABASE_URL: TEST_DATABASE_URL,
  },
  ts: true,
  variant: 'destructure',
},
{
  name: 'prisma-generator v7 pg adapter (fields)',
  serverFile: 'server-ts-v7.mjs',
  importPath: './dist/client.js',
  schema: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.tsEsmV7}`,
  configFile: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.tsEsmV7Config}`,
  env: {
    PRISMA_CLIENT_OUTPUT: './generated/prisma',
    DATABASE_URL: TEST_DATABASE_URL,
    PRISMA_PG_ADAPTER_CONFIG: 'fields',
  },
  ts: true,
  variant: 'star',
},
{
  name: 'prisma-generator v7 mariadb adapter (url)',
  serverFile: 'server-ts-v7-mariadb.mjs',
  importPath: './dist/client.js',
  schema: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.tsEsmV7Mariadb}`,
  configFile: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.tsEsmV7MariadbConfig}`,
  env: {
    PRISMA_CLIENT_OUTPUT: './generated/prisma',
    DATABASE_URL: TEST_MARIADB_DATABASE_URL,
  },
  ts: true,
  adapterDeps: ['@prisma/adapter-mariadb', 'mariadb'],
  variant: 'star',
  dbSpan: {
    name: 'mariadb.query',
    meta: {
      'db.user': 'root',
      'db.name': 'db',
      'db.type': 'mariadb',
    },
  },
},
{
  name: 'prisma-generator v7 mssql adapter (url)',
  serverFile: 'server-ts-v7-mssql.mjs',
  importPath: './dist/client.js',
  schema: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.tsEsmV7Mssql}`,
  configFile: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.tsEsmV7MssqlConfig}`,
  env: {
    PRISMA_CLIENT_OUTPUT: './generated/prisma',
    DATABASE_URL: TEST_MSSQL_DATABASE_URL,
  },
  ts: true,
  adapterDeps: ['@prisma/adapter-mssql', 'tedious'],
  waitForService: waitForMssql,
  skip: () => process.arch === 'arm64',
  variant: 'destructure',
  dbSpan: {
    name: 'mssql.query',
    meta: {
      'db.user': 'sa',
      'db.name': 'master',
      'db.type': 'mssql',
    },
  },
},
{
  name: 'prisma-generator v7 mssql adapter (fields)',
  serverFile: 'server-ts-v7-mssql.mjs',
  importPath: './dist/client.js',
  schema: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.tsEsmV7Mssql}`,
  configFile: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.tsEsmV7MssqlConfig}`,
  env: {
    PRISMA_CLIENT_OUTPUT: './generated/prisma',
    DATABASE_URL: TEST_MSSQL_DATABASE_URL,
    PRISMA_MSSQL_ADAPTER_CONFIG: 'fields',
  },
  ts: true,
  adapterDeps: ['@prisma/adapter-mssql', 'tedious'],
  waitForService: waitForMssql,
  skip: () => process.arch === 'arm64',
  variant: 'star',
  dbSpan: {
    name: 'mssql.query',
    meta: {
      'db.user': 'sa',
      'db.name': 'master',
      'db.type': 'mssql',
    },
  },
}]

describe('esm', () => {
  let agent
  let proc
  prismaClientConfigs.forEach(config => {
    describe(config.name, () => {
      const isNodeSupported = semifies(semver.clean(process.version), '>=20.19.0')
      const isPrismaV7 = config.configFile
      if (config.configFile && !isNodeSupported) {
        return
      }
      if (config.skip?.()) {
        return
      }

      const supportedRange = config.configFile ? '>=7.0.0' : '<7.0.0'

      withVersions('prisma', '@prisma/client', supportedRange, version => {
        if (config.ts && version === '6.1.0') return
        let variants
        const paths = ['./packages/datadog-plugin-prisma/test/integration-test/*', config.schema]

        if (isPrismaV7) paths.push(config.configFile)

        const deps = [`prisma@${version}`, `@prisma/client@${version}`, 'typescript']
        if (isPrismaV7) {
          if (config.adapterDeps?.length) {
            deps.push(...config.adapterDeps)
          } else {
            deps.push('@prisma/adapter-pg')
          }
        }
        useSandbox(deps, false, paths)

        before(function () {
          variants = varySandbox(config.serverFile, config.ts ? 'PrismaClient' : 'prismaLib',
            config.ts ? 'PrismaClient' : undefined, config.importPath, config.ts)
          if (!variants[config.variant]) {
            throw new Error(`Unknown variant ${config.variant} for ${config.name}`)
          }
        })

        beforeEach(async function () {
          this.timeout(60000)
          if (config.waitForService) {
            await config.waitForService()
          }
          agent = await new FakeAgent().start()
          const commands = [
            './node_modules/.bin/prisma migrate reset --force',
            './node_modules/.bin/prisma db push --accept-data-loss',
            './node_modules/.bin/prisma generate',
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
              ...config.env,
            },
          })

          // node v18 needs the package.json to have type module to treat .js files as esm
          if (config.ts && config.name.includes('v6')) {
            const fs = require('fs')
            const path = require('path')
            const distPath = path.join(cwd, 'dist')
            try {
              fs.mkdirSync(distPath, { recursive: true })
            } catch {}
            const distPkgJsonPath = path.join(distPath, 'package.json')
            fs.writeFileSync(distPkgJsonPath, JSON.stringify({ type: 'module' }, null, 2))
          }
        })

        afterEach(async () => {
          proc?.kill()
          await agent.stop()
        })

        const variant = config.variant
        it(`is instrumented with ${variant} import`, async function () {
          this.timeout(60000)
          const dbSpanExpectation = config.dbSpan || {
            name: config.configFile ? 'pg.query' : 'prisma.engine',
            service: config.configFile ? 'node-postgres' : 'node-prisma',
            meta: {
              'db.user': 'postgres',
              'db.name': 'postgres',
              'db.type': 'postgres',
            },
          }
          const res = agent.assertMessageReceived(({ headers, payload }) => {
            assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
            assertObjectContains(payload, [[{
              name: 'prisma.client',
              resource: 'User.create',
              service: 'node-prisma',
            }], [dbSpanExpectation]])
          })

          const procPromise = spawnPluginIntegrationTestProcAndExpectExit(
            sandboxCwd(),
            variants[variant],
            agent.port,
            { DD_TRACE_FLUSH_INTERVAL: '2000', ...config.env }
          )

          await Promise.all([
            procPromise.then((res) => {
              proc = res
            }),
            res,
          ])
        })
      })
    })
  })
})
