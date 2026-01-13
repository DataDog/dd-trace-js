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
  varySandbox
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const { SCHEMA_FIXTURES, TEST_DATABASE_URL } = require('../prisma-fixtures')

const prismaClientConfigs = [{
  name: 'prisma-generator-js with no output',
  schema: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.clientJs}`,
  serverFile: 'server.mjs',
  importPath: '@prisma/client'
},
{
  name: 'prisma-generator-js with custom output',
  serverFile: 'server-output.mjs',
  importPath: './generated/prisma/index.js',
  schema: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.clientOutputJs}`,
  env: { PRISMA_CLIENT_OUTPUT: './generated/prisma' }
},
{
  name: 'prisma-generator v6',
  serverFile: 'server-ts-v6.mjs',
  importPath: './dist/client.js',
  schema: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.tsEsmV6}`,
  env: { PRISMA_CLIENT_OUTPUT: './generated/prisma', DATABASE_URL: TEST_DATABASE_URL },
  ts: true
},
{
  name: 'prisma-generator v7',
  serverFile: 'server-ts-v7.mjs',
  importPath: './dist/client.js',
  schema: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.tsEsmV7}`,
  configFile: `./packages/datadog-plugin-prisma/test/${SCHEMA_FIXTURES.tsEsmV7Config}`,
  env: { PRISMA_CLIENT_OUTPUT: './generated/prisma', DATABASE_URL: TEST_DATABASE_URL },
  ts: true
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

      const supportedRange = config.configFile ? '>=7.0.0' : '<7.0.0'

      withVersions('prisma', '@prisma/client', supportedRange, version => {
        if (config.ts && version === '6.1.0') return
        let variants
        const paths = ['./packages/datadog-plugin-prisma/test/integration-test/*', config.schema]

        if (isPrismaV7) paths.push(config.configFile)

        const deps = [`prisma@${version}`, `@prisma/client@${version}`, 'typescript']
        if (isPrismaV7) deps.push('@prisma/adapter-pg')
        useSandbox(deps, false, paths)

        before(function () {
          variants = varySandbox(config.serverFile, 'prismaLib', undefined, config.importPath)
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
              res
            ])
          })
        }
      })
    })
  })
})
