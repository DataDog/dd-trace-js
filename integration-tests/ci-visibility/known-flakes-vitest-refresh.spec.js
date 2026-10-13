'use strict'

const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const { once } = require('node:events')
const { copyFileSync } = require('node:fs')
const path = require('node:path')

const { useSandbox, sandboxCwd, getCiVisAgentlessConfig } = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { NODE_MAJOR } = require('../../version')

const directory = 'ci-visibility/known-flakes/'
const suites = ['vitest.mjs', 'vitest-refresh-second.mjs', 'vitest-refresh-third.mjs'].map(file => directory + file)

describe('Vitest known-flake configuration refresh', function () {
  this.timeout(60000)
  // The programmatic specification API and no-worker-init require Vitest 3.2.6 or newer.
  useSandbox([`vitest@${NODE_MAJOR <= 18 ? '3.2.6' : 'latest'}`], true)

  before(() => {
    for (const suite of suites.slice(1)) {
      copyFileSync(path.join(sandboxCwd(), suites[0]), path.join(sandboxCwd(), suite))
    }
  })

  for (const noWorker of [false, true]) {
    for (const nativeRetries of [0, 2]) {
      it(`recovers from an unavailable flaky list (no worker init=${noWorker}, native=${nativeRetries})`, async () => {
        const receiver = await new FakeCiVisIntake().start()
        let child
        let output = ''
        const completedRuns = []
        try {
          receiver.setSettings({ itr_enabled: false, flaky_test_retries_enabled: true })
          receiver.setFlakyTests({ data: [] }, 403)
          child = fork(directory + 'run-vitest-refresh.mjs', suites, {
            cwd: sandboxCwd(),
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              DD_CIVISIBILITY_FLAKY_RETRY_ONLY_KNOWN_FLAKES: 'true',
              DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '2',
              DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: 'false',
              DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT: String(noWorker),
              NATIVE_RETRIES: String(nativeRetries),
            },
          })
          child.stdout.on('data', chunk => { output += chunk })
          child.stderr.on('data', chunk => { output += chunk })
          child.on('message', ({ completed }) => {
            completedRuns.push(completed)
            receiver.setFlakyTests({
              data: completed === 1
                ? suites.flatMap(suite => ['known flaky failure', 'recovers'].map(name => ({
                  type: 'test', attributes: { configurations: { 'test.bundle': 'vitest' }, suite, name },
                })))
                : [],
            })
            child.send('continue')
          })
          const events = receiver.gatherPayloadsUntilChildExit(child,
            ({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
              const tests = payloads.flatMap(({ payload }) => payload.events)
                .filter(event => event.type === 'test').map(event => event.content)
              const expected = nativeRetries ? [[3, 3, 2], [3, 3, 2], [3, 3, 2]] : [[3, 3, 2], [3, 1, 2], [1, 1, 1]]
              for (const [run, suite] of suites.entries()) {
                for (const [index, name] of ['known flaky failure', 'new failure', 'recovers'].entries()) {
                  const attempts = tests.filter(test =>
                    test.meta['test.suite'] === suite && test.meta['test.name'] === name)
                  assert.strictEqual(attempts.length, expected[run][index], `${suite} ${name}: ${output}`)
                }
              }
            })
          const [[code]] = await Promise.all([once(child, 'close'), events])
          assert.strictEqual(code, 1, output)
          assert.deepStrictEqual(completedRuns, [1, 2], output)
        } finally {
          child?.kill()
          await receiver.stop()
        }
      })
    }
  }
})
