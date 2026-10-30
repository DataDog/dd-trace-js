'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')
const { existsSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { createServer } = require('node:http')
const { join } = require('node:path')

const { sandboxCwd, useSandbox, getCiVisEvpProxyConfig, stopCiVisTestEnv, warmCypressBinary } = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { startWebAppServer, stopWebAppServer } = require('../ci-visibility/web-app-server')
const { DD_MAJOR, NODE_MAJOR } = require('../../version')
const { getCypressDependencies } = require('./dependencies')
const createExclusionsShard = require('./exclusions-shard')

const it = createExclusionsShard(global.it)

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

  for (const lateMode of [
    'numeric', 'numeric-open', 'raw-reference', 'indirect-support', 'indirect-returned-support',
    'equal-object', 'equal-nested', 'returned-object', 'unchanged',
    'root-deleted', 'root-redefined', 'root-deleted-returned', 'root-deleted-partial', 'root-deleted-alias',
    'open-only', 'returned-open', 'spread-open', 'returned-open-preloaded', 'returned-object-preloaded',
    'browser-partial-before-support', 'saved-reference', 'saved-reference-changed',
    'after-handoff-equal-preloaded', 'during-init', 'during-init-partial', 'freeze-during-init', 'readonly-before-init',
    'freeze-retries', 'seal-retries',
    'returned-experimental', 'returned-experimental-preloaded', 'returned-getter', 'returned-getter-preloaded',
    'node-saved-options', 'node-saved-options-descriptor', 'getter-before-init', 'getter-during-init',
    'browser-queued-native-before-support',
    'browser-equal-before-support', 'browser-equal-before-support-preloaded',
    'browser-equal-before-support-reuse-preloaded',
    'browser-equal-before-support-returned', 'browser-equal-before-support-returned-preloaded',
    'browser-equal-before-support-returned-alternate', 'browser-equal-before-support-returned-alternate-preloaded',
  ]) {
    for (const atrEnabled of [false, true]) {
      const savedNodeOptions = lateMode.startsWith('node-saved-options')
      const lateExperimental = lateMode.startsWith('returned-experimental') || savedNodeOptions
      const returnedGetter = lateMode.startsWith('returned-getter')
      const lateTest = lateExperimental && !supportsExperimental ? it.skip : it
      const title = `preserves ${lateMode} native retries after manual plugin initialization (ATR=${atrEnabled})`
      lateTest(title, async () => {
        const command = './node_modules/.bin/cypress run ' +
          '--config-file ci-visibility/cypress-late-native-retries/config.js'
        const ledger = join(cwd, 'late-native-retry-executions.json')
        const alternateLedger = join(cwd, 'late-support-alternate-executions.json')
        const noRunOverride = [
          'unchanged', 'root-deleted', 'root-deleted-partial', 'freeze-retries', 'seal-retries',
          'open-only', 'returned-open', 'spread-open', 'returned-open-preloaded',
          'browser-partial-before-support', 'saved-reference', 'after-handoff-equal-preloaded',
        ].includes(lateMode)
        const expected = {
          'late native excluded': returnedGetter ? 2 : noRunOverride ? 1 : 3,
          'late native control': returnedGetter ? 2 : noRunOverride ? 1 : 3,
          'explicit local excluded': 2,
          ...(lateMode.includes('-reuse') && { 'support reuse smoke': 1 }),
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
        assert.strictEqual(nativeExit, lateExperimental || returnedGetter ? 2 : noRunOverride ? 2 : 0, output)
        if (returnedGetter) {
          assert.deepStrictEqual(JSON.parse(readFileSync(join(cwd, 'returned-retry-getter-reads.json'), 'utf8')),
            { reads: 1 }, output)
        }
        assert.deepStrictEqual(JSON.parse(readFileSync(ledger, 'utf8')), expected, output)
        rmSync(ledger)
        if (lateMode.includes('-alternate')) {
          assert.deepStrictEqual(JSON.parse(readFileSync(alternateLedger, 'utf8')), { executed: 1 })
          rmSync(alternateLedger)
        }
        receiver.setSettings({ flaky_test_retries_enabled: atrEnabled })
        const nativeOnlyControl = [
          'returned-open', 'browser-partial-before-support', 'root-deleted', 'root-deleted-partial',
        ].includes(lateMode)
        if (noRunOverride && atrEnabled && !nativeOnlyControl) expected['late native control'] = 3
        if (savedNodeOptions && atrEnabled) expected['late native control'] = 5
        const expectedExit = lateExperimental || returnedGetter
          ? 2
          : noRunOverride ? atrEnabled && !nativeOnlyControl ? 1 : 2 : 0
        await run('late-native', expectedExit, tests => {
          if (returnedGetter) {
            assert.deepStrictEqual(JSON.parse(readFileSync(join(cwd, 'returned-retry-getter-reads.json'), 'utf8')),
              { reads: 1 })
          }
          assert.deepStrictEqual(JSON.parse(readFileSync(ledger, 'utf8')), expected)
          if (lateMode.includes('-alternate')) {
            assert.deepStrictEqual(JSON.parse(readFileSync(alternateLedger, 'utf8')), { executed: 1 })
          }
          assert.strictEqual(tests.length, Object.values(expected).reduce((sum, count) => sum + count, 0))
          for (const [name, count] of Object.entries(expected)) {
            const attempts = named(tests, name)
            assert.strictEqual(attempts.length, count, name)
            // The fixture passes only at retry2; later experimental control attempts fail again.
            assert.strictEqual(attempts.at(-1).meta['test.status'],
              (count === 1 && name !== 'support reuse smoke') ||
                (returnedGetter && name !== 'explicit local excluded' && count < 3) ||
                (savedNodeOptions && atrEnabled && name === 'late native control')
                ? 'fail'
                : 'pass', name)
            if (lateExperimental) {
              assert.strictEqual(attempts.at(-1).meta['test.final_status'],
                name === 'explicit local excluded' ? 'pass' : 'fail', name)
            }
            assert.strictEqual(attempts[0].meta[exclusion], name === 'late native control' ? undefined : 'true')
            if (lateMode.includes('indirect')) {
              for (const attempt of attempts) assert.strictEqual(attempt.meta['manual.early_teardown'], 'preserved')
            }
            for (const retry of attempts.slice(1)) {
              assert.strictEqual(retry.meta['test.retry_reason'],
                atrEnabled && name === 'late native control' ? 'auto_test_retry' : 'external', name)
            }
          }
        }, {
          ...(lateMode.endsWith('-preloaded') ? {} : { NODE_OPTIONS: '' }),
          CYPRESS_LATE_NATIVE_RETRIES_MODE: lateMode,
          ...((lateMode === 'numeric-open' || savedNodeOptions) && { DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '4' }),
        }, command)
      })
    }
  }

  for (const mode of [
    'browser-saved-local', 'browser-all-saved-local',
    'browser-undefined-root', 'browser-experimental-strategy',
    'browser-numeric-open', 'browser-all-numeric-open',
    'browser-descriptor', 'browser-all-descriptor-root', 'browser-all-descriptor-same',
    'browser-field-accessor', 'experimental-native-field-accessor',
    'experimental-native-root-accessor', 'experimental-native-detached-accessor',
    'browser-object-config-getter', 'browser-accessor-root', 'browser-retries', 'browser-same-budget', 'inherited-mode',
    'browser-runtime', 'browser-inactive-mode',
    'browser-runtime-global', 'browser-runtime-persistent', 'browser-runtime-suite',
    'browser-delete-mode', 'browser-partial-root',
    'browser-all-equal', 'browser-all-inactive', 'browser-all-root',
    'browser-same-reference', 'browser-saved-reference',
    'experimental-native', 'experimental-native-zero',
    'experimental-native-same-options', 'experimental-native-locked-options', 'experimental-native-assigned-options',
    'experimental-native-locked-detached', 'experimental-native-checkpoint',
    'experimental-native-saved-options', 'experimental-native-saved-options-descriptor',
    'experimental-native-cross-root-options', 'experimental-native-cross-root-detached',
    'experimental-native-detached', 'experimental-native-detached-delete',
    'experimental-native-threshold', 'experimental-native-disabled',
    'experimental-native-disabled-zero', 'experimental-native-disabled-one', 'experimental-native-threshold-dynamic',
  ]) {
    for (const atrEnabled of [false, true]) {
      const browserExperimental = mode === 'browser-experimental-strategy'
      const numericNative = mode.includes('numeric-open')
      const fieldAccessor = ['browser-field-accessor', 'experimental-native-field-accessor'].includes(mode)
      const rootAccessor = mode === 'experimental-native-root-accessor'
      const observedAccessor = fieldAccessor || rootAccessor
      // Experimental-config override validation adds a getter read before general validation and assignment.
      const objectGetterReads = supportsExperimental ? 3 : 2
      // Cypress <15.17 retains the old restoration callback across tests without overrides.
      const legacySavedLocal = ['browser-saved-local', 'browser-all-saved-local'].includes(mode) &&
        version !== 'latest' && (cypressMajor < 15 || (cypressMajor === 15 && cypressMinor < 17))
      const descriptorNative = ['browser-descriptor', 'browser-all-descriptor-root'].includes(mode)
      const zeroNative = legacySavedLocal || [
        'inherited-mode', 'browser-runtime', 'browser-inactive-mode', 'browser-delete-mode', 'browser-partial-root',
        'browser-all-inactive', 'browser-same-reference', 'browser-saved-reference', 'browser-all-descriptor-same',
      ].includes(mode)
      const browserZeroNative = legacySavedLocal || [
        'browser-runtime', 'browser-inactive-mode', 'browser-all-inactive',
        'browser-same-reference', 'browser-saved-reference', 'browser-all-descriptor-same',
      ].includes(mode)
      const zeroControl = ['browser-delete-mode', 'browser-partial-root'].includes(mode)
      const experimentalMode = mode.startsWith('experimental-native') || browserExperimental
      const disabledNative = mode.includes('-disabled')
      const thresholdNative = mode.includes('-threshold')
      const dynamicRetries = mode.endsWith('-dynamic')
      const atrBudget = mode.endsWith('-zero') ? 0 : mode.endsWith('-one') ? 1 : thresholdNative ? 2 : 4
      const boundaryTest = experimentalMode && !supportsExperimental ? it.skip : it
      boundaryTest(`preserves ${mode} native retry executions (ATR=${atrEnabled})`, async () => {
        const boundarySuite = 'cypress/e2e/native-retry-boundaries.cy.js'
        const ledger = join(cwd, 'native-retry-executions.json')
        const nativeAttempts = fieldAccessor
          ? 4
          : mode === 'browser-object-config-getter'
            ? objectGetterReads + 1
            : mode === 'experimental-native-checkpoint'
              ? 5
              : descriptorNative || (mode.includes('-detached') && mode !== 'experimental-native-detached-accessor')
                ? 4
                : thresholdNative ? 5 : disabledNative ? 1 : 3
        const experimentalEnvironment = experimentalMode && !browserExperimental
          ? {
              CYPRESS_EXPERIMENTAL_RETRIES: thresholdNative
                ? 'threshold'
                : disabledNative ? 'disabled' : 'true',
            }
          : {}
        if (process.env.CYPRESS_ACCESSOR_DIAGNOSTICS_DIR) {
          experimentalEnvironment.CYPRESS_ACCESSOR_DIAGNOSTICS = 'true'
        }
        if (numericNative) experimentalEnvironment.CYPRESS_RETRIES_AS_NUMBER = '2'
        if (mode === 'browser-accessor-root') experimentalEnvironment.CYPRESS_RETRIES = '0'
        if (mode === 'browser-undefined-root') experimentalEnvironment.CYPRESS_RETRIES = '2'
        const standardRecovery = descriptorNative ||
          ['browser-object-config-getter', 'browser-field-accessor'].includes(mode)
        const expected = {
          ...(['browser-saved-local', 'browser-all-saved-local'].includes(mode) && {
            'initial local control': 1, 'captures local retries': 1, 'restores local retries': 1,
          }),
          'excluded recovery': zeroNative
            ? 1
            : standardRecovery ? 3 : nativeAttempts,
          'excluded persistent': zeroNative
            ? 1
            : thresholdNative ? 3 : nativeAttempts,
          'excluded explicit zero': mode === 'browser-accessor-root' || rootAccessor ? 3 : 1,
          'ordinary control': zeroControl || browserZeroNative
            ? 1
            : standardRecovery ? 3 : nativeAttempts,
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
            CYPRESS_MATCHED_NATIVE_HOOKS: observedAccessor ? 'true' : undefined,
            ...experimentalEnvironment,
          },
        })
        let output = ''
        childProcess.stdout.on('data', chunk => { output += chunk })
        childProcess.stderr.on('data', chunk => { output += chunk })
        const [nativeExit] = await once(childProcess, 'exit')
        const accessorReads = observedAccessor
          ? JSON.parse(readFileSync(join(cwd, 'native-retry-accessor-reads.json'), 'utf8'))
          : undefined
        if (accessorReads && process.env.CYPRESS_ACCESSOR_DIAGNOSTICS_DIR) {
          writeFileSync(join(process.env.CYPRESS_ACCESSOR_DIAGNOSTICS_DIR, `native-${mode}-${atrEnabled}.json`),
            JSON.stringify(accessorReads))
        }
        const expectedExit = thresholdNative
          ? 2
          : zeroControl || browserZeroNative || experimentalMode
            ? 4
            : mode === 'inherited-mode' ? 3 : 2
        if (mode === 'browser-object-config-getter') {
          assert.deepStrictEqual(JSON.parse(readFileSync(join(cwd, 'native-config-getter-reads.json'), 'utf8')),
            { reads: objectGetterReads, budget: objectGetterReads })
        }
        assert.strictEqual(nativeExit, expectedExit, output)
        assert.deepStrictEqual(JSON.parse(readFileSync(ledger, 'utf8')), expected, output)
        rmSync(ledger)
        receiver.setSettings({ flaky_test_retries_enabled: atrEnabled })
        if (browserZeroNative && atrEnabled) expected['ordinary control'] = 3
        if (experimentalMode && !browserExperimental && atrEnabled && !mode.includes('-detached') &&
          mode !== 'experimental-native-field-accessor' && mode !== 'experimental-native-detached-accessor') {
          expected['ordinary control'] = disabledNative
            ? Math.min(atrBudget + 1, 3)
            : Math.max(nativeAttempts, atrBudget + 1)
        }
        const instrumentedExit = atrEnabled &&
          (browserZeroNative || (disabledNative && atrBudget >= 2))
          ? 3
          : expectedExit
        await run(mode, instrumentedExit, tests => {
          assert.deepStrictEqual(JSON.parse(readFileSync(ledger, 'utf8')), expected)
          if (accessorReads) {
            const actualReads = JSON.parse(readFileSync(join(cwd, 'native-retry-accessor-reads.json'), 'utf8'))
            if (process.env.CYPRESS_ACCESSOR_DIAGNOSTICS_DIR) {
              writeFileSync(join(process.env.CYPRESS_ACCESSOR_DIAGNOSTICS_DIR, `sdk-${mode}-${atrEnabled}.json`),
                JSON.stringify(actualReads))
            }
            assert.strictEqual(actualReads.excludedReads, accessorReads.excludedReads)
            // The ordinary control gains two ATR attempts; excluded tests keep the identical native workload.
            if (!rootAccessor || !atrEnabled) assert.strictEqual(actualReads.reads, accessorReads.reads)
          }
          if (mode === 'browser-object-config-getter') {
            assert.deepStrictEqual(JSON.parse(readFileSync(join(cwd, 'native-config-getter-reads.json'), 'utf8')),
              { reads: objectGetterReads, budget: objectGetterReads })
          }
          assert.deepStrictEqual(JSON.parse(readFileSync(ledger, 'utf8')), expected)
          assert.strictEqual(tests.length, Object.values(expected).reduce((sum, count) => sum + count, 0))
          for (const name of Object.keys(expected)) {
            const attempts = named(tests, `native retry boundaries ${name}`)
            assert.strictEqual(attempts.length, expected[name], name)
            const annotated = name.startsWith('excluded')
            assert.strictEqual(attempts.at(-1).meta['test.status'],
              name.endsWith('persistent') || name === 'excluded explicit zero' ||
                ((zeroNative || disabledNative) &&
                  name === 'excluded recovery') ||
                (disabledNative && expected['ordinary control'] < 3 && name === 'ordinary control') ||
                ((browserZeroNative && !atrEnabled ||
                  zeroControl) && name === 'ordinary control')
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
          DD_CIVISIBILITY_FLAKY_RETRY_COUNT: ['browser-same-budget', 'browser-all-equal'].includes(mode)
            ? '2'
            : String(atrBudget),
          ...(dynamicRetries && {
            DD_CIVISIBILITY_DYNAMIC_ATR_ENABLED: 'true',
            DD_CIVISIBILITY_DYNAMIC_ATR_BUCKETS: '1,1,1,1,1',
          }),
        }, command)
      })
    }
  }

  for (const mode of ['descriptor-root', 'raw-after', 'raw-before', 'raw-saved', 'raw-detached',
    'locked-root', 'locked-root-reset', 'locked-root-unchanged']) {
    for (const atrEnabled of [false, true]) {
      it(`reconciles ${mode} browser retry object writes (ATR=${atrEnabled})`, async () => {
        const rawSuite = 'cypress/e2e/browser-raw-retry-objects.cy.js'
        const ledger = join(cwd, 'browser-raw-retry-executions.json')
        const command = `./node_modules/.bin/cypress run --spec ${rawSuite}`
        const unchanged = mode === 'locked-root-unchanged'
        const expected = unchanged
          ? { 'excluded recovery': 1, 'excluded persistent': 1, 'ordinary control': 1 }
          : { 'excluded recovery': 3, 'excluded persistent': 4, 'ordinary control': 3 }
        childProcess = exec(`${command} --config supportFile=false`, {
          cwd,
          env: {
            ...cypressEnvironment(),
            NODE_OPTIONS: '',
            DD_TRACE_ENABLED: 'false',
            SPEC_PATTERN: rawSuite,
            CYPRESS_EXCLUSIONS_MODE: mode,
          },
        })
        let output = ''
        childProcess.stdout.on('data', chunk => { output += chunk })
        childProcess.stderr.on('data', chunk => { output += chunk })
        const [nativeExit] = await once(childProcess, 'exit')
        assert.strictEqual(nativeExit, unchanged ? 3 : 1, output)
        assert.deepStrictEqual(JSON.parse(readFileSync(ledger, 'utf8')), expected, output)
        rmSync(ledger)
        receiver.setSettings({ flaky_test_retries_enabled: atrEnabled })
        if (unchanged && atrEnabled) expected['ordinary control'] = 3
        await run(mode, unchanged ? atrEnabled ? 2 : 3 : 1, tests => {
          assert.deepStrictEqual(JSON.parse(readFileSync(ledger, 'utf8')), expected)
          assert.strictEqual(tests.length, Object.values(expected).reduce((sum, count) => sum + count, 0))
          for (const [name, count] of Object.entries(expected)) {
            const attempts = named(tests, `raw retry boundaries ${name}`)
            assert.strictEqual(attempts.length, count, name)
            const failed = name === 'excluded persistent' ||
              (unchanged && (name !== 'ordinary control' || !atrEnabled))
            assert.strictEqual(attempts.at(-1).meta['test.status'], failed ? 'fail' : 'pass')
            const annotated = name.startsWith('excluded')
            for (const attempt of attempts) assert.strictEqual(attempt.meta[exclusion], annotated ? 'true' : undefined)
            for (const retry of attempts.slice(1)) {
              assert.strictEqual(retry.meta['test.retry_reason'],
                atrEnabled && !annotated ? 'auto_test_retry' : 'external', name)
            }
          }
        }, { SPEC_PATTERN: rawSuite, DD_CIVISIBILITY_FLAKY_RETRY_COUNT: '4' }, command)
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
    const pendingLedger = join(cwd, 'pending-suite-executions.json')
    const collector = createServer((request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*')
      if (request.url !== '/pending-counter' || request.method !== 'POST') {
        response.writeHead(404).end()
        return
      }
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        writeFileSync(pendingLedger, body)
        response.writeHead(200).end('recorded')
      })
    })
    await new Promise((resolve, reject) => {
      collector.once('error', reject)
      collector.listen(0, '127.0.0.1', resolve)
    })
    const address = /** @type {import('node:net').AddressInfo} */ (collector.address())
    const ledgerUrl = `http://127.0.0.1:${address.port}/pending-counter`
    try {
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
          CYPRESS_PENDING_LEDGER_URL: ledgerUrl,
        },
      })
      let output = ''
      childProcess.stdout.on('data', chunk => { output += chunk })
      childProcess.stderr.on('data', chunk => { output += chunk })
      const [exitCode] = await once(childProcess, 'exit')
      assert.strictEqual(exitCode, 0, output)
      assert.match(output, /1 passing/)
      assert.match(output, /28 pending/)
      assert.doesNotMatch(output, /skipped callback executed/)
      assert.deepStrictEqual(JSON.parse(readFileSync(pendingLedger, 'utf8')), { skipped: 0, executed: 1 })
      rmSync(pendingLedger)

      await run('pending-suite', 0, tests => {
        assert.strictEqual(tests.length, 29)
        const skipped = tests.filter(test => test.meta['test.status'] === 'skip')
        assert.strictEqual(skipped.length, 28)
        assert.deepStrictEqual(JSON.parse(readFileSync(pendingLedger, 'utf8')), { skipped: 0, executed: 1 })
        for (const test of skipped) {
          const name = test.meta['test.name']
          const both = name.endsWith('both flags') || name.endsWith('nested skip flags')
          assert.strictEqual(test.meta[protection], both || name.endsWith('protected flag') ? 'true' : undefined, name)
          assert.strictEqual(test.meta[exclusion], both || name.endsWith('retry flag') ? 'true' : undefined, name)
        }
        const [executed] = named(tests, 'execution after pending declarations')
        assert.strictEqual(executed.meta['test.status'], 'pass')
      }, { SPEC_PATTERN: pendingSuite, CYPRESS_PENDING_LEDGER_URL: ledgerUrl },
      `./node_modules/.bin/cypress run --spec ${pendingSuite}${tracingConfig}${browserOption}`)
    } finally {
      await new Promise(resolve => collector.close(resolve))
    }
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
  for (const { lock, writeMode } of [
    { lock: 'seal' }, { lock: 'freeze' },
    ...['strict', 'sloppy', 'nested'].map(writeMode => ({ lock: 'freeze', writeMode })),
  ]) {
    for (const atrEnabled of [false, true]) {
      const frozenWrite = writeMode ? ` ${writeMode} writes` : ''
      it(`preserves native callbacks and traces with Object.${lock}${frozenWrite} (ATR=${atrEnabled})`, async () => {
        const command = './node_modules/.bin/cypress run ' +
          '--config-file ci-visibility/cypress-sealed-retry-config/config.js'
        const ledger = join(cwd, 'late-native-retry-executions.json')
        const expected = { 'late native excluded': 3, 'late native control': 3, 'explicit local excluded': 2 }
        const env = {
          ...getCiVisEvpProxyConfig(receiver.port),
          DD_CYPRESS_CONFIG_LOCK: lock,
          ...(writeMode && { DD_CYPRESS_FROZEN_WRITE: writeMode }),
          CYPRESS_LATE_NATIVE_RETRIES_MODE: 'equal-object',
        }
        delete env.CYPRESS_VERSION
        rmSync(ledger, { force: true })
        childProcess = exec(command, { cwd, env: { ...env, NODE_OPTIONS: '', DD_TRACE_ENABLED: 'false' } })
        let output = ''
        childProcess.stdout.on('data', chunk => { output += chunk })
        childProcess.stderr.on('data', chunk => { output += chunk })
        const [nativeExit] = await once(childProcess, 'exit')
        assert.strictEqual(nativeExit, 0, output)
        assert.deepStrictEqual(JSON.parse(readFileSync(ledger, 'utf8')), expected, output)
        rmSync(ledger)

        receiver.setSettings({ flaky_test_retries_enabled: atrEnabled })
        childProcess = exec(command, { cwd, env })
        output = ''
        childProcess.stdout.on('data', chunk => { output += chunk })
        childProcess.stderr.on('data', chunk => { output += chunk })
        const exitPromise = once(childProcess, 'exit')
        const eventsPromise = receiver.gatherPayloadsUntilChildExit(childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
            const tests = payloads.flatMap(({ payload }) => payload.events)
              .filter(event => event.type === 'test').map(event => event.content)
            assert.deepStrictEqual(JSON.parse(readFileSync(ledger, 'utf8')), expected)
            assert.strictEqual(tests.length, 8)
            for (const [name, count] of Object.entries(expected)) {
              const attempts = tests.filter(test => test.meta['test.name'] === name)
              assert.strictEqual(attempts.length, count, name)
              assert.strictEqual(attempts.at(-1).meta['test.status'], 'pass', name)
              if (name !== 'late native control') {
                for (const attempt of attempts) {
                  assert.strictEqual(attempt.meta['test.test_management.no_auto_retry'], 'true')
                }
                for (const attempt of attempts.slice(1)) {
                  assert.strictEqual(attempt.meta['test.retry_reason'], 'external')
                }
              }
            }
          }, { hardTimeout: 90000 })
        const [[exitCode]] = await Promise.all([exitPromise, eventsPromise]).catch(error => {
          error.message += `\nCypress output:\n${output}`
          throw error
        })
        assert.strictEqual(exitCode, 0, output)
      })
    }
  }
})
