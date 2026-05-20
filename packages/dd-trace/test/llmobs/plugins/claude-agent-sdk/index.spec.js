'use strict'

const assert = require('node:assert')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const { channel, tracingChannel } = require('dc-polyfill')
const { describe, before, after, it } = require('mocha')

const { withVersions } = require('../../../setup/mocha')
const { useEnv } = require('../../../../../../integration-tests/helpers')
const { NODE_MAJOR } = require('../../../../../../version')
const { rewrite } = require('../../../../../datadog-instrumentations/src/helpers/rewriter')
const agent = require('../../../plugins/agent')
const { createFakeClaudeCodeProcess } = require('./fake-claude-code-process')

const FETCH_VCR_PROXY = path.join(__dirname, 'fetch-vcr-proxy.js')
const VCR_URL = 'http://127.0.0.1:9126/vcr/claude-agent-sdk'

function publishClaudeAgentSdkLoad () {
  channel('dd-trace:instrumentation:load').publish({ name: '@anthropic-ai/claude-agent-sdk' })
}

function publishQueryStart (queryArg) {
  const ctx = { arguments: queryArg ? [queryArg] : [] }
  tracingChannel('orchestrion:@anthropic-ai/claude-agent-sdk:query').start.publish(ctx)
  return ctx
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

function spawnClaudeCodeProcessWithVcr (opts) {
  const nodeOptions = opts.env.NODE_OPTIONS
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-claude-config-'))
  const env = {
    ...opts.env,
    ANTHROPIC_API_KEY: '<not-a-real-key>',
    ANTHROPIC_AUTH_TOKEN: '',
    ANTHROPIC_BASE_URL: VCR_URL,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_ENABLE_TELEMETRY: '0',
    CLAUDE_CONFIG_DIR: configDir,
    DISABLE_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
    NODE_OPTIONS: nodeOptions ? `${nodeOptions} --require ${FETCH_VCR_PROXY}` : `--require ${FETCH_VCR_PROXY}`,
    _VCR_PROXY_URL: VCR_URL,
  }
  delete env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST

  const proc = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: opts.signal,
    windowsHide: true,
  })

  proc.stdin.on('error', () => {})
  proc.once('exit', () => fs.rmSync(configDir, { recursive: true, force: true }))

  if (opts.env.DEBUG_CLAUDE_AGENT_SDK) {
    proc.stderr.on('data', chunk => process.stderr.write(chunk))
  }

  return {
    stdin: proc.stdin,
    stdout: proc.stdout,
    get killed () { return proc.killed },
    get exitCode () { return proc.exitCode },
    kill: proc.kill.bind(proc),
    on: proc.on.bind(proc),
    once: proc.once.bind(proc),
    off: proc.off.bind(proc),
  }
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

        it('creates an LLM Obs turn span through the SDK CLI with VCR', async function () {
          this.timeout(30000)

          const tracesPromise = agent.assertSomeTraces(traces => {
            const spans = traces[0]
            const turnSpan = spans.find(s => s.name === 'turn')
            assert.ok(turnSpan, 'should have a turn span')
          })

          const abortController = new AbortController()
          const timeout = setTimeout(() => abortController.abort(), 15000)
          let result

          try {
            for await (const msg of query({
              prompt: 'Say hello',
              options: {
                maxTurns: 1,
                model: 'anthropic/claude-3-5-sonnet-20241022',
                settingSources: [],
                abortController,
                pathToClaudeCodeExecutable: cliPath,
                spawnClaudeCodeProcess: spawnClaudeCodeProcessWithVcr,
              },
            })) {
              if (msg.type === 'result') {
                result = msg.result
                break
              }
            }
          } finally {
            clearTimeout(timeout)
          }

          assert.equal(result, 'Hello!', 'should replay the stored VCR cassette response')

          await tracesPromise

          // Wait for LLM Obs span processor to flush
          await new Promise(resolve => setTimeout(resolve, 1000))

          const reqs = agent.getLlmObsSpanEventsRequests()
          const spans = reqs.flatMap(r => r).map(r => r.spans[0]).filter(Boolean)
          const turnSpan = spans.find(s => s.name === 'turn')

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
        })

        it('creates LLM Obs tool and subagent spans from Claude hooks', async function () {
          this.timeout(30000)

          const tracesPromise = agent.assertSomeTraces(traces => {
            const spans = traces[0]
            const toolSpan = spans.find(s => s.name === 'Read')
            assert.ok(toolSpan, 'should have a tool span')
          })

          const abortController = new AbortController()
          const timeout = setTimeout(() => abortController.abort(), 15000)

          try {
            for await (const msg of query({
              prompt: 'Exercise hooks',
              options: {
                maxTurns: 1,
                model: 'anthropic/claude-3-5-sonnet-20241022',
                abortController,
                pathToClaudeCodeExecutable: cliPath,
                spawnClaudeCodeProcess: () => createFakeClaudeCodeProcess({ exerciseEdgeHooks: true }),
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
          const successfulToolSpan = spans.find(s => s.name === 'Read')
          const failedToolSpan = spans.find(s => s.name === 'Write')
          const subagentSpan = spans.find(s => s.name === 'subagent-search')

          assert.ok(successfulToolSpan, 'should have an LLM Obs successful tool span event')
          assert.equal(successfulToolSpan.meta['span.kind'], 'tool', 'should be a tool span')
          assert.ok(failedToolSpan, 'should have an LLM Obs failed tool span event')
          assert.equal(failedToolSpan.meta['span.kind'], 'tool', 'should be a tool span')
          assert.ok(subagentSpan, 'should have an LLM Obs subagent span event')
          assert.equal(subagentSpan.meta['span.kind'], 'agent', 'should be an agent span')
        })

        it('handles query hook edge cases', () => {
          const notificationHook = () => ({})
          const ctx = publishQueryStart({
            prompt: {},
            options: {
              hooks: {
                Notification: [{
                  hooks: [notificationHook],
                }],
              },
            },
          })
          const hooks = ctx.arguments[0].options.hooks

          assert.equal(ctx._sessionCtx.prompt, '[async iterable]')
          assert.ok(hooks.SessionStart)
          assert.equal(hooks.Notification[0].hooks[0], notificationHook)

          hooks.UserPromptSubmit[0].hooks[0]({
            session_id: 'manual-session',
            prompt: 'manual prompt',
          })
          hooks.PreToolUse[0].hooks[0]({
            session_id: 'manual-session',
            tool_name: 'Read',
            tool_input: { file_path: 'README.md' },
            tool_use_id: 'manual-tool',
          })
          hooks.SubagentStart[0].hooks[0]({
            session_id: 'manual-session',
            agent_id: 'manual-agent',
            agent_type: 'search',
          })
          hooks.SessionEnd[0].hooks[0]({
            session_id: 'manual-session',
            reason: 'manual',
          })
          hooks.SessionEnd[0].hooks[0]({
            session_id: 'manual-session',
            reason: 'manual',
          })

          const defaultOptionsCtx = publishQueryStart({ prompt: 'default options' })
          assert.ok(defaultOptionsCtx.arguments[0].options.hooks.SessionStart)

          const emptyCtx = publishQueryStart()
          assert.deepStrictEqual(emptyCtx.arguments, [])
        })
      })
    })
  })
}
