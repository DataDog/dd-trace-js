'use strict'

const path = require('path')
const { spawn } = require('child_process')
const { describe, before, it } = require('mocha')
const { withVersions } = require('../../../setup/mocha')
const { useEnv } = require('../../../../../../integration-tests/helpers')
const { NODE_MAJOR } = require('../../../../../../version')

const {
  useLlmObs,
  assertLlmObsSpanEvent,
  MOCK_STRING,
} = require('../../util')

const FETCH_VCR_PROXY = path.join(__dirname, 'fetch-vcr-proxy.js')
const VCR_URL = 'http://127.0.0.1:9126/vcr/claude-agent-sdk'

if (NODE_MAJOR >= 22) {
  describe('Plugin', () => {
    useEnv({
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '<not-a-real-key>',
    })

    const { getEvents } = useLlmObs({ plugin: 'claude-agent-sdk' })

    withVersions('claude-agent-sdk', '@anthropic-ai/claude-agent-sdk', (version) => {
      let query

      before(async function () {
        this.timeout(10000)
        const modPath = `../../../../../../versions/@anthropic-ai/claude-agent-sdk@${version}`
        const sdk = await import(`${modPath}/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`)
        query = sdk.query
      })

      it('creates a session span from a real SDK query', async function () {
        this.timeout(30000)

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

        const { apmSpans, llmobsSpans } = await getEvents()

        assertLlmObsSpanEvent(llmobsSpans[0], {
          span: apmSpans[0],
          spanKind: 'agent',
          name: 'session',
          inputValue: MOCK_STRING,
          outputValue: MOCK_STRING,
          tags: { ml_app: 'test', integration: 'claude-agent-sdk' },
        })
      })
    })
  })
}
