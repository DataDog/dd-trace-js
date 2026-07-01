'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const { describe, it, before, beforeEach, afterEach } = require('mocha')
const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProcAndExpectExit,
  varySandbox,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

// claude-agent-sdk has no default export; base variant is destructure, star is explicit
const IMPORT_DESTRUCTURE = "import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'"
const IMPORT_STAR =
  "import * as _sdk from '@anthropic-ai/claude-agent-sdk'; " +
  'const { query, tool, createSdkMcpServer } = _sdk'

describe('esm', () => {
  let agent
  let proc
  let variants

  withVersions('claude-agent-sdk', ['@anthropic-ai/claude-agent-sdk'], version => {
    useSandbox([
      `@anthropic-ai/claude-agent-sdk@${version}`,
    ], false, [
      './packages/datadog-plugin-claude-agent-sdk/test/integration-test/*',
    ])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    before(async function () {
      variants = varySandbox('server.mjs', {
        star: IMPORT_STAR,
        destructure: IMPORT_DESTRUCTURE,
      }, undefined, undefined, true)
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of ['star', 'destructure']) {
      it(`is instrumented ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'claude_agent_sdk.query'), true)
        })

        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port, {
          NODE_OPTIONS: '--import dd-trace/initialize.mjs',
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '<not-a-real-key>',
        })

        await res
      }).timeout(20000)
    }
  })
})
