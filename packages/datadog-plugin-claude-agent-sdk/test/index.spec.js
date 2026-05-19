'use strict'

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { channel, tracingChannel } = require('dc-polyfill')
const { describe, before, after, it } = require('mocha')

const { withVersions } = require('../../dd-trace/test/setup/mocha')
const { useEnv } = require('../../../integration-tests/helpers')
const { NODE_MAJOR } = require('../../../version')
const agent = require('../../dd-trace/test/plugins/agent')
const plugins = require('../../dd-trace/src/plugins')
const {
  createFakeClaudeCodeProcess,
} = require('../../dd-trace/test/llmobs/plugins/claude-agent-sdk/fake-claude-code-process')
const { rewrite } = require('../../datadog-instrumentations/src/helpers/rewriter')

function publishClaudeAgentSdkLoad () {
  channel('dd-trace:instrumentation:load').publish({ name: '@anthropic-ai/claude-agent-sdk' })
}

function publishQueryStart (queryArg) {
  const ctx = { arguments: queryArg ? [queryArg] : [] }
  tracingChannel('orchestrion:@anthropic-ai/claude-agent-sdk:query').start.publish(ctx)
  return ctx
}

function assertTraceIncludesSpan (traces, spanName, message) {
  assert.ok(
    traces.some(trace => trace.some(span => span.name === spanName)),
    message
  )
}

function createUserHooks () {
  return {
    SessionStart: [{
      hooks: [async () => ({})],
    }],
    Notification: [{
      hooks: [async () => ({})],
    }],
  }
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
    describe('claude-agent-sdk', () => {
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
      })

      withVersions('claude-agent-sdk', '@anthropic-ai/claude-agent-sdk', '0.2.98', (version) => {
        let cliPath
        let query
        let shimDir

        before(async function () {
          this.timeout(10000)
          await agent.load('claude-agent-sdk')
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

        it('creates a turn span', async function () {
          this.timeout(30000)

          const tracesPromises = [
            agent.assertSomeTraces(traces => {
              assertTraceIncludesSpan(traces, 'turn', 'should have a turn span')
            }),
            agent.assertSomeTraces(traces => {
              assertTraceIncludesSpan(traces, 'Read', 'should have a successful tool span')
            }),
            agent.assertSomeTraces(traces => {
              assertTraceIncludesSpan(traces, 'Write', 'should have a failed tool span')
            }),
            agent.assertSomeTraces(traces => {
              assertTraceIncludesSpan(traces, 'subagent-search', 'should have a subagent span')
            }),
          ]

          const abortController = new AbortController()
          const timeout = setTimeout(() => abortController.abort(), 15000)

          try {
            for await (const msg of query({
              prompt: 'Say hello',
              options: {
                maxTurns: 1,
                model: 'anthropic/claude-3-5-sonnet-20241022',
                abortController,
                hooks: createUserHooks(),
                pathToClaudeCodeExecutable: cliPath,
                spawnClaudeCodeProcess: () => createFakeClaudeCodeProcess({ exerciseEdgeHooks: true }),
              },
            })) {
              if (msg.type === 'result') break
            }
          } finally {
            clearTimeout(timeout)
          }

          await Promise.all(tracesPromises)
        })

        it('finishes pending spans when the session ends', async function () {
          this.timeout(30000)

          const tracesPromises = [
            agent.assertSomeTraces(traces => {
              assertTraceIncludesSpan(traces, 'turn', 'should have a turn span')
            }),
            agent.assertSomeTraces(traces => {
              assertTraceIncludesSpan(traces, 'Read', 'should have a pending tool span')
            }),
            agent.assertSomeTraces(traces => {
              assertTraceIncludesSpan(traces, 'subagent-search', 'should have a pending subagent span')
            }),
          ]

          const abortController = new AbortController()
          const timeout = setTimeout(() => abortController.abort(), 15000)

          try {
            for await (const msg of query({
              prompt: 'Leave spans pending',
              options: {
                maxTurns: 1,
                model: 'anthropic/claude-3-5-sonnet-20241022',
                abortController,
                pathToClaudeCodeExecutable: cliPath,
                spawnClaudeCodeProcess: () => createFakeClaudeCodeProcess({
                  leavePendingSpans: true,
                  skipSessionStart: true,
                }),
              },
            })) {
              if (msg.type === 'result') break
            }
          } finally {
            clearTimeout(timeout)
          }

          await Promise.all(tracesPromises)
        })

        it('registers both plugin names', () => {
          assert.strictEqual(
            plugins['@anthropic-ai/claude-agent-sdk'],
            plugins['claude-agent-sdk']
          )
        })

        it('handles query arguments without SDK options', () => {
          const ctx = publishQueryStart({ prompt: {} })

          assert.equal(ctx._sessionCtx.prompt, '[async iterable]')
          assert.ok(ctx.arguments[0].options.hooks.SessionStart)

          const emptyCtx = publishQueryStart()
          assert.deepStrictEqual(emptyCtx.arguments, [])
        })
      })
    })
  })
}
