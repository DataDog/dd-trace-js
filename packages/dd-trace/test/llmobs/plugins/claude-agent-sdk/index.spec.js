'use strict'

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { channel } = require('dc-polyfill')
const { describe, before, after, it } = require('mocha')

const { withVersions } = require('../../../setup/mocha')
const { useEnv } = require('../../../../../../integration-tests/helpers')
const { NODE_MAJOR } = require('../../../../../../version')
const { rewrite } = require('../../../../../datadog-instrumentations/src/helpers/rewriter')
const agent = require('../../../plugins/agent')
const { createFakeClaudeCodeProcess } = require('./fake-claude-code-process')

function publishClaudeAgentSdkLoad () {
  channel('dd-trace:instrumentation:load').publish({ name: '@anthropic-ai/claude-agent-sdk' })
}

function createSdkImportShim () {
  const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk')
  const sdkDir = findSdkPackageDir(sdkEntry)
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-claude-agent-sdk-'))
  const transformedPath = path.join(shimDir, 'sdk.mjs')
  const transformedSource = rewrite(fs.readFileSync(sdkEntry, 'utf8'), sdkEntry, 'module')

  fs.writeFileSync(transformedPath, transformedSource)

  const shimPath = path.join(shimDir, 'load.mjs')
  fs.writeFileSync(shimPath, `export { query } from ${JSON.stringify(pathToFileURL(transformedPath).href)}\n`)

  return {
    cliPath: path.join(sdkDir, 'cli.js'),
    moduleUrl: pathToFileURL(shimPath).href,
    shimDir,
  }
}

function findSdkPackageDir (entry) {
  let dir = path.dirname(entry)
  let parent = path.dirname(dir)

  while (dir !== parent) {
    const packageJsonPath = path.join(dir, 'package.json')
    if (fs.existsSync(packageJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
      if (pkg.name === '@anthropic-ai/claude-agent-sdk') return dir
    }

    dir = parent
    parent = path.dirname(dir)
  }

  throw new Error(`Unable to find @anthropic-ai/claude-agent-sdk package root from ${entry}`)
}

if (NODE_MAJOR >= 22) {
  describe('Plugin', () => {
    describe('claude-agent-sdk (LLM Obs)', () => {
      // Clear OTEL exporter env vars so dd-trace uses the agent exporter
      // (sends to /v0.4/traces) instead of OTLP (which the mock agent
      // does not handle).
      const otelVarsToReset = {}
      before(() => {
        for (const key of Object.keys(process.env)) {
          if (key.startsWith('OTEL_')) {
            otelVarsToReset[key] = process.env[key]
            delete process.env[key]
          }
        }
      })
      after(() => {
        for (const [key, val] of Object.entries(otelVarsToReset)) {
          process.env[key] = val
        }
      })

      useEnv({
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '<not-a-real-key>',
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: 'true',
        _DD_LLMOBS_FLUSH_INTERVAL: '0',
      })

      withVersions('claude-agent-sdk', '@anthropic-ai/claude-agent-sdk', '0.2.98', (version) => {
        let cliPath
        let query
        let shimDir

        before(async function () {
          this.timeout(10000)
          await agent.load('claude-agent-sdk', {}, {
            llmobs: {
              mlApp: 'test',
              agentlessEnabled: false,
            },
          })
          publishClaudeAgentSdkLoad()
          const shim = createSdkImportShim()
          cliPath = shim.cliPath
          shimDir = shim.shimDir
          const moduleUrl = shim.moduleUrl
          query = (await import(moduleUrl)).query
        })

        after(() => {
          if (shimDir) fs.rmSync(shimDir, { recursive: true, force: true })
          return agent.close({ ritmReset: false })
        })

        it('creates an LLM Obs session span', async function () {
          this.timeout(30000)

          const tracesPromise = agent.assertSomeTraces(traces => {
            const spans = traces[0]
            const turnSpan = spans.find(s => s.name === 'turn')
            assert.ok(turnSpan, 'should have a turn span')
          })

          const abortController = new AbortController()
          const timeout = setTimeout(() => abortController.abort(), 15000)

          try {
            for await (const msg of query({
              prompt: 'Say hello',
              options: {
                maxTurns: 1,
                model: 'anthropic/claude-3-5-sonnet-20241022',
                abortController,
                pathToClaudeCodeExecutable: cliPath,
                spawnClaudeCodeProcess: createFakeClaudeCodeProcess,
              },
            })) {
              if (msg.type === 'result') break
            }
          } finally {
            clearTimeout(timeout)
          }

          await tracesPromise

          // Wait for LLM Obs span processor to flush
          await new Promise(resolve => setTimeout(resolve, 1000))

          const reqs = agent.getLlmObsSpanEventsRequests()
          const spans = reqs.flatMap(r => r).map(r => r.spans[0]).filter(Boolean)
          const turnSpan = spans.find(s => s.name === 'turn')
          const successfulToolSpan = spans.find(s => s.name === 'Read')
          const failedToolSpan = spans.find(s => s.name === 'Write')
          const subagentSpan = spans.find(s => s.name === 'subagent-search')

          assert.ok(turnSpan, 'should have an LLM Obs turn span event')
          assert.equal(turnSpan.meta['span.kind'], 'agent', 'should be an agent span')
          assert.ok(turnSpan.meta.input, 'should have input metadata')
          assert.ok(
            turnSpan.tags.some(t => t.startsWith('ml_app:')),
            'should have ml_app tag'
          )
          assert.ok(
            turnSpan.tags.some(t => t.includes('integration:claude-agent-sdk')),
            'should have integration tag'
          )

          assert.ok(successfulToolSpan, 'should have an LLM Obs successful tool span event')
          assert.equal(successfulToolSpan.meta['span.kind'], 'tool', 'should be a tool span')
          assert.ok(failedToolSpan, 'should have an LLM Obs failed tool span event')
          assert.equal(failedToolSpan.meta['span.kind'], 'tool', 'should be a tool span')
          assert.ok(subagentSpan, 'should have an LLM Obs subagent span event')
          assert.equal(subagentSpan.meta['span.kind'], 'agent', 'should be an agent span')
        })
      })
    })
  })
}
