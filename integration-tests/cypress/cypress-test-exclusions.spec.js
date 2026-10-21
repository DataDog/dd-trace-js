'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')

const { sandboxCwd, useSandbox, getCiVisEvpProxyConfig, stopCiVisTestEnv, warmCypressBinary } = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { startWebAppServer, stopWebAppServer } = require('../ci-visibility/web-app-server')
const { DD_MAJOR, NODE_MAJOR } = require('../../version')
const { getCypressDependencies } = require('./dependencies')

const version = process.env.CYPRESS_VERSION || '14.5.4'
const moduleType = process.env.CYPRESS_MODULE_TYPE || 'commonJS'
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
  const run = async (mode, expectedExit, check, env = {}, command) => {
    childProcess = exec(command || (moduleType === 'esm'
      ? 'node ./cypress-esm-config.mjs'
      : `./node_modules/.bin/cypress run --spec ${suite}`), {
      cwd,
      env: {
        ...getCiVisEvpProxyConfig(receiver.port),
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

  for (const atrEnabled of [false, true]) {
    it(`preserves native retries assigned after manual plugin initialization (ATR=${atrEnabled})`, async () => {
      receiver.setSettings({ flaky_test_retries_enabled: atrEnabled })
      await run('late-native', 0, tests => {
        for (const [name, count] of [
          ['late native excluded', 3], ['late native control', 3], ['explicit local excluded', 2],
        ]) {
          const attempts = named(tests, name)
          assert.strictEqual(attempts.length, count, name)
          assert.strictEqual(attempts.at(-1).meta['test.status'], 'pass', name)
          for (const retry of attempts.slice(1)) {
            assert.strictEqual(retry.meta['test.retry_reason'],
              atrEnabled && name === 'late native control' ? 'auto_test_retry' : 'external', name)
          }
        }
      }, { NODE_OPTIONS: '' },
      './node_modules/.bin/cypress run --config-file ci-visibility/cypress-late-native-retries/config.js')
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
  const [major, minor] = version.split('.').map(Number)
  const experimental = version === 'latest' || major > 13 || (major === 13 && minor >= 4) ? it : it.skip
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
        ...getCiVisEvpProxyConfig(receiver.port),
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
          ...getCiVisEvpProxyConfig(receiver.port),
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
