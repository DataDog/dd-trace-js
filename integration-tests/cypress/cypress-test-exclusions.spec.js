'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')
const { existsSync, readFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const { sandboxCwd, useSandbox, getCiVisEvpProxyConfig, stopCiVisTestEnv, warmCypressBinary } = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { startWebAppServer, stopWebAppServer } = require('../ci-visibility/web-app-server')
const { DD_MAJOR, NODE_MAJOR } = require('../../version')
const { getCypressDependencies } = require('./dependencies')

const version = process.env.CYPRESS_VERSION || '14.5.4'
const moduleType = process.env.CYPRESS_MODULE_TYPE || 'commonJS'
const [cypressMajor, cypressMinor] = version.split('.').map(Number)
const supportsExperimental = version === 'latest' || cypressMajor > 13 ||
  (cypressMajor === 13 && cypressMinor >= 4)
// These exclusion scenarios require Cypress 12's test isolation, which makes Datadog retries available.
// Cypress 6 is only exercised on v5/Node 16 and does not provide that capability.
const isSupported = version !== '6.7.0' && NODE_MAJOR > 16 &&
  (NODE_MAJOR > 18 || version === '12.0.0' || version === '14.5.4')
const describeSupported = isSupported ? describe : describe.skip
const protection = 'test.test_management.prevent_failure_suppression'
const exclusion = 'test.test_management.no_auto_retry'
const suite = 'cypress/e2e/test-exclusions.js'

describeSupported(`Cypress ${version} ${moduleType} v${DD_MAJOR} test automation exclusions`, function () {
  this.timeout(120000)
  const dependencies = getCypressDependencies(version)
  if (process.env.CYPRESS_TEST_BROWSER === 'webkit') dependencies.push('playwright-webkit@1.56.1')
  useSandbox(dependencies, true)
  let cwd, receiver, childProcess, webApp

  before(async function () {
    this.timeout(240000)
    cwd = sandboxCwd()
    await warmCypressBinary(cwd)
    webApp = await startWebAppServer()
  })
  beforeEach(async () => { receiver = await new FakeCiVisIntake().start() })
  afterEach(async () => {
    await stopCiVisTestEnv({ childProcess, receiver })
    childProcess = undefined
  })
  after(async () => { if (webApp) await stopWebAppServer(webApp.server) })

  const properties = assignments => {
    receiver.setTestManagementTests({ cypress: { suites: { [suite]: { tests: assignments } } } })
  }
  const cypressEnvironment = () => {
    const env = getCiVisEvpProxyConfig(receiver.port)
    // This is the matrix selector, not Cypress configuration. Forwarding "latest"
    // overwrites Cypress.version and breaks native version-dependent fixture APIs.
    delete env.CYPRESS_VERSION
    return env
  }
  const run = async (mode, expectedExit, check, env = {}, command) => {
    childProcess = exec(command || (moduleType === 'esm'
      ? 'node ./cypress-esm-config.mjs'
      : `./node_modules/.bin/cypress run --spec ${suite}`), {
      cwd,
      env: {
        ...cypressEnvironment(),
        SPEC_PATTERN: suite,
        CYPRESS_BASE_URL: webApp.baseUrl,
        CYPRESS_EXCLUSIONS_MODE: mode,
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
        const tests = payloads.flatMap(({ payload }) => payload.events)
          .filter(event => event.type === 'test').map(event => event.content)
        assert.ok(tests.length, output)
        check(tests)
      },
      { hardTimeout: 90000 }
    )
    const [[exitCode]] = await Promise.all([exitPromise, eventsPromise]).catch(error => {
      error.message += `\nCypress output:\n${output}`
      throw error
    })
    assert.strictEqual(exitCode, expectedExit, output)
  }
  const named = (tests, name) => tests.filter(test => test.meta['test.name'] === name)

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
    await run('policy', 4, tests => {
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

  it('blocks ATR without preventing protected retries or changing unannotated controls', async () => {
    receiver.setSettings({ flaky_test_retries_enabled: true })
    await run('atr', 2, tests => {
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
      receiver.setKnownTests({ cypress: { 'cypress/e2e/known.js': ['known'] } })
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

  for (const mode of ['explicit', 'global', 'suite']) {
    it(`preserves ${mode} Cypress retries and reports them as external with ATR enabled`, async () => {
      receiver.setSettings({ flaky_test_retries_enabled: true })
      await run(mode, 0, tests => {
        assert.strictEqual(tests.length, 2)
        for (const test of tests) assert.strictEqual(test.meta[exclusion], 'true')
        assert.strictEqual(tests[1].meta['test.retry_reason'], 'external')
        assert.strictEqual(tests[1].meta['test.status'], 'pass')
      }, mode === 'global' ? { CYPRESS_RETRIES: '2' } : {})
    })
  }

  for (const lateMode of ['numeric', 'equal-object', 'equal-nested', 'returned-object', 'unchanged']) {
    for (const atrEnabled of [false, true]) {
      it(`preserves ${lateMode} native retries after manual plugin initialization (ATR=${atrEnabled})`, async () => {
        const command = './node_modules/.bin/cypress run ' +
          '--config-file ci-visibility/cypress-late-native-retries/config.js'
        const ledger = join(cwd, 'late-native-retry-executions.json')
        const expected = {
          'late native excluded': lateMode === 'unchanged' ? 1 : 3,
          'late native control': lateMode === 'unchanged' ? 1 : 3,
          'explicit local excluded': 2,
        }
        childProcess = exec(command, {
          cwd,
          env: {
            ...cypressEnvironment(),
            NODE_OPTIONS: '',
            DD_TRACE_ENABLED: 'false',
            CYPRESS_LATE_NATIVE_RETRIES_MODE: lateMode,
          },
        })
        let output = ''
        childProcess.stdout.on('data', chunk => { output += chunk })
        childProcess.stderr.on('data', chunk => { output += chunk })
        const [nativeExit] = await once(childProcess, 'exit')
        assert.strictEqual(nativeExit, lateMode === 'unchanged' ? 2 : 0, output)
        assert.deepStrictEqual(JSON.parse(readFileSync(ledger, 'utf8')), expected, output)
        rmSync(ledger)
        receiver.setSettings({ flaky_test_retries_enabled: atrEnabled })
        if (lateMode === 'unchanged' && atrEnabled) expected['late native control'] = 3
        const expectedExit = lateMode === 'unchanged' ? atrEnabled ? 1 : 2 : 0
        await run('late-native', expectedExit, tests => {
          assert.deepStrictEqual(JSON.parse(readFileSync(ledger, 'utf8')), expected)
          assert.strictEqual(tests.length, Object.values(expected).reduce((sum, count) => sum + count, 0))
          for (const [name, count] of Object.entries(expected)) {
            const attempts = named(tests, name)
            assert.strictEqual(attempts.length, count, name)
            assert.strictEqual(attempts.at(-1).meta['test.status'], count === 1 ? 'fail' : 'pass', name)
            assert.strictEqual(attempts[0].meta[exclusion], name === 'late native control' ? undefined : 'true')
            for (const retry of attempts.slice(1)) {
              assert.strictEqual(retry.meta['test.retry_reason'],
                atrEnabled && name === 'late native control' ? 'auto_test_retry' : 'external', name)
            }
          }
        }, { NODE_OPTIONS: '', CYPRESS_LATE_NATIVE_RETRIES_MODE: lateMode }, command)
      })
    }
  }

  for (const mode of [
    'browser-retries', 'browser-same-budget', 'inherited-mode', 'browser-runtime',
    'browser-runtime-global', 'browser-runtime-persistent', 'browser-runtime-suite',
    'experimental-native', 'experimental-native-zero',
    'experimental-native-threshold', 'experimental-native-disabled',
    'experimental-native-disabled-zero', 'experimental-native-disabled-one', 'experimental-native-threshold-dynamic',
  ]) {
    for (const atrEnabled of [false, true]) {
      const experimentalMode = mode.startsWith('experimental-native')
      const disabledNative = mode.includes('-disabled')
      const thresholdNative = mode.includes('-threshold')
      const dynamicRetries = mode.endsWith('-dynamic')
      const atrBudget = mode.endsWith('-zero') ? 0 : mode.endsWith('-one') ? 1 : thresholdNative ? 2 : 4
      const boundaryTest = experimentalMode && !supportsExperimental ? it.skip : it
      boundaryTest(`preserves ${mode} native retry executions (ATR=${atrEnabled})`, async () => {
        const boundarySuite = 'cypress/e2e/native-retry-boundaries.cy.js'
        const ledger = join(cwd, 'native-retry-executions.json')
        const nativeAttempts = thresholdNative ? 5 : disabledNative ? 1 : 3
        const experimentalEnvironment = experimentalMode
          ? {
              CYPRESS_EXPERIMENTAL_RETRIES: thresholdNative
                ? 'threshold'
                : disabledNative ? 'disabled' : 'true',
            }
          : {}
        const expected = {
          'excluded recovery': mode === 'inherited-mode' || mode === 'browser-runtime' ? 1 : nativeAttempts,
          'excluded persistent': mode === 'inherited-mode' || mode === 'browser-runtime'
            ? 1
            : thresholdNative ? 3 : nativeAttempts,
          'excluded explicit zero': 1,
          'ordinary control': mode === 'browser-runtime' ? 1 : nativeAttempts,
          ...(mode.startsWith('browser-runtime') && { 'changes runtime retries': 1 }),
          ...(['browser-runtime-global', 'browser-runtime-persistent', 'browser-runtime-suite'].includes(mode) &&
            { 'excluded after zero': 3 }),
        }
        const command = `./node_modules/.bin/cypress run --spec ${boundarySuite}`
        childProcess = exec(`${command} --config supportFile=false`, {
          cwd,
          env: {
            ...cypressEnvironment(),
            NODE_OPTIONS: '',
            DD_TRACE_ENABLED: 'false',
            SPEC_PATTERN: boundarySuite,
            CYPRESS_EXCLUSIONS_MODE: mode,
            ...experimentalEnvironment,
          },
        })
        let output = ''
        childProcess.stdout.on('data', chunk => { output += chunk })
        childProcess.stderr.on('data', chunk => { output += chunk })
        const [nativeExit] = await once(childProcess, 'exit')
        const expectedExit = thresholdNative
          ? 2
          : mode === 'browser-runtime' || experimentalMode
            ? 4
            : mode === 'inherited-mode' ? 3 : 2
        assert.strictEqual(nativeExit, expectedExit, output)
        assert.deepStrictEqual(JSON.parse(readFileSync(ledger, 'utf8')), expected, output)
        rmSync(ledger)
        receiver.setSettings({ flaky_test_retries_enabled: atrEnabled })
        if (mode === 'browser-runtime' && atrEnabled) expected['ordinary control'] = 3
        if (experimentalMode && atrEnabled) {
          expected['ordinary control'] = disabledNative
            ? Math.min(atrBudget + 1, 3)
            : Math.max(nativeAttempts, atrBudget + 1)
        }
        const instrumentedExit = atrEnabled && (mode === 'browser-runtime' || (disabledNative && atrBudget >= 2))
          ? 3
          : expectedExit
        await run(mode, instrumentedExit, tests => {
          assert.deepStrictEqual(JSON.parse(readFileSync(ledger, 'utf8')), expected)
          assert.strictEqual(tests.length, Object.values(expected).reduce((sum, count) => sum + count, 0))
          for (const name of Object.keys(expected)) {
            const attempts = named(tests, `native retry boundaries ${name}`)
            assert.strictEqual(attempts.length, expected[name], name)
            const annotated = name.startsWith('excluded')
            assert.strictEqual(attempts.at(-1).meta['test.status'],
              name.endsWith('persistent') || name === 'excluded explicit zero' ||
                ((mode === 'inherited-mode' || mode === 'browser-runtime' || disabledNative) &&
                  name === 'excluded recovery') ||
                (disabledNative && expected['ordinary control'] < 3 && name === 'ordinary control') ||
                (mode === 'browser-runtime' && !atrEnabled && name === 'ordinary control')
                ? 'fail'
                : 'pass', name)
            if (experimentalMode) {
              assert.strictEqual(attempts.at(-1).meta['test.final_status'],
                ((thresholdNative && name === 'excluded recovery') ||
                  ((thresholdNative || disabledNative) && name === 'ordinary control' && expected[name] >= 3))
                  ? 'pass'
                  : 'fail', name)
            }
            for (const test of attempts) assert.strictEqual(test.meta[exclusion], annotated ? 'true' : undefined, name)
            for (const retry of attempts.slice(1)) {
              assert.strictEqual(retry.meta['test.retry_reason'],
                atrEnabled && (atrBudget > 0 || dynamicRetries) && !annotated &&
                  !['inherited-mode', 'browser-runtime-suite'].includes(mode)
                  ? 'auto_test_retry'
                  : 'external', name)
            }
          }
        }, {
          SPEC_PATTERN: boundarySuite,
          ...experimentalEnvironment,
          DD_CIVISIBILITY_FLAKY_RETRY_COUNT: mode === 'browser-same-budget' ? '2' : String(atrBudget),
          ...(dynamicRetries && {
            DD_CIVISIBILITY_DYNAMIC_ATR_ENABLED: 'true',
            DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS: '1,1,1,1,1',
          }),
        }, command)
      })
    }
  }

  for (const mode of ['protection', 'protection-pass', 'quarantine', 'excluded-quarantine', 'excluded-disabled']) {
    it(`verifies independent ${mode} policy with a sole callback ledger`, async () => {
      const independentSuite = 'cypress/e2e/independent-exclusions.cy.js'
      const ledger = join(cwd, 'independent-exclusion-executions.json')
      rmSync(ledger, { force: true })
      const protectedTest = mode.startsWith('protection')
      const excluded = mode.startsWith('excluded')
      const disabled = mode === 'excluded-disabled'
      const passing = mode === 'protection-pass'
      receiver.setSettings({
        flaky_test_retries_enabled: false,
        known_tests_enabled: true,
        test_management: { enabled: true, attempt_to_fix_retries: 2 },
      })
      receiver.setKnownTests({ cypress: { [independentSuite]: ['sole'] } })
      receiver.setTestManagementTests({
        cypress: {
          suites: {
            [independentSuite]: {
              tests: {
                sole: {
                  properties: {
                    quarantined: true,
                    ...(protectedTest || disabled ? { disabled: true } : {}),
                    ...(excluded ? { attempt_to_fix: true } : {}),
                  },
                },
              },
            },
          },
        },
      })
      await run(mode, mode === 'protection' ? 1 : 0, tests => {
        const executions = existsSync(ledger) ? JSON.parse(readFileSync(ledger, 'utf8')).executions : 0
        assert.strictEqual(executions, disabled ? 0 : 1)
        assert.strictEqual(tests.length, 1)
        const [test] = tests
        assert.strictEqual(test.meta['test.status'], disabled ? 'skip' : passing ? 'pass' : 'fail')
        assert.strictEqual(test.meta['test.final_status'], protectedTest ? passing ? 'pass' : 'fail' : 'skip')
        assert.strictEqual(test.meta[protection], protectedTest ? 'true' : undefined)
        assert.strictEqual(test.meta[exclusion], excluded ? 'true' : undefined)
        assert.strictEqual(test.meta['test.test_management.is_quarantined'], 'true')
        assert.strictEqual(test.meta['test.test_management.is_test_disabled'],
          protectedTest || disabled ? 'true' : undefined)
        assert.strictEqual(test.meta['test.test_management.is_attempt_to_fix'], excluded ? 'true' : undefined)
        assert.strictEqual(test.meta['test.test_management.attempt_to_fix_passed'], undefined)
        assert.strictEqual(test.meta['test.is_retry'], undefined)
      }, { SPEC_PATTERN: independentSuite }, `./node_modules/.bin/cypress run --spec ${independentSuite}`)
    })
  }

  it('keeps a sole protected failure blocking', async () => {
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

  it('preserves Test Impact Analysis selection on an annotated test', async () => {
    receiver.setSettings({ itr_enabled: true, tests_skipping: true })
    receiver.setSuitesToSkip([{ type: 'test', attributes: { suite, name: 'sole' } }])
    await run('sole', 0, tests => {
      assert.strictEqual(tests.length, 1)
      assert.strictEqual(tests[0].meta['test.status'], 'skip')
      assert.strictEqual(tests[0].meta['test.skipped_by_itr'], 'true')
      assert.strictEqual(tests[0].meta[protection], 'true')
      assert.strictEqual(tests[0].meta[exclusion], 'true')
    })
  })

  it('reports annotations when every declaration is explicitly skipped', async () => {
    await run('all-skipped', 0, tests => {
      assert.strictEqual(tests.length, 1)
      assert.strictEqual(tests[0].meta['test.status'], 'skip')
      assert.strictEqual(tests[0].meta[protection], 'true')
      assert.strictEqual(tests[0].meta[exclusion], 'true')
    })
  })

  // Experimental strategy configuration was added in Cypress13.4.
  const experimental = supportsExperimental ? it : it.skip
  experimental('preserves experimental native retry budgets and explicit zero overrides', async () => {
    receiver.setSettings({ flaky_test_retries_enabled: false })
    await run('experimental', 3, tests => {
      assert.strictEqual(tests.length, 7)
      for (const name of ['native experimental excluded', 'native experimental control']) {
        const attempts = named(tests, name)
        assert.strictEqual(attempts.length, 3, name)
        for (const test of attempts) {
          assert.strictEqual(test.meta[exclusion], name.endsWith('excluded') ? 'true' : undefined)
        }
        assert.strictEqual(attempts[1].meta['test.retry_reason'], 'external')
        assert.strictEqual(attempts[2].meta['test.retry_reason'], 'external')
      }
      const zero = named(tests, 'native experimental zero')
      assert.strictEqual(zero.length, 1)
      assert.strictEqual(zero[0].meta[exclusion], 'true')
    }, { CYPRESS_EXPERIMENTAL_RETRIES: 'true' })
  })

  experimental('reports the native experimental aggregate failure when the last attempt passes', async () => {
    receiver.setSettings({ flaky_test_retries_enabled: false })
    await run('experimental-mixed', 1, tests => {
      assert.strictEqual(tests.length, 3)
      assert.strictEqual(tests[0].meta['test.status'], 'fail')
      assert.strictEqual(tests.at(-1).meta['test.status'], 'pass')
      assert.strictEqual(tests.at(-1).meta['test.final_status'], 'fail')
      for (const test of tests.slice(1)) assert.strictEqual(test.meta['test.retry_reason'], 'external')
    }, { CYPRESS_EXPERIMENTAL_RETRIES: 'true' })
  })

  it('preserves distinct native callsites for executable declarations', async () => {
    const sourceSuite = 'cypress/e2e/declaration-source.cy.js'
    const browserOption = process.env.CYPRESS_TEST_BROWSER ? ' --browser "$CYPRESS_TEST_BROWSER"' : ''
    const webkitOption = process.env.CYPRESS_TEST_BROWSER === 'webkit' ? ' --config experimentalWebKitSupport=true' : ''
    await run('source', 0, tests => {
      assert.strictEqual(tests.length, 2)
      const [ordinary] = named(tests, 'ordinary declaration source')
      const [annotated] = named(tests, 'annotated declaration source')
      assert.strictEqual(ordinary.meta['test.status'], 'pass')
      assert.strictEqual(annotated.meta['test.status'], 'pass')
      assert.strictEqual(ordinary.meta[exclusion], undefined)
      assert.strictEqual(annotated.meta[exclusion], 'true')
    }, { SPEC_PATTERN: sourceSuite },
    `./node_modules/.bin/cypress run --spec ${sourceSuite}${browserOption}${webkitOption}`)
  })

  it('retains annotations inside explicitly pending suites without executing their callbacks', async () => {
    const pendingSuite = 'cypress/e2e/skipped-suite-annotations.js'
    const browserOption = process.env.CYPRESS_TEST_BROWSER ? ' --browser "$CYPRESS_TEST_BROWSER"' : ''
    const webkit = process.env.CYPRESS_TEST_BROWSER === 'webkit'
    const nativeConfig = webkit ? 'supportFile=false,experimentalWebKitSupport=true' : 'supportFile=false'
    const tracingConfig = webkit ? ' --config experimentalWebKitSupport=true' : ''
    const nativeCommand = `./node_modules/.bin/cypress run --spec ${pendingSuite}` +
      ` --config ${nativeConfig}${browserOption}`
    childProcess = exec(nativeCommand, {
      cwd,
      env: {
        ...cypressEnvironment(),
        NODE_OPTIONS: '',
        DD_TRACE_ENABLED: 'false',
        SPEC_PATTERN: pendingSuite,
      },
    })
    let output = ''
    childProcess.stdout.on('data', chunk => { output += chunk })
    childProcess.stderr.on('data', chunk => { output += chunk })
    const [exitCode] = await once(childProcess, 'exit')
    assert.strictEqual(exitCode, 0, output)
    assert.match(output, /1 passing/)
    assert.match(output, /20 pending/)
    assert.doesNotMatch(output, /skipped callback executed/)

    await run('pending-suite', 0, tests => {
      assert.strictEqual(tests.length, 21)
      const skipped = tests.filter(test => test.meta['test.status'] === 'skip')
      assert.strictEqual(skipped.length, 20)
      for (const test of skipped) {
        const name = test.meta['test.name']
        const both = name.endsWith('both flags') || name.endsWith('nested skip flags')
        assert.strictEqual(test.meta[protection], both || name.endsWith('protected flag') ? 'true' : undefined, name)
        assert.strictEqual(test.meta[exclusion], both || name.endsWith('retry flag') ? 'true' : undefined, name)
      }
      const [executed] = named(tests, 'execution after pending declarations')
      assert.strictEqual(executed.meta['test.status'], 'pass')
    }, { SPEC_PATTERN: pendingSuite },
    `./node_modules/.bin/cypress run --spec ${pendingSuite}${tracingConfig}${browserOption}`)
  })

  it('reads the public exclusion mode before declaring tests', async () => {
    await run('mode-selection', 0, tests => {
      assert.strictEqual(tests.length, 1)
      assert.strictEqual(tests[0].meta['test.name'], 'mode selected')
      assert.strictEqual(tests[0].meta['test.status'], 'pass')
      assert.strictEqual(tests[0].meta[exclusion], 'true')
    })
  })

  it('keeps manually loaded support harmless when tracing is disabled', async () => {
    childProcess = exec(
      './node_modules/.bin/cypress run --config-file ci-visibility/cypress-exclusions-manual/config.js', {
        cwd,
        env: {
          ...cypressEnvironment(),
          NODE_OPTIONS: '',
          DD_TRACE_ENABLED: 'false',
          CYPRESS_ROOT_SETUP_MODE: 'skip',
        },
      }
    )
    let output = ''
    childProcess.stdout.on('data', chunk => { output += chunk })
    childProcess.stderr.on('data', chunk => { output += chunk })
    const [exitCode] = await once(childProcess, 'exit')
    assert.strictEqual(exitCode, 0, output)
    assert.doesNotMatch(output, /task.*was not handled/)
  })

  for (const mode of ['fail', 'skip']) {
    it(`reports annotations when an earlier root setup hook must ${mode}`, async () => {
      await run(mode, mode === 'fail' ? 1 : 0, tests => {
        assert.strictEqual(tests.length, 2)
        const [annotated] = named(tests, 'annotated setup skip')
        const [control] = named(tests, 'ordinary setup skip')
        assert.strictEqual(annotated.meta['test.status'], 'skip')
        assert.strictEqual(annotated.meta[protection], 'true')
        assert.strictEqual(annotated.meta[exclusion], 'true')
        assert.strictEqual(control.meta['test.status'], 'skip')
        assert.strictEqual(control.meta[protection], undefined)
        assert.strictEqual(control.meta[exclusion], undefined)
      }, { NODE_OPTIONS: '', CYPRESS_ROOT_SETUP_MODE: mode },
      './node_modules/.bin/cypress run --config-file ci-visibility/cypress-exclusions-manual/config.js')
    })
  }

  for (const mode of ['duplicate-skipped', 'duplicate-mixed']) {
    it(`retains separate annotations for ${mode} declarations with identical titles`, async () => {
      await run(mode, 0, tests => {
        assert.strictEqual(tests.length, 3)
        const actual = tests.map(test => JSON.stringify([
          test.meta['test.status'], test.meta[protection], test.meta[exclusion],
        ])).sort()
        const expected = [
          [mode === 'duplicate-mixed' ? 'pass' : 'skip', 'true', undefined],
          ['skip', undefined, 'true'],
          ['skip', undefined, undefined],
        ].map(test => JSON.stringify(test)).sort()
        assert.deepStrictEqual(actual, expected)
      })
    })
  }

  it('restores ordinary quarantine policy when the annotation is removed', async () => {
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

  it('retains test-local retries zero when global and Datadog retries are enabled', async () => {
    receiver.setSettings({ flaky_test_retries_enabled: true })
    await run('override-zero', 1, tests => {
      assert.strictEqual(tests.length, 1)
      assert.strictEqual(tests[0].meta[exclusion], 'true')
      assert.strictEqual(tests[0].meta['test.is_retry'], undefined)
    }, { CYPRESS_RETRIES: '2' })
  })
})
