'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const path = require('node:path')
const { promisify } = require('node:util')

const { FakeCiVisIntake } = require('./ci-visibility-intake')
const { sandboxCwd, useSandbox } = require('./helpers')

const execFileAsync = promisify(execFile)

describe('automatic log submission', () => {
  let receiver

  useSandbox(['bunyan'], true)

  beforeEach(async () => {
    receiver = await new FakeCiVisIntake().start()
  })

  afterEach(() => receiver.stop())

  it('submits logs through the regular tracer entry point', async () => {
    const logsPromise = receiver.gatherPayloadsMaxTimeout(
      ({ url }) => url.includes('/api/v2/logs'),
      (payloads) => {
        assert.strictEqual(payloads.length, 1)
        assert.strictEqual(payloads[0].headers['dd-api-key'], 'test-api-key')
        assert.strictEqual(payloads[0].url, '/api/v2/logs?ddsource=bunyan&service=my-service')
        assert.strictEqual(payloads[0].logMessage.length, 1)
        assert.strictEqual(payloads[0].logMessage[0].msg, 'Hello automatic log submission!')
      }
    )
    const fixture = path.join(sandboxCwd(), 'fixtures/automatic-log-submission/bunyan.js')

    await Promise.all([
      execFileAsync(process.execPath, ['--require', 'dd-trace/init', fixture], {
        cwd: sandboxCwd(),
        env: {
          ...process.env,
          DD_AGENTLESS_ENABLED: 'true',
          DD_AGENTLESS_LOG_SUBMISSION_URL: `http://127.0.0.1:${receiver.port}`,
          DD_API_KEY: 'test-api-key',
          DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
          DD_LOGS_OTEL_ENABLED: 'false',
          DD_REMOTE_CONFIGURATION_ENABLED: 'false',
          DD_SERVICE: 'my-service',
          DD_TRACE_STARTUP_LOGS: 'false',
          OTEL_TRACES_EXPORTER: 'none',
        },
      }),
      logsPromise,
    ])
  })
})
