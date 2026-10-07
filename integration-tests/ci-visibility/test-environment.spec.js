'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const yaml = require('yaml')

const { getCiVisAgentlessConfig, getCiVisEvpProxyConfig } = require('../helpers')

describe('test environment', () => {
  it('does not enable tracer telemetry in the Test Optimization workflow', () => {
    const workflowPath = path.join(__dirname, '../../.github/workflows/test-optimization.yml')
    const workflow = yaml.parse(fs.readFileSync(workflowPath, 'utf8'))

    assert.strictEqual(workflow.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED, 'false')
  })

  it('does not pass backend API keys to fake Test Optimization endpoints', () => {
    const originalApiKey = process.env.DD_API_KEY
    const originalAliasApiKey = process.env.DATADOG_API_KEY

    process.env.DD_API_KEY = 'real-api-key'
    process.env.DATADOG_API_KEY = 'real-alias-api-key'

    try {
      const agentlessConfig = getCiVisAgentlessConfig(1234)
      const evpProxyConfig = getCiVisEvpProxyConfig(1234)
      const printApiKeys = `process.stdout.write(JSON.stringify({
        DD_API_KEY: process.env.DD_API_KEY,
        DATADOG_API_KEY: process.env.DATADOG_API_KEY,
      }))`
      const evpProxyApiKeys = JSON.parse(execFileSync(process.execPath, ['--eval', printApiKeys], {
        encoding: 'utf8',
        env: { ...evpProxyConfig, NODE_OPTIONS: '' },
      }))
      const agentlessApiKeys = JSON.parse(execFileSync(process.execPath, ['--eval', printApiKeys], {
        encoding: 'utf8',
        env: { ...agentlessConfig, NODE_OPTIONS: '' },
      }))

      assert.deepStrictEqual(evpProxyApiKeys, {})
      assert.deepStrictEqual(agentlessApiKeys, { DD_API_KEY: '1' })
      assert.strictEqual(agentlessConfig.DD_API_KEY, '1')
      assert.strictEqual(agentlessConfig.DD_CIVISIBILITY_AGENTLESS_URL, 'http://127.0.0.1:1234')
      assert.strictEqual(evpProxyConfig.DD_TRACE_AGENT_PORT, '1234')
    } finally {
      if (originalApiKey === undefined) {
        delete process.env.DD_API_KEY
      } else {
        process.env.DD_API_KEY = originalApiKey
      }
      if (originalAliasApiKey === undefined) {
        delete process.env.DATADOG_API_KEY
      } else {
        process.env.DATADOG_API_KEY = originalAliasApiKey
      }
    }
  })
})
