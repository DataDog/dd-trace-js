'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { describe, it, beforeEach, afterEach } = require('mocha')
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

describe('esm', () => {
  let agent
  let proc

  withVersions('claude-agent-sdk', ['@anthropic-ai/claude-agent-sdk'], version => {
    useSandbox([
      `@anthropic-ai/claude-agent-sdk@${version}`,
    ], false, [
      './packages/datadog-plugin-claude-agent-sdk/test/integration-test/*',
    ])

    beforeEach(async () => {
      agent = await new FakeAgent().start()
    })

    const variants = varySandbox('server.mjs', {
      bindingName: '_sdk',
      packageName: '@anthropic-ai/claude-agent-sdk',
      defaultExport: false,
      namedExports: ['query', 'tool', 'createSdkMcpServer'],
      namedExportBinding: 'destructure',
    })

    afterEach(async () => {
      await stopProc(proc)
      await agent.stop()
    })

    for (const variant of Object.keys(variants)) {
      it(`is instrumented ${variant}`, async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'claude_agent_sdk.query'), true)
        })

        // Use a fresh HOME so the Claude CLI doesn't pick up a user-level ~/.claude.json (e.g. one that
        // configures an apiKeyHelper unavailable in CI, which would override the ANTHROPIC_API_KEY env).
        const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agent-sdk-home-'))
        proc = await spawnPluginIntegrationTestProcAndExpectExit(sandboxCwd(), variants[variant], agent.port, {
          NODE_OPTIONS: '--import dd-trace/initialize.mjs',
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '<not-a-real-key>',
          HOME: isolatedHome,
        })

        await res
      }).timeout(30000)
    }
  })
})
