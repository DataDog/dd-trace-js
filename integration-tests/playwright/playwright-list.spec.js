'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')

const {
  createParallelIt,
  getCiVisAgentlessConfig,
  sandboxCwd,
  useSandbox,
} = require('../helpers')
const { getLatestPlaywrightSpecifier, oldest } = require('./versions')

const latest = getLatestPlaywrightSpecifier()
const versions = [oldest, '1.55.1', '1.60.0', latest]

for (const version of versions) {
  if (process.env.PLAYWRIGHT_VERSION === 'oldest' && version !== oldest) continue
  if (process.env.PLAYWRIGHT_VERSION === 'latest' && version !== latest) continue

  describe(`playwright@${version} test listing`, function () {
    const it = createParallelIt(global.it, { withReceiver: true })

    this.timeout(60000)
    useSandbox([`@playwright/test@${version}`])

    for (const [name, args, exitCode] of [
      ['lists matching tests', '--list --reporter=json --grep-invert @excluded', 0],
      ['preserves listing errors', '--list --reporter=json --grep nonexistent-test-name', 1],
      ['runs tests with the list reporter', '--reporter=list', 0],
    ]) {
      it(name, async (receiver, run) => {
        let output = ''
        const events = []
        receiver.on('message', ({ url, payload }) => {
          if (url.endsWith('/api/v2/citestcycle')) events.push(...payload.events)
        })
        const proc = run(`./node_modules/.bin/playwright test -c playwright.config.js ${args}`, {
          cwd: sandboxCwd(),
          env: {
            ...getCiVisAgentlessConfig(receiver.port),
            TEST_DIR: './ci-visibility/playwright-tests-request-error-tag',
          },
        })
        proc.stdout?.on('data', chunk => { output += chunk.toString() })
        proc.stderr?.on('data', chunk => { output += chunk.toString() })
        const [actualExitCode] = await once(proc, 'close')
        assert.deepStrictEqual(
          events.filter(event => event.type.startsWith('test')).map(event => ({
            type: event.type,
            status: event.content.meta['test.status'],
          })).sort((a, b) => a.type.localeCompare(b.type)),
          args.startsWith('--list')
            ? []
            : ['test', 'test_module_end', 'test_session_end', 'test_suite_end'].map(type => ({ type, status: 'pass' }))
        )
        assert.strictEqual(actualExitCode, exitCode, output)
        if (args.startsWith('--list')) {
          const report = JSON.parse(output)
          if (exitCode === 0) {
            assert.strictEqual(report.suites[0].specs[0].title, 'should report request error tags')
            assert.deepStrictEqual(report.suites[0].specs[0].tests[0].results, [])
          } else {
            assert.match(report.errors[0].message, /No tests found/)
          }
        } else {
          assert.match(output, /1 passed/)
        }
      })
    }
  })
}
