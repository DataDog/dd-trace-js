'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const path = require('node:path')
const { promisify } = require('node:util')

const { FakeCiVisIntake } = require('../../../../integration-tests/ci-visibility-intake')
const { getCiVisAgentlessConfig } = require('../../../../integration-tests/helpers')

const execFileAsync = promisify(execFile)
const root = path.resolve(__dirname, '../../../..')
const fixtures = path.join(__dirname, 'fixtures')
const setup = path.join(fixtures, 'mocha-global-setup.js')
const testFile = path.join(fixtures, 'mocha-global-setup-test.js')

describe('Mocha global setup with Test Optimization', function () {
  this.timeout(15_000)

  let receiver
  let env

  beforeEach(async () => {
    receiver = await new FakeCiVisIntake().start()
    receiver.setSettings({ itr_enabled: false })
    env = {
      ...getCiVisAgentlessConfig(receiver.port),
      // Children run from root; a relative path avoids NODE_OPTIONS consuming Windows backslashes.
      NODE_OPTIONS: '--require ./ci/init.js',
      DD_INJECT_FORCE: 'true',
      DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: 'false',
    }
  })

  afterEach(async () => {
    await receiver.stop()
  })

  for (const entrypoint of ['cli', 'programmatic']) {
    for (const order of ['configuration-first', 'setup-first']) {
      for (const coverage of [false, true]) {
        for (const settingsError of [false, true]) {
          it(`runs ${entrypoint}, ${order}, coverage=${coverage}, settingsError=${settingsError}`, async () => {
            if (settingsError) receiver.setSettingsResponseCode(404)
            const events = []
            receiver.on('message', ({ url, payload }) => {
              if (url.endsWith('/api/v2/citestcycle')) events.push(...payload.events)
            })

            const args = entrypoint === 'cli'
              ? [require.resolve('mocha/bin/mocha.js'), '--no-config', '--no-package', '--require', setup, testFile]
              : [setup]
            const { stdout, stderr } = await execFileAsync(process.execPath, args, {
              cwd: root,
              env: {
                ...env,
                MOCHA_SETUP_ORDER: order,
                MOCHA_SETUP_COVERAGE: String(coverage),
              },
              timeout: 10_000,
            })

            assert.match(stdout, /GLOBAL SETUP FINISHED/)
            assert.match(stdout, /1 passing/, stdout + stderr)
            assert.match(stdout, /GLOBAL TEARDOWN FINISHED/)
            const tests = events.filter(event => event.type === 'test')
            assert.strictEqual(tests.length, 1)
            assert.strictEqual(tests[0].content.meta['test.status'], 'pass')
            for (const type of ['test_suite_end', 'test_module_end', 'test_session_end']) {
              const matching = events.filter(event => event.type === type)
              assert.strictEqual(matching.length, 1, `expected one ${type}`)
              assert.strictEqual(matching[0].content.meta['test.status'], 'pass')
            }
          })
        }
      }
    }
  }

  for (const order of ['configuration-first', 'setup-first']) {
    it(`preserves global setup errors with ${order}`, async () => {
      await assert.rejects(execFileAsync(process.execPath, [setup], {
        cwd: root,
        env: { ...env, MOCHA_SETUP_ORDER: order, MOCHA_SETUP_ERROR: 'true' },
        timeout: 10_000,
      }), error => {
        assert.strictEqual(error.code, 1)
        assert.match(error.stderr, /global setup failed/)
        assert.doesNotMatch(error.stdout, /passing|GLOBAL TEARDOWN FINISHED/)
        return true
      })
    })
  }
})
