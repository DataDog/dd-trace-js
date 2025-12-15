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

const prismaClientConfigs = [{
  name: 'default @prisma/client',
  schema: './packages/datadog-plugin-prisma/test/provider-prisma-client-js/schema.prisma',
  serverFile: 'server.mjs',
  importPath: '@prisma/client'
},
{
  name: 'custom output path',
  serverFile: 'server-custom-output.mjs',
  importPath: './generated/prisma/index.js',
  schema: './packages/datadog-plugin-prisma/test/provider-prisma-client-output-js/schema.prisma',
  env: { PRISMA_CLIENT_OUTPUT: './generated/prisma' }
},
{
  name: 'non JS client generator',
  serverFile: 'server-non-js-generator.js',
  importPath: './dist/client.js',
  schema: './packages/datadog-plugin-prisma/test/provider-prisma-client-ts/schema.prisma',
  env: { PRISMA_CLIENT_OUTPUT: './generated/prisma' },
  ts: true
}]

describe('esm', () => {
  let agent
  let proc

  prismaClientConfigs.forEach(config => {
    describe(config.name, () => {
      withVersions('prisma', '@prisma/client', version => {
        if (config.ts && version === '6.1.0') return
        let variants
        useSandbox([`prisma@${version}`, `@prisma/client@${version}`, 'typescript'], false, [
          './packages/datadog-plugin-prisma/test/integration-test/*',
          config.schema
        ])

        before(function () {
          variants = varySandbox(config.serverFile, config.importPath, 'PrismaClient')
        })

        beforeEach(async function () {
          this.timeout(60000)
          agent = await new FakeAgent().start()

          const cwd = sandboxCwd()
          if (config.ts) {
            execSync(
              './node_modules/.bin/prisma migrate reset --force &&' +
              './node_modules/.bin/prisma db push --accept-data-loss &&' +
              './node_modules/.bin/prisma generate &&' +
              './node_modules/.bin/tsc ./generated/**/*.ts --outDir ./dist --target esnext --module commonjs --allowJs true --moduleResolution node',
              {
                cwd,
                stdio: 'inherit',
                env: {
                  ...process.env,
                  ...config.env
                }
              }
            )
          } else {
            execSync(
              './node_modules/.bin/prisma migrate reset --force &&' +
              './node_modules/.bin/prisma db push --accept-data-loss &&' +
              './node_modules/.bin/prisma generate',
              {
                cwd,
                stdio: 'inherit',
                env: {
                  ...process.env,
                  ...config.env
                }
              }
            )
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
                name: 'prisma.engine',
                service: 'node-prisma',
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
