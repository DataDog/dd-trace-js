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

const prismaClientConfigs = [
  {
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
    env: { DD_PRISMA_OUTPUT: 'generated/prisma', PRISMA_CLIENT_OUTPUT: './generated/prisma' }
  }
]

describe('esm', () => {
  let agent
  let proc

  prismaClientConfigs.forEach(config => {
    describe(config.name, () => {
      withVersions('prisma', '@prisma/client', version => {
        let variants
        useSandbox([`'prisma@${version}'`, `'@prisma/client@${version}'`], false, [
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
