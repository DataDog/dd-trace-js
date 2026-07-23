'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  curlAndAssertMessage,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
  varySandbox,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('esm', () => {
  let agent
  let proc

  // restify 7.x-9.x crash on load on this job's Node >=18 matrix: they assign the now getter-only
  // `IncomingMessage#closed` (`TypeError: Cannot set property closed`). 4.x-6.x predate that assignment
  // and 10.x+ dropped it, so exercise those and skip only the broken middle majors. (server.mjs's import
  // syntax already requires >3.)
  withVersions('restify', 'restify', '>3 <7 || >=10', version => {
    useSandbox([`'restify@${version}'`],
      false, ['./packages/datadog-plugin-restify/test/integration-test/*'])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    const variants = varySandbox('server.mjs', {
      bindingName: 'restify',
      packageName: 'restify',
      defaultExport: true,
      namedExports: ['createServer'],
      namedExportBinding: 'namespace',
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of Object.keys(variants)) {
      it(`is instrumented ${variant}`, async () => {
        proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)

        return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'restify.request'), true)
        })
      }).timeout(20000)
    }
  })
})
