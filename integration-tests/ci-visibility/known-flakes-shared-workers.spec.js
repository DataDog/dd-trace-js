'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const { describe, it } = require('mocha')

const { useSandbox, sandboxCwd, getCiVisAgentlessConfig } = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { NODE_MAJOR } = require('../../version')

const directory = 'ci-visibility/known-flakes/workers/'

describe('known-flakes shared worker payloads', () => {
  for (const framework of ['vitest', 'cucumber']) {
    describe(framework, () => {
      const requested = process.env[`${framework.toUpperCase()}_VERSION`] || 'latest'
      // Cucumber 8 is the first version supported by the existing ATR runner hooks.
      const oldest = framework === 'vitest' ? '1.6.0' : '8.0.0'
      const latest = framework === 'vitest'
        ? NODE_MAJOR <= 18 ? '3.2.6' : 'latest'
        : NODE_MAJOR === 22 || NODE_MAJOR === 24 || NODE_MAJOR >= 26
          ? 'latest'
          : NODE_MAJOR <= 18 ? '11.3.0' : '12.2.0'
      const version = requested === 'oldest' ? oldest : requested === 'latest' ? latest : requested
      const dependency = framework === 'vitest' ? 'vitest' : '@cucumber/cucumber'
      useSandbox([`${dependency}@${version}`], true)
      const suites = ['first', 'second'].map(file => directory + file + (framework === 'vitest' ? '.js' : '.feature'))

      for (const pool of framework === 'vitest' ? ['forks', 'threads'] : ['parallel']) {
        for (const scenario of ['selective', 'empty', 'unavailable']) {
          it(`${scenario} list with ${pool}`, async () => {
            const receiver = await new FakeCiVisIntake().start()
            const report = path.join(sandboxCwd(), 'shared-worker-payloads.jsonl')
            writeFileSync(report, '')
            let child
            let output = ''
            try {
              receiver.setSettings({
                itr_enabled: false, known_tests_enabled: false, flaky_test_retries_enabled: true,
              })
              const data = [
                { suite: suites[0], name: 'fails', configurations: { 'test.bundle': framework } },
                { suite: 'unrelated.js', name: 'other', configurations: { 'test.bundle': framework } },
                { suite: suites[0], name: 'other framework', configurations: { 'test.bundle': 'other' } },
              ].map(attributes => ({ type: 'test', attributes }))
              receiver.setFlakyTests({ data: scenario === 'empty' ? [] : data }, scenario === 'unavailable' ? 403 : 200)
              const args = framework === 'vitest'
                ? ['node_modules/vitest/vitest.mjs', 'run', '--config', directory + 'vitest.config.mjs', '--pool', pool]
                : ['node_modules/@cucumber/cucumber/bin/cucumber-js', ...suites,
                    '--require', 'ci-visibility/known-flakes/cucumber-worker-steps.js', '--parallel', '2']
              child = spawn(process.execPath, args, {
                cwd: sandboxCwd(),
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  NODE_OPTIONS: framework === 'vitest'
                    ? '--import dd-trace/register.js -r dd-trace/ci/init'
                    : '-r dd-trace/ci/init',
                  WORKER_PAYLOADS_FILE: report,
                  DD_CIVISIBILITY_FLAKY_RETRY_ONLY_KNOWN_FLAKES: 'true',
                  DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '2',
                  DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: 'false',
                },
              })
              child.stdout.on('data', chunk => { output += chunk })
              child.stderr.on('data', chunk => { output += chunk })
              const events = receiver.gatherPayloadsUntilChildExit(child,
                ({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                  const tests = payloads.flatMap(({ payload }) => payload.events)
                    .filter(event => event.type === 'test').map(event => event.content)
                  for (const suite of suites) {
                    const attempts = tests.filter(test => test.meta['test.suite'] === suite)
                    const retried = scenario === 'unavailable' || (scenario === 'selective' && suite === suites[0])
                    assert.strictEqual(attempts.length, retried ? 3 : 1, output)
                  }
                })
              const [[code]] = await Promise.all([once(child, 'close'), events])
              assert.strictEqual(code, 1, output)
              const payloads = readFileSync(report, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
              assert.ok(payloads.length >= 2, output)
              for (const { workerId, flakyTests } of payloads) {
                assert.notStrictEqual(workerId, undefined, output)
                assert.deepStrictEqual(flakyTests, scenario === 'unavailable'
                  ? undefined
                  : { [framework]: { [suites[0]]: scenario === 'selective' ? ['fails'] : [], [suites[1]]: [] } })
              }
            } finally {
              child?.kill()
              await receiver.stop()
            }
          })
        }
      }
    })
  }
})
