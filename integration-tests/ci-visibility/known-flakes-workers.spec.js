'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const { describe, it } = require('mocha')
const satisfies = require('../../vendor/dist/semifies')

const { useSandbox, sandboxCwd, getCiVisAgentlessConfig } = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { getLatestMochaSpecifier } = require('../mocha/versions')
const { DD_MAJOR } = require('../../version')

const directory = 'ci-visibility/known-flakes/workers/'
const suites = ['first.js', 'second.js'].map(file => directory + file)

describe('known-flakes worker payloads', () => {
  for (const framework of ['mocha', 'jest']) {
    describe(framework, () => {
      const requested = process.env[`${framework.toUpperCase()}_VERSION`] || 'latest'
      // Mocha 8.3 is the oldest parallel runner whose workerpool supports our Node versions.
      const oldest = framework === 'mocha' ? '8.3.0' : DD_MAJOR >= 6 ? '28.0.0' : '24.8.0'
      const version = requested === 'oldest' ? oldest : requested
      const dependency = framework === 'mocha' && version === 'latest' ? getLatestMochaSpecifier() : version
      const dependencies = [`${framework}@${dependency}`]
      if (framework === 'jest') dependencies.push(`jest-circus@${version}`)
      useSandbox(dependencies, true)

      for (const workerThreads of framework === 'jest' ? [false, true] : [false]) {
        const supported = !workerThreads || version === 'latest' || satisfies(version, '>=29.5.0')
        // Jest 24/28 do not expose the workerThreads runner option.
        const test = supported ? it : it.skip
        for (const scenario of ['selective', 'empty', 'unavailable']) {
          test(`${scenario} list with worker threads=${workerThreads}`, async () => {
            const receiver = await new FakeCiVisIntake().start()
            const report = path.join(sandboxCwd(), 'worker-payloads.jsonl')
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
              // A fresh timing cache prevents Jest from choosing runInBand for these short suites.
              const args = framework === 'mocha'
                ? ['node_modules/.bin/mocha', '--parallel', '--jobs', '2', ...suites]
                : ['node_modules/jest/bin/jest.js', '--maxWorkers=2', '--config', JSON.stringify({
                    rootDir: '.',
                    cacheDirectory: `./worker-cache-${scenario}-${workerThreads}`,
                    testMatch: ['**/' + directory + '*.js'],
                    testRunner: 'jest-circus/runner',
                    ...(workerThreads ? { workerThreads: true } : {}),
                  })]
              child = spawn(process.execPath, args, {
                cwd: sandboxCwd(),
                env: {
                  ...getCiVisAgentlessConfig(receiver.port),
                  NODE_OPTIONS: '-r ./ci-visibility/known-flakes/inspect-worker-payloads.js -r dd-trace/ci/init',
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
              assert.strictEqual(code, framework === 'mocha' ? 2 : 1, output)
              const payloads = readFileSync(report, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
              assert.deepStrictEqual(new Set(payloads.map(({ suite }) => suite)), new Set(suites), output)
              for (const { suite, flakyTests } of payloads) {
                const names = scenario === 'selective' && suite === suites[0] ? ['fails'] : []
                assert.deepStrictEqual(flakyTests, scenario === 'unavailable'
                  ? undefined
                  : { [framework]: { [suite]: names } })
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
