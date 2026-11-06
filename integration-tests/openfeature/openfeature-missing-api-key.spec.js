'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const path = require('node:path')
const { setTimeout: sleep } = require('node:timers/promises')
const { after, afterEach, before, describe, it } = require('mocha')

const { FakeAgent, sandboxCwd, spawnProc, stopProc, useSandbox } = require('../helpers')

// Far below the initialization timeout, so a provider that waits for the timeout fails the command.
const COMMAND_TIMEOUT_MS = 5000
const INITIALIZATION_TIMEOUT_MS = 60_000
const DEFAULT_VALUE = 'missing-api-key-default'
const MISSING_API_KEY_MESSAGE = 'DD_API_KEY is required for the default Datadog Feature Flagging endpoint'
const DIAGNOSTIC = `DATADOG TRACER DIAGNOSTIC - Feature Flags: ${MISSING_API_KEY_MESSAGE}`

describe('OpenFeature agentless configuration without an API key', () => {
  let agent
  let appFile
  let cwd
  let output
  let proc

  useSandbox(
    ['@openfeature/server-sdk', '@openfeature/core'],
    false,
    [path.join(__dirname, 'app')]
  )

  before(async () => {
    cwd = sandboxCwd()
    appFile = path.join(cwd, 'app', 'configuration-source-evaluation.js')
    agent = await new FakeAgent().start()
  })

  after(async () => {
    await agent?.stop()
  })

  afterEach(async () => {
    await stopProc(proc)
  })

  /**
   * @param {Record<string, string>} env
   */
  async function start (env) {
    output = ''
    /** @param {Buffer} data */
    const record = data => { output += data.toString() }
    proc = await spawnProc(appFile, {
      cwd,
      env: {
        DD_EXPERIMENTAL_FLAGGING_PROVIDER_INITIALIZATION_TIMEOUT_MS: String(INITIALIZATION_TIMEOUT_MS),
        DD_FEATURE_FLAGS_CONFIGURATION_SOURCE: 'agentless',
        DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
        DD_TRACE_AGENT_HOSTNAME: '127.0.0.1',
        DD_TRACE_AGENT_PORT: String(agent.port),
        TEST_DEFAULT_VALUE: DEFAULT_VALUE,
        TEST_FLAG_KEY: 'missing-api-key-flag',
        TEST_SERVICE: 'openfeature-missing-api-key',
        TEST_TARGETING_KEY: 'user',
        ...env,
      },
      silent: true,
    }, record, record)
  }

  it('fails initialization at once and writes the cause without debug logging', async () => {
    await start({})

    await assert.rejects(
      sendCommand(proc, { command: 'access', waitForReady: true }),
      { message: new RegExp(`^Error: ${MISSING_API_KEY_MESSAGE}`) }
    )
    const { details } = await sendCommand(proc, { command: 'evaluate' })

    assert.strictEqual(details.value, DEFAULT_VALUE)
    assert.strictEqual(details.reason, 'ERROR')
    await waitForOutput(DIAGNOSTIC)
  })

  it('does not write the diagnostic when startup logs are disabled', async () => {
    await start({ DD_TRACE_STARTUP_LOGS: 'false' })

    await assert.rejects(
      sendCommand(proc, { command: 'access', waitForReady: true }),
      { message: new RegExp(`^Error: ${MISSING_API_KEY_MESSAGE}`) }
    )
    // Output pipes and IPC are separate channels, so read the output only once the child has closed them.
    const closed = once(proc, 'close')
    await stopProc(proc)
    await closed

    assert.ok(!output.includes(DIAGNOSTIC), output)
  })

  /**
   * @param {string} text
   */
  async function waitForOutput (text) {
    const deadline = Date.now() + COMMAND_TIMEOUT_MS
    while (!output.includes(text)) {
      if (Date.now() > deadline) assert.fail(`Timed out waiting for ${JSON.stringify(text)} in:\n${output}`)
      await sleep(10)
    }
  }
})

/**
 * @param {import('node:child_process').ChildProcess} child
 * @param {{ command: 'access'|'evaluate', waitForReady?: boolean }} command
 */
async function sendCommand (child, command) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS)
  try {
    const response = once(child, 'message', { signal: controller.signal })
    child.send(command)
    const [message] = await response
    if (message.error) throw new Error(message.error)
    return message
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Timed out waiting for child command ${command.command}`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
