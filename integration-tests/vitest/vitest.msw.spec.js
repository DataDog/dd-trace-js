'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')

const {
  sandboxCwd,
  useSandbox,
  getCiVisEvpProxyConfig,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')

describe('vitest@3.2.6 with msw@2.14.6', () => {
  let cwd, receiver, childProcess, testOutput

  useSandbox([
    'vitest@3.2.6',
    'msw@2.14.6',
    'tinypool',
  ], true)

  before(() => {
    cwd = sandboxCwd()
  })

  beforeEach(async () => {
    testOutput = ''
    receiver = await new FakeCiVisIntake().start()
  })

  afterEach(async () => {
    childProcess?.kill()
    await receiver?.stop()
  })

  it('does not fail while formatting telemetry logs from loader diagnostics', async () => {
    childProcess = exec(
      './node_modules/.bin/vitest run',
      {
        cwd,
        env: {
          ...getCiVisEvpProxyConfig(receiver.port),
          DD_TRACE_AGENT_PORT: String(receiver.port),
          DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'true',
          DD_TELEMETRY_LOG_COLLECTION_ENABLED: 'true',
          NODE_OPTIONS: '-r dd-trace/ci/init.js --import dd-trace/initialize.mjs',
          TEST_DIR: 'ci-visibility/vitest-tests/msw-import.mjs',
        },
      }
    )

    childProcess.stdout.on('data', data => { testOutput += data })
    childProcess.stderr.on('data', data => { testOutput += data })

    const [code, signal] = await once(childProcess, 'exit')

    assert.strictEqual(signal, null, testOutput)
    assert.strictEqual(code, 0, testOutput)
    assert.doesNotMatch(testOutput, /Unexpected token.*is not valid JSON/, testOutput)
  })
})
