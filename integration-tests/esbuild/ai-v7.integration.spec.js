'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const { FakeAgent, sandboxCwd, spawnProcAndExpectExit, useSandbox } = require('../helpers')
const { NODE_MAJOR } = require('../../version')

if (NODE_MAJOR < 22) return

describe('esbuild bundling AI SDK v7', () => {
  let agent
  let cwd

  useSandbox(['esbuild@0.28.0', 'ai@7.0.2', 'zod@4.1.8'], false, [__dirname])

  before(() => {
    cwd = sandboxCwd()
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(() => agent.stop())

  it('activates explicit AI tracing for a fully bundled SDK', async () => {
    const builder = path.join(cwd, 'esbuild', 'build-ai-v7.js')
    execFileSync(process.execPath, [builder], { cwd })

    const appFile = path.join(cwd, 'esbuild', 'ai-v7-out.cjs')
    const bundle = readFileSync(appFile, 'utf8')
    assert.match(bundle, /AI_SDK_TELEMETRY_TRACING_CHANNEL/, 'expected the AI SDK implementation in the bundle')
    assert.match(bundle, /require\("dd-trace"\)/, 'expected dd-trace to remain external')

    await Promise.all([
      agent.assertMessageReceived(({ payload }) => {
        const aiSpanNames = payload
          .flat(2)
          .filter(span => span.meta?.component === 'ai_tracing_vercel_telemetry')
          .map(span => span.name)
          .sort()

        assert.deepStrictEqual(aiSpanNames, ['generateText', 'languageModelCall', 'step'])
      }, 20_000),
      spawnProcAndExpectExit(appFile, {
        cwd,
        env: {
          ...process.env,
          DD_TRACE_AGENT_URL: `http://localhost:${agent.port}`,
          DD_TRACE_AI_ENABLED: 'true',
        },
      }),
    ])
  })
})
