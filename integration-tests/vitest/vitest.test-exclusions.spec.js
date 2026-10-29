'use strict'

const assert = require('node:assert/strict')
const { exec, execFileSync, spawnSync } = require('node:child_process')
const { once } = require('node:events')

const { sandboxCwd, useSandbox, getCiVisAgentlessConfig, stopCiVisTestEnv } = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { NODE_MAJOR } = require('../../version')
const { expectedExecutions, prepareExecutionLedger, readExecutions } = require('./exclusion-executions')
const protection = 'test.test_management.prevent_failure_suppression'
const exclusion = 'test.test_management.no_auto_retry'
const suite = 'ci-visibility/vitest-tests/test-exclusions.mjs'

const versions = NODE_MAJOR <= 18 ? ['1.6.0', '3.2.6'] : ['1.6.0', 'latest']

for (const version of versions) {
  describe(`Vitest ${version} test automation exclusions`, function () {
    this.timeout(120000)
    useSandbox([
      `vitest@${version}`, `@vitest/coverage-istanbul@${version}`, `@vitest/coverage-v8@${version}`, 'tinypool',
    ], true)
    let cwd, receiver, childProcess
    before(() => { cwd = sandboxCwd() })
    beforeEach(async () => { receiver = await new FakeCiVisIntake().start() })
    afterEach(async () => {
      await stopCiVisTestEnv({ childProcess, receiver })
      childProcess = undefined
    })
    const properties = assignments => {
      receiver.setTestManagementTests({ vitest: { suites: { [suite]: { tests: assignments } } } })
    }
    const run = async (mode, expectedExit, check, env = {}, executions = expectedExecutions[mode]) => {
      const ledger = prepareExecutionLedger(cwd)
      const command = mode === 'reuse'
        ? process.execPath + ' ci-visibility/vitest-tests-programmatic-api/run-exclusions-reuse.mjs'
        : './node_modules/.bin/vitest run'
      childProcess = exec(command, {
        cwd,
        env: {
          ...getCiVisAgentlessConfig(receiver.port),
          NODE_OPTIONS: '--import dd-trace/register.js -r dd-trace/ci/init',
          TEST_DIR: suite,
          EXCLUSIONS_MODE: mode,
          EXCLUSIONS_LEDGER: ledger,
          DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '2',
          ...env,
        },
      })
      let output = ''
      childProcess.stdout.on('data', chunk => { output += chunk })
      childProcess.stderr.on('data', chunk => { output += chunk })
      const exitPromise = once(childProcess, 'exit')
      const eventsPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        payloads => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const tests = events.filter(event => event.type === 'test').map(event => event.content)
          assert.ok(tests.length || mode === 'tia', output)
          check(tests, events)
        },
        { hardTimeout: 90000 }
      )
      const [[exitCode]] = await Promise.all([exitPromise, eventsPromise]).catch(error => {
        error.message += `\nVitest output:\n${output}`
        throw error
      })
      assert.strictEqual(exitCode, expectedExit, output)
      assert.deepStrictEqual(readExecutions(ledger), executions, output)
    }
    const named = (tests, name) => tests.filter(test => test.meta['test.name'] === name)

    it('keeps a protection-only failure blocking without implying retry exclusion', async () => {
      receiver.setSettings({ test_management: { enabled: true }, flaky_test_retries_enabled: false })
      properties({ sole: { properties: { disabled: true, quarantined: true } } })
      await run('protection-only', 1, tests => {
        assert.strictEqual(tests.length, 1)
        assert.strictEqual(tests[0].meta['test.status'], 'fail')
        assert.strictEqual(tests[0].meta['test.final_status'], 'fail')
        assert.strictEqual(tests[0].meta[protection], 'true')
        assert.strictEqual(tests[0].meta[exclusion], undefined)
        assert.strictEqual(tests[0].meta['test.test_management.is_test_disabled'], 'true')
        assert.strictEqual(tests[0].meta['test.test_management.is_quarantined'], 'true')
      })
    })

    it('keeps concurrent same-name declarations with a shared callback independent under ATR', async () => {
      receiver.setSettings({ flaky_test_retries_enabled: true })
      await run('collision', 1, tests => {
        assert.strictEqual(tests.length, 4)
        const excluded = tests.filter(test => test.meta[exclusion] === 'true')
        const controls = tests.filter(test => test.meta[exclusion] === undefined)
        assert.strictEqual(excluded.length, 1)
        assert.strictEqual(excluded[0].meta['test.is_retry'], undefined)
        assert.strictEqual(controls.length, 3)
        assert.strictEqual(controls.filter(test => test.meta['test.is_retry'] === 'true').length, 2)
      })
    })

    it('keeps concurrent same-name suppression decisions independent with a shared callback', async () => {
      receiver.setSettings({ test_management: { enabled: true }, flaky_test_retries_enabled: false })
      properties({ collision: { properties: { quarantined: true } } })
      await run('collision-protection', 1, tests => {
        assert.strictEqual(tests.length, 2)
        const protectedTest = tests.find(test => test.meta[protection] === 'true')
        const control = tests.find(test => test.meta[protection] === undefined)
        assert.ok(protectedTest)
        assert.ok(control)
        assert.strictEqual(protectedTest.meta['test.final_status'], 'fail')
        assert.strictEqual(control.meta['test.final_status'], 'skip')
        for (const test of tests) {
          assert.strictEqual(test.meta[exclusion], undefined)
          assert.strictEqual(test.meta['test.test_management.is_quarantined'], 'true')
        }
      })
    })

    for (const quarantined of [false, true]) {
      it(`preserves exhausted native retry budgets without Datadog fallback (quarantine=${quarantined})`, async () => {
        const ledger = prepareExecutionLedger(cwd)
        const native = spawnSync(process.execPath, ['./node_modules/vitest/vitest.mjs', 'run'], {
          cwd,
          env: {
            ...process.env,
            NODE_OPTIONS: '',
            TEST_DIR: suite,
            EXCLUSIONS_MODE: 'native-persistent',
            EXCLUSIONS_NATIVE_QUARANTINED: quarantined ? '1' : '0',
            EXCLUSIONS_LEDGER: ledger,
          },
          encoding: 'utf8',
        })
        assert.strictEqual(native.signal, null, native.stderr)
        assert.strictEqual(native.status, 1, native.stdout + native.stderr)
        assert.deepStrictEqual(readExecutions(ledger), quarantined
          ? { direct: 2, inherited: 2 }
          : { direct: 2, inherited: 2, control: 1 })
        receiver.setSettings({ test_management: { enabled: true }, flaky_test_retries_enabled: true })
        const nativeNames = ['direct native failure', 'inherited budget inherited native failure']
        properties(Object.fromEntries(nativeNames.map(name => [
          name, { properties: { quarantined } },
        ])))
        await run('native-persistent', quarantined ? 0 : 1, tests => {
          assert.strictEqual(tests.length, quarantined ? 4 : 7)
          const excluded = tests.filter(test => test.meta[exclusion] === 'true')
          assert.strictEqual(excluded.length, 4)
          assert.ok(excluded.every(test => test.meta['test.status'] === 'fail'))
          assert.strictEqual(excluded.filter(test => test.meta['test.retry_reason'] === 'external').length, 2)
          assert.ok(excluded.every(test => !['auto_test_retry', 'early_flake_detection', 'attempt_to_fix']
            .includes(test.meta['test.retry_reason'])))
          assert.strictEqual(named(tests, 'control').length, quarantined ? 0 : 3)
          for (const name of nativeNames) {
            assert.strictEqual(named(tests, name).at(-1).meta['test.final_status'], quarantined ? 'skip' : 'fail')
          }
        }, { EXCLUSIONS_NATIVE_QUARANTINED: quarantined ? '1' : '0' },
        quarantined ? { direct: 2, inherited: 2 } : expectedExecutions['native-persistent'])
      })
    }

    it('recollects changed annotations and native budgets through the same runner instance', async () => {
      const reusedSuite = 'ci-visibility/vitest-tests/annotation-reuse.mjs'
      receiver.setSettings({ test_management: { enabled: true }, flaky_test_retries_enabled: true })
      receiver.setTestManagementTests({
        vitest: {
          suites: {
            [reusedSuite]: {
              tests: {
                reused: { properties: { quarantined: true } },
              },
            },
          },
        },
      })
      await run('reuse', 1, tests => {
        assert.strictEqual(tests.length, 6)
        assert.strictEqual(tests[0].meta[protection], 'true')
        assert.strictEqual(tests[0].meta[exclusion], 'true')
        assert.strictEqual(tests[0].meta['test.final_status'], 'fail')
        for (const test of tests.slice(1, 4)) {
          assert.strictEqual(test.meta[protection], undefined)
          assert.strictEqual(test.meta[exclusion], undefined)
        }
        assert.strictEqual(tests.slice(1, 4).filter(test =>
          test.meta['test.retry_reason'] === 'auto_test_retry').length, 2)
        assert.strictEqual(tests[3].meta['test.final_status'], 'skip')
        for (const test of tests.slice(4)) {
          assert.strictEqual(test.meta[protection], 'true')
          assert.strictEqual(test.meta[exclusion], 'true')
          assert.strictEqual(test.meta['test.status'], 'fail')
        }
        // Native intermediate attempts do not have a terminal status.
        assert.strictEqual(tests[5].meta['test.final_status'], 'fail')
        assert.strictEqual(tests[5].meta['test.retry_reason'], 'external')
      }, { TEST_DIR: reusedSuite })
    })

    it('preserves TIA selection before annotated declarations are collected', async () => {
      receiver.setSettings({
        itr_enabled: true,
        tests_skipping: true,
        code_coverage: false,
        flaky_test_retries_enabled: false,
      })
      receiver.setSuitesToSkip([{ type: 'suite', attributes: { suite } }])
      await run('tia', 0, (tests, events) => {
        assert.strictEqual(tests.length, 0)
        const skipped = events.find(event => event.type === 'test_suite_end').content
        assert.strictEqual(skipped.meta['test.status'], 'skip')
        assert.strictEqual(skipped.meta['test.skipped_by_itr'], 'true')
      }, { EXCLUSIONS_MODE: 'sole' })
    })

    it('protects failures and retains assignments, parameterized declarations and skipped annotations', async () => {
      receiver.setSettings({ test_management: { enabled: true }, flaky_test_retries_enabled: false })
      const protectedNames = ['protected disabled', 'protected quarantine', 'protected both 1', 'protected both 2']
      // The first two tests allow ATF; omit that assignment so each executes once.
      const assignments = Object.fromEntries(protectedNames.map(name => [name, {
        properties: {
          disabled: true, quarantined: true, ...(name.startsWith('protected both') ? { attempt_to_fix: true } : {}),
        },
      }]))
      assignments['protected passing'] = { properties: { disabled: true, quarantined: true } }
      assignments['ordinary disabled'] = { properties: { disabled: true, attempt_to_fix: true } }
      assignments['ordinary quarantine'] = { properties: { quarantined: true } }
      properties(assignments)
      await run('policy', 1, tests => {
        assert.strictEqual(tests.length, 8)
        for (const name of protectedNames) {
          const [test] = named(tests, name)
          assert.strictEqual(test.meta['test.status'], 'fail', name)
          assert.strictEqual(test.meta['test.final_status'], 'fail', name)
          assert.strictEqual(test.meta[protection], 'true', name)
          assert.strictEqual(test.meta['test.test_management.is_test_disabled'], 'true', name)
          assert.strictEqual(test.meta['test.test_management.is_quarantined'], 'true', name)
          assert.strictEqual(test.meta['test.is_retry'], undefined, name)
          if (name.startsWith('protected both')) {
            assert.strictEqual(test.meta[exclusion], 'true', name)
            assert.strictEqual(test.meta['test.test_management.is_attempt_to_fix'], 'true', name)
            assert.strictEqual(test.meta['test.test_management.attempt_to_fix_passed'], undefined, name)
          }
        }
        assert.strictEqual(named(tests, 'ordinary disabled')[0].meta['test.status'], 'skip')
        assert.strictEqual(named(tests, 'ordinary disabled')[0].meta[exclusion], 'true')
        assert.strictEqual(named(tests, 'ordinary disabled')[0].meta['test.test_management.is_attempt_to_fix'], 'true')
        assert.strictEqual(named(tests, 'ordinary quarantine')[0].meta['test.final_status'], 'skip')
        assert.strictEqual(named(tests, 'protected passing')[0].meta['test.status'], 'pass')
        const [skipped] = named(tests, 'developer skipped')
        assert.strictEqual(skipped.meta['test.status'], 'skip')
        assert.strictEqual(skipped.meta[protection], 'true')
        assert.strictEqual(skipped.meta[exclusion], 'true')
      })
    })

    it('captures callback annotations when tagged table data contains annotated functions', async () => {
      receiver.setSettings({ test_management: { enabled: true }, flaky_test_retries_enabled: true })
      properties(Object.fromEntries(['tagged 1', 'tagged 2'].map(name => [name, {
        properties: { disabled: true, quarantined: true, attempt_to_fix: true },
      }])))
      await run('tagged-table', 1, tests => {
        assert.strictEqual(tests.length, 2)
        for (const test of tests) {
          assert.strictEqual(test.meta['test.status'], 'fail')
          assert.strictEqual(test.meta['test.final_status'], 'fail')
          assert.strictEqual(test.meta[protection], 'true')
          assert.strictEqual(test.meta[exclusion], 'true')
          assert.strictEqual(test.meta['test.is_retry'], undefined)
          assert.strictEqual(test.meta['test.test_management.is_test_disabled'], 'true')
          assert.strictEqual(test.meta['test.test_management.is_quarantined'], 'true')
          assert.strictEqual(test.meta['test.test_management.is_attempt_to_fix'], 'true')
        }
      })
    })

    it('blocks ATR without preventing protected retries or changing unannotated controls', async () => {
      receiver.setSettings({ flaky_test_retries_enabled: true })
      await run('atr', 1, tests => {
        assert.strictEqual(tests.length, 6)
        const [excluded] = named(tests, 'excluded')
        assert.strictEqual(named(tests, 'excluded').length, 1)
        assert.strictEqual(excluded.meta[exclusion], 'true')
        assert.strictEqual(excluded.meta['test.is_retry'], undefined)
        assert.strictEqual(named(tests, 'control').length, 3)
        assert.strictEqual(named(tests, 'protected retry').length, 2)
        assert.strictEqual(named(tests, 'protected retry').at(-1).meta['test.status'], 'pass')
      })
    })

    for (const feature of ['efd', 'atf']) {
      it(`blocks ${feature} while preserving discovery and assigned properties`, async () => {
        receiver.setSettings({
          flaky_test_retries_enabled: false,
          known_tests_enabled: feature === 'efd',
          early_flake_detection: {
            enabled: feature === 'efd', slow_test_retries: { '5s': 2 }, faulty_session_threshold: 100,
          },
          test_management: { enabled: feature === 'atf', attempt_to_fix_retries: 2 },
        })
        receiver.setKnownTests({ vitest: { 'ci-visibility/vitest-tests/known.mjs': ['known'] } })
        properties({
          excluded: { properties: { attempt_to_fix: true } },
          control: { properties: { attempt_to_fix: true } },
        })
        await run(feature, 0, tests => {
          assert.strictEqual(tests.length, 4)
          const [excluded] = named(tests, 'excluded')
          assert.strictEqual(named(tests, 'excluded').length, 1)
          assert.strictEqual(named(tests, 'control').length, 3)
          assert.strictEqual(excluded.meta[exclusion], 'true')
          assert.strictEqual(excluded.meta['test.is_retry'], undefined)
          assert.strictEqual(excluded.meta['test.test_management.attempt_to_fix_passed'], undefined)
          if (feature === 'efd') assert.strictEqual(excluded.meta['test.is_new'], 'true')
          if (feature === 'atf') assert.strictEqual(excluded.meta['test.test_management.is_attempt_to_fix'], 'true')
        })
      })
    }

    it('preserves explicit native retries without attributing them to Datadog ATR', async () => {
      receiver.setSettings({ flaky_test_retries_enabled: true })
      await run('explicit', 0, tests => {
        assert.strictEqual(tests.length, 2)
        for (const test of tests) assert.strictEqual(test.meta[exclusion], 'true')
        assert.strictEqual(tests[1].meta['test.retry_reason'], 'external')
        assert.strictEqual(tests[1].meta['test.status'], 'pass')
      })
    })
    it('keeps a sole protected failure blocking with all management assignments', async () => {
      receiver.setSettings({ test_management: { enabled: true }, flaky_test_retries_enabled: true })
      properties({ sole: { properties: { disabled: true, quarantined: true, attempt_to_fix: true } } })
      await run('sole', 1, tests => {
        assert.strictEqual(tests.length, 1)
        assert.strictEqual(tests[0].meta['test.status'], 'fail')
        assert.strictEqual(tests[0].meta['test.final_status'], 'fail')
        assert.strictEqual(tests[0].meta[protection], 'true')
        assert.strictEqual(tests[0].meta[exclusion], 'true')
      })
    })

    it('restores quarantine policy and omits observation tags when annotations are removed', async () => {
      receiver.setSettings({ test_management: { enabled: true }, flaky_test_retries_enabled: false })
      properties({ sole: { properties: { quarantined: true } } })
      await run('removed', 0, tests => {
        assert.strictEqual(tests.length, 1)
        assert.strictEqual(tests[0].meta['test.status'], 'fail')
        assert.strictEqual(tests[0].meta['test.final_status'], 'skip')
        assert.strictEqual(tests[0].meta[protection], undefined)
        assert.strictEqual(tests[0].meta[exclusion], undefined)
      })
    })

    // Configured tags were introduced in Vitest 4.1; the minimum-version fixture has no tags API.
    const tagRetryIt = version === 'latest' ? it : it.skip
    tagRetryIt('preserves native retries inherited from configured tags', async () => {
      // The same annotated fixture must pass natively before verifying instrumentation.
      execFileSync(process.execPath, ['./node_modules/vitest/vitest.mjs', 'run'], {
        cwd,
        env: { ...process.env, NODE_OPTIONS: '', TEST_DIR: suite, EXCLUSIONS_MODE: 'native-tags' },
        encoding: 'utf8',
      })
      receiver.setSettings({ flaky_test_retries_enabled: true })
      await run('native-tags', 0, tests => {
        assert.strictEqual(tests.length, 4)
        for (const name of ['native tagged retries', 'inherited tags native inherited retries']) {
          const attempts = named(tests, name)
          assert.strictEqual(attempts.length, 2)
          assert.strictEqual(attempts[1].meta['test.status'], 'pass')
          assert.strictEqual(attempts[1].meta[exclusion], 'true')
          assert.strictEqual(attempts[1].meta['test.retry_reason'], 'external')
        }
      })
    })

    tagRetryIt('blocks automatic retries for configured tags without native retries', async () => {
      receiver.setSettings({ flaky_test_retries_enabled: true })
      await run('plain-tags', 1, tests => {
        assert.strictEqual(tests.length, 4)
        const excluded = named(tests, 'excluded tagged')
        assert.strictEqual(excluded.length, 1)
        assert.strictEqual(excluded[0].meta[exclusion], 'true')
        assert.strictEqual(excluded[0].meta['test.is_retry'], undefined)
        assert.strictEqual(named(tests, 'control tagged').length, 3)
      })
    })

    it('preserves explicit suite retries for excluded callbacks', async () => {
      receiver.setSettings({ flaky_test_retries_enabled: true })
      await run('native-suite', 0, tests => {
        assert.strictEqual(tests.length, 2)
        assert.strictEqual(tests[1].meta['test.status'], 'pass')
        assert.strictEqual(tests[1].meta[exclusion], 'true')
        assert.strictEqual(tests[1].meta['test.retry_reason'], 'external')
      })
    })

    it('preserves annotations across concurrent parameterized declaration chains', async () => {
      receiver.setSettings({ flaky_test_retries_enabled: true })
      await run('concurrent', 1, tests => {
        assert.strictEqual(tests.length, 5)
        for (const name of ['excluded 1', 'excluded 2']) {
          const attempts = named(tests, name)
          assert.strictEqual(attempts.length, 1)
          assert.strictEqual(attempts[0].meta[exclusion], 'true')
          assert.strictEqual(attempts[0].meta['test.is_retry'], undefined)
        }
        assert.strictEqual(named(tests, 'control').length, 3)
      })
    })
    // Vitest 1.6 supports numeric retry counts only; the current runner also supports retry conditions.
    const conditionalRetryIt = version === 'latest' ? it : it.skip
    conditionalRetryIt('preserves explicit native conditional retries without serializing their function', async () => {
      receiver.setSettings({ flaky_test_retries_enabled: true })
      await run('native-condition', 0, tests => {
        assert.strictEqual(tests.length, 2)
        assert.strictEqual(tests[1].meta['test.status'], 'pass')
        assert.strictEqual(tests[1].meta[exclusion], 'true')
        assert.strictEqual(tests[1].meta['test.retry_reason'], 'external')
      })
    })
  })
}
