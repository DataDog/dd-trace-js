'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')

const { useSandbox, sandboxCwd, getCiVisAgentlessConfig } = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { getLatestPlaywrightSpecifier } = require('../playwright/versions')

describe('known-flakes Playwright project retries', () => {
  const requested = process.env.PLAYWRIGHT_VERSION || 'latest'
  // The known-flake root-suite hook is available from Playwright 1.38.
  const version = requested === 'oldest'
    ? '1.38.0'
    : requested === 'latest' ? getLatestPlaywrightSpecifier() : requested
  useSandbox([`@playwright/test@${version}`], true)

  for (const names of ['distinct', 'duplicate', 'unnamed']) {
    for (const nativeFirst of [false, true]) {
      it(`preserves native retries with ${names} projects, native first=${nativeFirst}`, async () => {
        const receiver = await new FakeCiVisIntake().start()
        let child
        let output = ''
        try {
          receiver.setSettings({ itr_enabled: false, flaky_test_retries_enabled: true })
          receiver.setFlakyTests({
            data: [{
              type: 'test',
              attributes: {
                configurations: { 'test.bundle': 'playwright' }, suite: 'playwright-projects.js', name: 'listed',
              },
            }],
          })
          child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test',
            '--config', 'ci-visibility/known-flakes/playwright-projects.config.js'], {
            cwd: sandboxCwd(),
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              DD_CIVISIBILITY_FLAKY_RETRY_ONLY_KNOWN_FLAKES: 'true',
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '2',
              DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: 'false',
              PLAYWRIGHT_PROJECT_NAMES: names,
              PLAYWRIGHT_NATIVE_FIRST: String(nativeFirst),
            },
          })
          child.stdout.on('data', chunk => { output += chunk })
          child.stderr.on('data', chunk => { output += chunk })
          const events = receiver.gatherPayloadsUntilChildExit(child,
            ({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const tests = payloads.flatMap(({ payload }) => payload.events)
                .filter(event => event.type === 'test').map(event => event.content)
              for (const source of ['native', 'automatic']) {
                for (const name of ['listed', 'unlisted']) {
                  const attempts = tests.filter(test => test.meta['test.retry_source'] === source &&
                    test.meta['test.name'] === name)
                  assert.strictEqual(attempts.length, source === 'native' ? 2 : name === 'listed' ? 3 : 1, output)
                }
              }
            })
          const [[code]] = await Promise.all([once(child, 'close'), events])
          assert.strictEqual(code, 1, output)
        } finally {
          child?.kill()
          await receiver.stop()
        }
      })
    }
  }
})
