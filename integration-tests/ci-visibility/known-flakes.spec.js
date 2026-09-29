'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')

const { describe, it } = require('mocha')
const satisfies = require('../../vendor/dist/semifies')

const { useSandbox, sandboxCwd, getCiVisAgentlessConfig, getCiVisEvpProxyConfig } = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { getLatestMochaSpecifier } = require('../mocha/versions')
const { getLatestPlaywrightSpecifier } = require('../playwright/versions')
const { DD_MAJOR, NODE_MAJOR } = require('../../version')

const directory = 'ci-visibility/known-flakes/'
const frameworks = [
  {
    name: 'mocha',
    dependency: 'mocha',
    oldest: DD_MAJOR >= 6 ? '8.0.0' : '5.2.0',
    latest: getLatestMochaSpecifier(),
    minimumRetriesVersion: '6.0.0',
    file: 'mocha.js',
    args: ['node_modules/.bin/mocha', directory + 'mocha.js'],
  },
  {
    name: 'jest',
    dependency: 'jest',
    oldest: DD_MAJOR >= 6 ? '28.0.0' : '24.8.0',
    file: 'jest.js',
    args: ['node_modules/jest/bin/jest.js', '--runInBand', '--config', JSON.stringify({
      rootDir: '.', testMatch: ['**/known-flakes/jest.js'], testRunner: 'jest-circus/runner',
    })],
  },
  {
    name: 'vitest',
    dependency: 'vitest',
    oldest: '1.6.0',
    latest: NODE_MAJOR <= 18 ? '3.2.6' : 'latest',
    file: 'vitest.mjs',
    args: ['node_modules/vitest/vitest.mjs', 'run', '--config', directory + 'vitest.config.mjs'],
  },
  {
    name: 'playwright',
    dependency: '@playwright/test',
    oldest: '1.18.0',
    latest: getLatestPlaywrightSpecifier(),
    minimumRetriesVersion: '1.38.0',
    file: 'playwright.js',
    args: ['node_modules/@playwright/test/cli.js', 'test', '--config', directory + 'playwright.config.js'],
  },
  {
    name: 'cucumber',
    dependency: '@cucumber/cucumber',
    oldest: '7.0.0',
    // Cucumber 12 dropped Node 18; Cucumber 13 requires Node 22, 24, or >=26.
    latest: NODE_MAJOR === 22 || NODE_MAJOR === 24 || NODE_MAJOR >= 26
      ? 'latest'
      : NODE_MAJOR <= 18 ? '11.3.0' : '12.2.0',
    minimumRetriesVersion: '8.0.0',
    file: 'retries.feature',
    args: ['node_modules/@cucumber/cucumber/bin/cucumber-js', directory + 'retries.feature',
      '--require', directory + 'steps.js'],
  },
]

