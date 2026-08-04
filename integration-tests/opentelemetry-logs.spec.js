'use strict'

const assert = require('node:assert/strict')

const { fork } = require('child_process')
const { join } = require('path')
const { assertObjectContains, FakeAgent, sandboxCwd, useSandbox } = require('./helpers')

/**
 * @param {FakeAgent} agent
 * @param {number} timeout
 * @returns {Promise<{ headers: Record<string, string>, payload: object }>}
 */
function waitForOtlpLogs (agent, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for OTLP logs')), timeout)
    agent.once('otlp-logs', (msg) => {
      clearTimeout(timer)
      resolve(msg)
    })
  })
}

describe('OTLP Log Export', () => {
  let agent
  let cwd
  const timeout = 10000

  useSandbox(['@opentelemetry/api-logs', '@opentelemetry/api'])

  before(async () => {
    cwd = sandboxCwd()
    agent = await new FakeAgent().start()
  })

  after(async () => {
    await agent.stop()
  })

  it('should export logs in OTLP JSON format via dd-trace', async () => {
    const logsPromise = waitForOtlpLogs(agent, timeout)

    const proc = fork(join(cwd, 'opentelemetry/otlp-logs.js'), {
      cwd,
      env: {
        DD_TRACE_AGENT_PORT: agent.port,
        DD_LOGS_OTEL_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${agent.port}/v1/logs`,
        // Flush both records in one batch so a single waitForOtlpLogs() sees them.
        OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '2',
        DD_SERVICE: 'otlp-logs-test-service',
        DD_ENV: 'test',
        DD_VERSION: '1.0.0',
      },
    })

    const exitPromise = /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Process timed out')), timeout)
      proc.on('error', reject)
      proc.on('exit', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          reject(new Error(`Process exited with status code ${code}`))
        } else {
          resolve()
        }
      })
    }))

    const [{ headers, payload }] = await Promise.all([logsPromise, exitPromise])

    // dd-trace serializes traceId/spanId as Buffer even under http/json, so the JSON parser
    // re-hydrates them as `{ type: 'Buffer', data: [...] }`.
    const traceIdBytes = Array.from(Buffer.from('1234567890abcdef1234567890abcdef', 'hex'))
    const spanIdBytes = Array.from(Buffer.from('1234567890abcdef', 'hex'))

    assertObjectContains({ headers, payload }, {
      headers: { 'content-type': 'application/json' },
      payload: {
        resourceLogs: [{
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'otlp-logs-test-service' } },
              { key: 'service.version', value: { stringValue: '1.0.0' } },
              { key: 'deployment.environment', value: { stringValue: 'test' } },
            ],
          },
          scopeLogs: [{
            scope: { name: 'otlp-logs-test', version: '1.0.0' },
            schemaUrl: 'https://opentelemetry.io/schemas/1.27.0',
            logRecords: [
              {
                severityText: 'INFO',
                body: { stringValue: 'plain message' },
                attributes: [{ key: 'test.key', value: { stringValue: 'test.value' } }],
              },
              {
                severityText: 'ERROR',
                severityNumber: 17,
                body: { stringValue: 'correlated error message' },
                traceId: { type: 'Buffer', data: traceIdBytes },
                spanId: { type: 'Buffer', data: spanIdBytes },
              },
            ],
          }],
        }],
      },
    })

    assert.strictEqual(payload.resourceLogs[0].scopeLogs[0].logRecords.length, 2)
  })
})
