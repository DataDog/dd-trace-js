'use strict'

const assert = require('node:assert')
const path = require('path')
const { spawn } = require('child_process')
const { describe, before, after, it } = require('mocha')
const { withVersions } = require('../../../setup/mocha')
const { useEnv } = require('../../../../../../integration-tests/helpers')
const { NODE_MAJOR } = require('../../../../../../version')
const agent = require('../../../plugins/agent')

const FETCH_VCR_PROXY = path.join(__dirname, 'fetch-vcr-proxy.js')
const VCR_URL = 'http://127.0.0.1:9126/vcr/claude-agent-sdk'

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

      withVersions('claude-agent-sdk', '@anthropic-ai/claude-agent-sdk', '>=0.2.1', (version) => {
        let query

        before(async function () {
          this.timeout(10000)
          await agent.load('claude-agent-sdk', {}, {
            llmobs: {
              mlApp: 'test',
              agentlessEnabled: false,
            },
          })
          query = require('@anthropic-ai/claude-agent-sdk').query
        })

        after(() => agent.close({ ritmReset: false }))

        it('creates an LLM Obs session span', async function () {
          this.timeout(30000)

          const tracesPromise = agent.assertSomeTraces(traces => {
            const spans = traces[0]
            const sessionSpan = spans.find(s => s.name === 'session')
            assert.ok(sessionSpan, 'should have a session span')
          })

          const abortController = new AbortController()
          const timeout = setTimeout(() => abortController.abort(), 15000)

          try {
            for await (const msg of query({
              prompt: 'Say hello',
              options: {
                maxTurns: 1,
                abortController,
                spawnClaudeCodeProcess (opts) {
                  const env = {
                    ...opts.env,
                    NODE_OPTIONS: `--require ${FETCH_VCR_PROXY}`,
                    _VCR_PROXY_URL: VCR_URL,
                  }
                  const proc = spawn(opts.command, opts.args, {
                    cwd: opts.cwd,
                    env,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    signal: opts.signal,
                    windowsHide: true,
                  })
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
                },
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
          const sessionSpan = spans.find(s => s.name === 'session')

          assert.ok(sessionSpan, 'should have an LLM Obs session span event')
          assert.equal(sessionSpan.meta['span.kind'], 'agent', 'should be an agent span')
          assert.ok(sessionSpan.meta.input, 'should have input metadata')
          assert.ok(
            sessionSpan.tags.some(t => t.startsWith('ml_app:')),
            'should have ml_app tag'
          )
          assert.ok(
            sessionSpan.tags.some(t => t.includes('integration:claude-agent-sdk')),
            'should have integration tag'
          )
        })
      })
    })
  })
}