describe('known-flakes-only Auto Test Retries', () => {
  for (const framework of frameworks) {
    describe(framework.name, () => {
      const requested = process.env[`${framework.name.toUpperCase()}_VERSION`] || 'latest'
      const version = requested === 'oldest' ? framework.oldest : requested
      // These versions expose the runner hooks used by the existing ATR integration.
      const retryTest = version === 'latest' || !framework.minimumRetriesVersion ||
        satisfies(version, `>=${framework.minimumRetriesVersion}`)
        ? it
        : it.skip
      const dependencyVersion = version === 'latest' ? framework.latest || 'latest' : version
      const dependencies = [`${framework.dependency}@${dependencyVersion}`]
      if (framework.name === 'jest') dependencies.push(`jest-circus@${version}`)
      useSandbox(dependencies, true)

      const scenarios = [
        { name: 'selective', retries: [3, 1, 2] },
        { name: 'proxy', proxy: true, retries: [3, 1, 2] },
        { name: 'empty', response: { data: [] }, retries: [1, 1, 1] },
        { name: 'malformed', response: { data: {} }, retries: [3, 3, 2] },
        { name: 'unavailable', status: 403, retries: [3, 3, 2] },
        { name: 'disabled', enabled: 'false', retries: [3, 3, 2], requests: 0 },
        { name: 'ATR disabled', atr: false, retries: [1, 1, 1], requests: 0 },
        { name: 'native retries with an empty list', native: true, response: { data: [] }, retries: [2, 2, 2] },
        { name: 'dynamic retries', dynamic: true, retries: [3, 1, 2] },
        { name: 'EFD with an empty list', efd: true, response: { data: [] }, retries: [3, 3, 3] },
        { name: 'attempt to fix with an empty list', atf: true, response: { data: [] }, retries: [3, 3, 3] },
      ]
      // Match the existing suite's parallel-mode gate (older workerpool versions cannot start workers).
      if (framework.name === 'mocha' && (version === 'latest' || satisfies(version, '>=8.3.0'))) {
        scenarios.push({ name: 'parallel', args: ['--parallel'], retries: [3, 1, 2] })
      }
      if (framework.name === 'cucumber') {
        scenarios.push({ name: 'parallel', args: ['--parallel', '2'], retries: [3, 1, 2] })
      }
      if (framework.name === 'vitest' && requested !== 'oldest') {
        scenarios.push({ name: 'without worker init', noWorker: true, retries: [3, 1, 2] })
        scenarios.push({
          name: 'empty without worker init', noWorker: true, response: { data: [] }, retries: [1, 1, 1],
        })
      }
      for (const scenario of scenarios) {
        retryTest(`applies ${scenario.name} known flakes`, async () => {
          const receiver = await new FakeCiVisIntake().start()
          let child
          let output = ''
          let requests = 0
          try {
            receiver.setSettings({
              itr_enabled: false,
              code_coverage: false,
              tests_skipping: false,
              flaky_test_retries_enabled: scenario.atr !== false,
              known_tests_enabled: !!scenario.efd,
              early_flake_detection: {
                enabled: !!scenario.efd,
                slow_test_retries: { '5s': 2 },
                faulty_session_threshold: 100,
              },
              test_management: { enabled: !!scenario.atf, attempt_to_fix_retries: 2 },
            })
            // Playwright names suites relative to its configured testDir.
            const suite = framework.name === 'playwright' ? framework.file : directory + framework.file
            receiver.setKnownTests({ [framework.name]: {} })
            receiver.setTestManagementTests({
              [framework.name]: {
                suites: {
                  [suite]: {
                    tests: Object.fromEntries(
                      ['known flaky failure', 'new failure', 'recovers'].map(name => [name, {
                        properties: { attempt_to_fix: true },
                      }])
                    ),
                  },
                },
              },
            })
            receiver.setFlakyTests(scenario.response || {
              data: ['known flaky failure', 'recovers'].map(name => ({
                type: 'test', attributes: { configurations: { 'test.bundle': framework.name }, suite, name },
              })),
            }, scenario.status || 200)
            receiver.on('message', ({ url }) => {
              if (url.endsWith('/api/v2/ci/libraries/tests/flaky')) requests++
            })
            const env = scenario.proxy ? getCiVisEvpProxyConfig(receiver.port) : getCiVisAgentlessConfig(receiver.port)
            const args = [...framework.args, ...(scenario.args || [])]
            if (scenario.native && ['mocha', 'cucumber'].includes(framework.name)) {
              args.push(framework.name === 'mocha' ? '--retries' : '--retry', '1')
            }
            child = spawn(process.execPath, args, {
              cwd: sandboxCwd(),
              env: {
                ...env,
                ...(framework.name === 'vitest'
                  ? { NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init' }
                  : {}),
                DD_CIVISIBILITY_FLAKY_RETRY_ONLY_KNOWN_FLAKES: scenario.enabled || 'true',
                DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '2',
                DD_CIVISIBILITY_GIT_UPLOAD_ENABLED: 'false',
                DD_CIVISIBILITY_DYNAMIC_ATR_ENABLED: String(!!scenario.dynamic),
                DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS: '2,2,2,2,2',
                DD_EXPERIMENTAL_TEST_OPT_VITEST_NO_WORKER_INIT: String(!!scenario.noWorker),
                NATIVE_RETRIES: scenario.native ? '1' : '',
              },
            })
            child.stdout.on('data', chunk => { output += chunk })
            child.stderr.on('data', chunk => { output += chunk })
            const events = receiver.gatherPayloadsUntilChildExit(child,
              ({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
                const tests = payloads.flatMap(({ payload }) => payload.events)
                  .filter(event => event.type === 'test').map(event => event.content)
                for (const [index, name] of ['known flaky failure', 'new failure', 'recovers'].entries()) {
                  const attempts = tests.filter(test => test.meta['test.name'] === name)
                  assert.strictEqual(attempts.length, scenario.retries[index], `${name}: ${output}`)
                  if (attempts.length === 1) {
                    assert.strictEqual(attempts[0].meta['test.is_retry'], undefined)
                    assert.strictEqual(attempts[0].meta['test.has_failed_all_retries'], undefined)
                  } else if (!scenario.native) {
                    const reason = scenario.efd
                      ? 'early_flake_detection'
                      : scenario.atf ? 'attempt_to_fix' : 'auto_test_retry'
                    const retried = attempts.filter(test => test.meta['test.is_retry'] === 'true')
                    assert.deepStrictEqual(retried.map(test => test.meta['test.retry_reason']),
                      Array(attempts.length - 1).fill(reason))
                  }
                }
              })
            const [[code]] = await Promise.all([once(child, 'close'), events])
            // Cucumber 8.0 reports success for EFD's cloned scenarios, also on the unchanged tracer.
            const cucumber8Efd = framework.name === 'cucumber' && version === '8.0.0' && scenario.efd
            const expectedCode = framework.name === 'mocha'
              ? (scenario.efd ? 6 : scenario.atf ? 7 : scenario.retries[2] > 1 ? 2 : 3)
              : cucumber8Efd ? 0 : 1
            assert.strictEqual(code, expectedCode, output)
            assert.strictEqual(requests, scenario.requests ?? 1)
          } catch (error) {
            throw new Error(`${error.message}\n${output}`, { cause: error })
          } finally {
            child?.kill()
            await receiver.stop()
          }
        })
      }
    })
  }
})
