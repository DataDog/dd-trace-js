'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')

const { NODE_MAJOR } = require('../../version')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { getCiVisAgentlessConfig, sandboxCwd, useSandbox } = require('../helpers')

// Runtime EFD suite admission starts at Vitest 4, which requires Node.js >=20.
const describeTransport = NODE_MAJOR >= 20 ? describe : describe.skip

for (const version of ['4.0.5', 'latest']) {
  describeTransport(`vitest@${version} EFD worker transport`, () => {
    useSandbox([`vitest@${version}`], true)

    for (const pool of ['forks', 'threads']) {
      it(`retries a passing test without unhandled IPC errors in ${pool}`, async function () {
        this.timeout(60_000)
        const receiver = await new FakeCiVisIntake().start()
        let childProcess
        let output = ''
        try {
          receiver.setSettings({
            known_tests_enabled: true,
            early_flake_detection: {
              enabled: true,
              slow_test_retries: { '5s': 2 },
              faulty_session_threshold: 100,
            },
          })
          receiver.setKnownTests({ vitest: {} })
          childProcess = exec('./node_modules/.bin/vitest run', {
            cwd: sandboxCwd(),
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
              TEST_DIR: 'ci-visibility/vitest-tests/efd-suite-admission-first.mjs',
              POOL_CONFIG: pool,
            },
          })
          childProcess.stdout.on('data', data => { output += data })
          childProcess.stderr.on('data', data => { output += data })

          const [[code, signal]] = await Promise.all([
            once(childProcess, 'exit'),
            receiver.gatherPayloadsUntilChildExit(
              childProcess,
              ({ url }) => url === '/api/v2/citestcycle',
              payloads => {
                const tests = payloads.flatMap(({ payload }) => payload.events)
                  .filter(event => event.type === 'test').map(event => event.content)
                assert.strictEqual(tests.length, 3, output)
                assert.ok(tests.every(test => test.meta['test.status'] === 'pass'), output)
                const retries = tests.filter(test => test.meta['test.is_retry'] === 'true')
                assert.strictEqual(retries.length, 2, output)
                assert.ok(retries.every(test => test.meta['test.retry_reason'] === 'early_flake_detection'), output)
              }
            ),
          ])
          assert.strictEqual(signal, null, output)
          assert.strictEqual(code, 0, output)
          assert.doesNotMatch(output, /Unhandled (?:Errors|Rejection)|Unable to deserialize/)
        } finally {
          childProcess?.kill()
          await receiver.stop()
        }
      })
    }
  })
}
