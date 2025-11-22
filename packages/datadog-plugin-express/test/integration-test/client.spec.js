'use strict'

const assert = require('node:assert/strict')

const {
  FakeAgent,
  curlAndAssertMessage,
  spawnPluginIntegrationTestProc,
  sandboxCwd,
  useSandbox,
  varySandbox
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const semver = require('semver')

describe('esm', () => {
  withVersions('express', 'express', version => {
    let agent
    let proc
    let variants

    useSandbox([`'express@${version}'`], false,
      ['./packages/datadog-plugin-express/test/integration-test/*'])

    before(async function () {
      variants = varySandbox('server.mjs', 'express')
    })

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    afterEach(async () => {
      proc && proc.kill()
      await agent.stop()
    })
    for (const variant of varySandbox.VARIANTS) {
      describe('with DD_TRACE_MIDDLEWARE_TRACING_ENABLED unset', () => {
        it(`is instrumented loaded with ${variant}`, async () => {
          proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)
          const numberOfSpans = semver.intersects(version, '<5.0.0') ? 4 : 2
          const whichMiddleware = semver.intersects(version, '<5.0.0')
            ? 'express'
            : 'router'

          return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
            assert.strictEqual(headers['host'], `127.0.0.1:${agent.port}`)
            assert.ok(Array.isArray(payload))
            assert.strictEqual(payload.length, 1)
            assert.ok(Array.isArray(payload[0]))
            assert.strictEqual(payload[0].length, numberOfSpans)
            assert.strictEqual(payload[0][0]['name'], 'express.request')
            assert.strictEqual(payload[0][1]['name'], `${whichMiddleware}.middleware`)
          })
        }).timeout(50000)
      })

      describe('with DD_TRACE_MIDDLEWARE_TRACING_ENABLED=true', () => {
        before(() => {
          process.env.DD_TRACE_MIDDLEWARE_TRACING_ENABLED = false
        })

        after(() => {
          delete process.env.DD_TRACE_MIDDLEWARE_TRACING_ENABLED
        })

        it('disables middleware spans when config.middlewareTracingEnabled is false via env var', async () => {
          proc = await spawnPluginIntegrationTestProc(sandboxCwd(), variants[variant], agent.port)
          const numberOfSpans = 1

          return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
            assert.strictEqual(headers['host'], `127.0.0.1:${agent.port}`)
            assert.ok(Array.isArray(payload))
            assert.strictEqual(payload.length, 1)
            assert.ok(Array.isArray(payload[0]))
            assert.strictEqual(payload[0].length, numberOfSpans)
            assert.strictEqual(payload[0][0]['name'], 'express.request')
          })
        }).timeout(50000)
      })
    }
  })
})
