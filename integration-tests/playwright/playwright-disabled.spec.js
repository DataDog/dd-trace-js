'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const path = require('node:path')

const { sandboxCwd, useSandbox } = require('../helpers')
const { getLatestPlaywrightSpecifier, oldest } = require('./versions')

const latest = getLatestPlaywrightSpecifier()

for (const version of [oldest, latest]) {
  if (process.env.PLAYWRIGHT_VERSION === 'oldest' && version !== oldest) continue
  if (process.env.PLAYWRIGHT_VERSION === 'latest' && version !== latest) continue

  describe(`playwright@${version} with Test Optimization disabled`, function () {
    this.timeout(30000)

    useSandbox([`@playwright/test@${version}`], false, [])

    before(() => {
      writeFileSync(path.join(sandboxCwd(), 'playwright.config.js'), `
        module.exports = { testMatch: 'disabled-test.js', reporter: 'list', workers: 1 }
      `)
      writeFileSync(path.join(sandboxCwd(), 'disabled-test.js'), `
        const { test, expect } = require('@playwright/test')
        test('executes the test body', () => {
          console.log('PLAYWRIGHT_TEST_EXECUTED')
          expect(process.env.TEST_SHOULD_FAIL).toBe('false')
        })
      `)
    })

    for (const [reason, configuration] of [
      ['missing API key', { DD_CIVISIBILITY_AGENTLESS_ENABLED: 'true' }],
      ['Test Optimization disabled', { DD_CIVISIBILITY_ENABLED: 'false' }],
      ['tracing disabled', { DD_TRACE_ENABLED: 'false' }],
      ['tracer only required', { NODE_OPTIONS: '-r dd-trace' }],
    ]) {
      for (const shouldFail of [false, true]) {
        it(`runs a ${shouldFail ? 'failing' : 'passing'} test with ${reason}`, () => {
          const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test'], {
            cwd: sandboxCwd(),
            encoding: 'utf8',
            timeout: 20000,
            env: {
              ...process.env,
              DD_API_KEY: '',
              DATADOG_API_KEY: '',
              DD_AGENTLESS_ENABLED: 'false',
              DD_CIVISIBILITY_AGENTLESS_ENABLED: 'false',
              DD_CIVISIBILITY_ENABLED: 'true',
              DD_TRACE_ENABLED: 'true',
              DD_TRACE_DEBUG: 'true',
              DD_INSTRUMENTATION_TELEMETRY_ENABLED: 'false',
              DD_REMOTE_CONFIGURATION_ENABLED: 'false',
              DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: 'false',
              NODE_OPTIONS: '-r dd-trace/ci/init',
              TEST_SHOULD_FAIL: String(shouldFail),
              ...configuration,
            },
          })
          const output = result.stdout + result.stderr

          assert.ifError(result.error)
          assert.strictEqual(result.status, shouldFail ? 1 : 0, output)
          assert.match(output, /PLAYWRIGHT_TEST_EXECUTED/)
          assert.match(output, shouldFail ? /1 failed/ : /1 passed/)
          assert.doesNotMatch(output, /Playwright session start error/)
        })
      }
    }
  })
}
