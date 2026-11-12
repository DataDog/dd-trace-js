'use strict'

const assert = require('node:assert/strict')
const { exec, execSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const semver = require('semver')
const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  getCiVisEvpProxyConfig,
  assertObjectContains,
  stopCiVisTestEnv,
  warmCypressBinary,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { startWebAppServer, stopWebAppServer } = require('../ci-visibility/web-app-server')
const {
  TEST_STATUS,
  TEST_COMMAND,
  TEST_MODULE,
  TEST_FRAMEWORK,
  TEST_FRAMEWORK_VERSION,
  TEST_TOOLCHAIN,
  TEST_SOURCE_FILE,
  TEST_SOURCE_START,
  TEST_SESSION_NAME,
  DD_TEST_IS_USER_PROVIDED_SERVICE,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS,
  DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')
const { ERROR_MESSAGE } = require('../../packages/dd-trace/src/constants')
const { DD_MAJOR, NODE_MAJOR } = require('../../version')
const {
  resolveOriginalSourceFile,
  resolveSourceLineForTest,
} = require('../../packages/datadog-plugin-cypress/src/source-map-utils')
const { getCypressDependencies } = require('./dependencies')

const requestedVersion = process.env.CYPRESS_VERSION
const oldestVersion = DD_MAJOR >= 6 ? '12.0.0' : '6.7.0'
const version = requestedVersion === 'oldest' ? oldestVersion : requestedVersion
const CYPRESS_PRECOMPILED_SPEC_DIST_DIR = 'cypress/e2e/dist'
const over12It = (version === 'latest' || semver.gte(version, '12.0.0')) ? it : it.skip
const cypressVersionsSupportingNode18 = DD_MAJOR === 5
  ? ['10.2.0', '12.0.0', '14.5.4']
  : ['12.0.0', '14.5.4']

function cleanupPrecompiledSourceLineDist (cwd) {
  fs.rmSync(path.join(cwd, CYPRESS_PRECOMPILED_SPEC_DIST_DIR), { recursive: true, force: true })
}

/**
 * Replaces the installed standalone Cypress finalizers with their pre-deferral implementations.
 *
 * @param {string} packageDirectory installed dd-trace package directory
 * @returns {() => void} restoration callback
 */
function installOldCypressLifecycleHelpers (packageDirectory) {
  const pluginDirectory = path.join(packageDirectory, 'packages', 'datadog-plugin-cypress', 'src')
  const backups = []

  for (const lifecycle of ['after-run', 'after-spec']) {
    const filename = path.join(pluginDirectory, `${lifecycle}.js`)
    const backup = `${filename}.current`
    const method = lifecycle === 'after-run' ? 'afterRun' : 'afterSpec'

    fs.renameSync(filename, backup)
    fs.writeFileSync(filename, '\'use strict\'\n\n' +
      'const cypressPlugin = require(\'./cypress-plugin\')\n\n' +
      `module.exports = cypressPlugin.${method}.bind(cypressPlugin)\n`)
    backups.push([filename, backup])
  }

  return () => {
    for (const [filename, backup] of backups) {
      fs.rmSync(filename, { force: true })
      fs.renameSync(backup, filename)
    }
  }
}

function compilePrecompiledTypeScriptSpecs (cwd, env) {
  try {
    execSync('node_modules/.bin/tsc -p cypress/tsconfig.cypress.json', { cwd, env })
  } catch {
    // tsc emits files even on type errors (noEmitOnError: false), so this is expected
  }
}

/**
 * @param {string} cwd
 */
function configureCypressTypeScriptCompilation (cwd) {
  // Cypress's webpack preprocessor resolves TypeScript config from the spec directory.
  // Cypress sets inlineSourceMap itself, so setting sourceMap here breaks Cypress 12.
  const tsconfig = {
    compilerOptions: {
      rootDir: '.',
      target: 'ES2020',
      module: 'commonjs',
      skipLibCheck: true,
    },
  }

  const typescriptVersion = require(path.join(cwd, 'node_modules/typescript/package.json')).version
  if (semver.gte(typescriptVersion, '6.0.0')) {
    tsconfig.compilerOptions.ignoreDeprecations = '6.0'
  }

  fs.writeFileSync(path.join(cwd, 'cypress/e2e/tsconfig.json'), JSON.stringify(tsconfig, null, 2))
}

/**
 * @param {{ type: string, content: { meta: Record<string, string> } }[]} events
 * @param {string} tag
 */
function assertRequestErrorTag (events, tag) {
  const eventTypes = ['test_session_end', 'test_module_end', 'test_suite_end', 'test']
  for (const eventType of eventTypes) {
    const event = events.find(event => event.type === eventType)
    assert.ok(event, `should have ${eventType} event`)
    assert.strictEqual(event.content.meta[tag], 'true', `${eventType} should have ${tag} tag`)
  }
}

function shouldTestsRun (type) {
  if (DD_MAJOR === 5) {
    if (NODE_MAJOR <= 16) {
      return version === '6.7.0' && type === 'commonJS'
    }
    if (NODE_MAJOR > 16) {
      // Cypress 15.0.0 has removed support for Node 18
      if (NODE_MAJOR <= 18) {
        return cypressVersionsSupportingNode18.includes(version)
      }
      return cypressVersionsSupportingNode18.includes(version) || version === 'latest'
    }
  }
  if (DD_MAJOR >= 6) {
    if (NODE_MAJOR <= 16) {
      return false
    }
    if (NODE_MAJOR > 16) {
      // Cypress 15.0.0 has removed support for Node 18
      if (NODE_MAJOR <= 18) {
        return cypressVersionsSupportingNode18.includes(version)
      }
      return cypressVersionsSupportingNode18.includes(version) || version === 'latest'
    }
  }
  return false
}

const moduleTypes = [
  {
    type: 'commonJS',
    testCommand: function commandWithSuffic (version) {
      const commandSuffix = version === '6.7.0' ? '--config-file cypress-config.json --spec "cypress/e2e/*.cy.js"' : ''
      return `./node_modules/.bin/cypress run ${commandSuffix}`
    },
  },
  {
    type: 'esm',
    testCommand: 'node ./cypress-esm-config.mjs',
  },
].filter(moduleType => !process.env.CYPRESS_MODULE_TYPE || process.env.CYPRESS_MODULE_TYPE === moduleType.type)

moduleTypes.forEach(({
  type,
  testCommand,
}) => {
  if (typeof testCommand === 'function') {
    testCommand = testCommand(version)
  }

  describe(`cypress@${version} ${type}`, function () {
    if (!shouldTestsRun(type)) {
      // eslint-disable-next-line no-console
      console.log(`Skipping tests for cypress@${version} ${type} for dd-trace@${DD_MAJOR} node@${NODE_MAJOR}`)
      return
    }

    this.timeout(80_000)
    let cwd, receiver, childProcess, webAppBaseUrl, webAppServer

    const sandboxDependencies = getCypressDependencies(version)
    if (type === 'commonJS' && version === 'latest') {
      // These dependencies are only needed by the component/Vite regression test below.
      sandboxDependencies.push(
        '@vitejs/plugin-react@6.1.1',
        'react@18.3.1',
        'react-dom@18.3.1',
        'vite@8.2.2'
      )
    }
    useSandbox(sandboxDependencies, true)

    before(async function () {
      this.timeout(180_000)
      cwd = sandboxCwd()
      await warmCypressBinary(cwd)

      const webApp = await startWebAppServer()
      webAppBaseUrl = webApp.baseUrl
      webAppServer = webApp.server
    })

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()
    })

    afterEach(async () => {
      await stopCiVisTestEnv({ childProcess, receiver })
      childProcess = undefined
    })

    after(async () => {
      await stopWebAppServer(webAppServer)
    })

    // These tests require Cypress >=10 features (defineConfig, setupNodeEvents)
    const over10It = (version !== '6.7.0') ? it : it.skip

    const getCypressRunCommand = specToRun => version === '6.7.0'
      ? `./node_modules/.bin/cypress run --config-file cypress-config.json --spec "${specToRun}"`
      : testCommand

    // These CLI fixtures exercise lifecycle behavior, not module loading. Running them in the ESM cell
    // would repeat the same .js configs; dedicated tests below cover .mjs config loading and hook chaining.
    for (const position of ['before', 'after']) {
      over10It(`finalizes the suite when a manual after:spec handler registered ${position} Datadog rejects`,
        async () => {
          const envVars = getCiVisAgentlessConfig(receiver.port)
          const legacyConfigFile = type === 'esm'
            ? 'cypress-legacy-plugin.config.mjs'
            : 'cypress-legacy-plugin.config.js'
          const rejectionVariable = `CYPRESS_REJECT_AFTER_SPEC_${position.toUpperCase()}_PLUGIN`

          childProcess = exec(
            `./node_modules/.bin/cypress run --config-file ${legacyConfigFile}`,
            {
              cwd,
              env: {
                ...envVars,
                CYPRESS_BASE_URL: webAppBaseUrl,
                CYPRESS_ENABLE_AFTER_SPEC_CUSTOM: '1',
                [rejectionVariable]: '1',
                SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
              },
            }
          )

          const receiverPromise = receiver.gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              for (const eventType of ['test_session_end', 'test_module_end', 'test_suite_end']) {
                const testSessionTraceEvents = events.filter(event => event.type === eventType)
                assert.strictEqual(testSessionTraceEvents.length, 1, `expected one ${eventType} event`)
                assert.strictEqual(testSessionTraceEvents[0].content.meta[TEST_STATUS], 'fail')
                assert.strictEqual(testSessionTraceEvents[0].content.error, 1)
                assert.match(
                  testSessionTraceEvents[0].content.meta[ERROR_MESSAGE],
                  new RegExp(`manual after:spec failed ${position} Datadog`)
                )
              }

              const testEvent = events.find(event =>
                event.type === 'test' &&
                event.content.resource === 'cypress/e2e/basic-pass.js.basic pass suite can pass'
              )
              assert.ok(testEvent, 'expected completed test event')
              assert.strictEqual(testEvent.content.meta[TEST_STATUS], 'pass')
            },
            { hardTimeout: 60000 }
          )

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            receiverPromise,
          ])

          assert.notStrictEqual(exitCode, 0)
        })
    }

    over10It(
      'uses one tracer when auto-instrumentation and the manual plugin are different package copies',
      async () => {
        const externalPackageDir = path.join(cwd, 'external-tracer', 'node_modules', 'dd-trace')
        fs.rmSync(path.dirname(path.dirname(externalPackageDir)), { recursive: true, force: true })
        fs.mkdirSync(path.dirname(externalPackageDir), { recursive: true })
        fs.cpSync(path.join(cwd, 'node_modules', 'dd-trace'), externalPackageDir, { recursive: true })

        const legacyConfigFile = type === 'esm'
          ? 'cypress-legacy-plugin.config.mjs'
          : 'cypress-legacy-plugin.config.js'
        const envVars = getCiVisAgentlessConfig(receiver.port)
        let testOutput = ''

        try {
          childProcess = exec(
            `./node_modules/.bin/cypress run --config-file ${legacyConfigFile}`,
            {
              cwd,
              env: {
                ...envVars,
                NODE_OPTIONS: `-r ${path.join(externalPackageDir, 'ci', 'init')}`,
                CYPRESS_BASE_URL: webAppBaseUrl,
                SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
              },
            }
          )
          childProcess.stdout?.on('data', (data) => { testOutput += data })
          childProcess.stderr?.on('data', (data) => { testOutput += data })
          const receiverPromise = receiver
            .gatherPayloadsUntilChildExit(
              childProcess,
              ({ url }) => url.endsWith('/api/v2/citestcycle'),
              (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)

                assert.strictEqual(events.filter(event => event.type === 'test_session_end').length, 1)
                assert.strictEqual(events.filter(event => event.type === 'test_module_end').length, 1)
                assert.strictEqual(events.filter(event => event.type === 'test_suite_end').length, 1)

                const testEvents = events.filter(event => event.type === 'test')
                assert.strictEqual(testEvents.length, 1)
                assertObjectContains(testEvents[0].content, {
                  meta: {
                    [TEST_STATUS]: 'pass',
                    [TEST_FRAMEWORK]: 'cypress',
                  },
                })
              }, { hardTimeout: 60000 })

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            receiverPromise,
          ])

          assert.strictEqual(exitCode, 0, `cypress process should exit successfully\n${testOutput}`)
          assert.doesNotMatch(testOutput, /Multiple attempts to register the following task/)
        } finally {
          fs.rmSync(path.dirname(path.dirname(externalPackageDir)), { recursive: true, force: true })
        }
      }
    )

    for (const {
      lifecycle,
      enableHelper,
      rejectAfterPlugin,
      errorMessage,
      simulatePreScreenshotPlugin,
    } of [
        {
          lifecycle: 'after:run',
          enableHelper: 'CYPRESS_ENABLE_AFTER_RUN_CUSTOM',
          rejectAfterPlugin: 'CYPRESS_REJECT_AFTER_RUN_AFTER_PLUGIN',
          errorMessage: 'manual after:run failed after Datadog',
          simulatePreScreenshotPlugin: true,
        },
        {
          lifecycle: 'after:spec',
          enableHelper: 'CYPRESS_ENABLE_AFTER_SPEC_CUSTOM',
          rejectAfterPlugin: 'CYPRESS_REJECT_AFTER_SPEC_AFTER_PLUGIN',
          errorMessage: 'manual after:spec failed after Datadog',
        },
      ]) {
      const preScreenshotDescription = simulatePreScreenshotPlugin ? ' with a pre-screenshot manual plugin' : ''
      const testName = `defers an older direct ${lifecycle} helper to current finalization${preScreenshotDescription}`
      over10It(testName, async () => {
        const manualPackageDir = path.join(cwd, 'node_modules', 'dd-trace')
        const externalPackageDir = path.join(cwd, 'external-tracer', 'node_modules', 'dd-trace')
        fs.rmSync(path.dirname(path.dirname(externalPackageDir)), { recursive: true, force: true })
        fs.mkdirSync(path.dirname(externalPackageDir), { recursive: true })
        fs.cpSync(manualPackageDir, externalPackageDir, { recursive: true })
        const restoreLifecycleHelpers = installOldCypressLifecycleHelpers(manualPackageDir)

        const legacyConfigFile = type === 'esm'
          ? 'cypress-legacy-plugin.config.mjs'
          : 'cypress-legacy-plugin.config.js'
        const envVars = getCiVisAgentlessConfig(receiver.port)
        let testOutput = ''

        try {
          childProcess = exec(
            `./node_modules/.bin/cypress run --config-file ${legacyConfigFile}`,
            {
              cwd,
              env: {
                ...envVars,
                NODE_OPTIONS: `-r ${path.join(externalPackageDir, 'ci', 'init')}`,
                CYPRESS_BASE_URL: webAppBaseUrl,
                CYPRESS_SIMULATE_OLD_MANUAL_PLUGIN: '1',
                CYPRESS_SIMULATE_PRE_SCREENSHOT_MANUAL_PLUGIN: simulatePreScreenshotPlugin ? '1' : undefined,
                [enableHelper]: '1',
                [rejectAfterPlugin]: '1',
                SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
              },
            }
          )
          childProcess.stdout?.on('data', (data) => { testOutput += data })
          childProcess.stderr?.on('data', (data) => { testOutput += data })
          const receiverPromise = receiver.gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const hierarchyEventTypes = ['test_session_end', 'test_module_end']
              if (lifecycle === 'afterSpec') hierarchyEventTypes.push('test_suite_end')
              for (const eventType of hierarchyEventTypes) {
                const testSessionTraceEvents = events.filter(event => event.type === eventType)
                assert.strictEqual(testSessionTraceEvents.length, 1, `expected one ${eventType} event`)
                assert.strictEqual(testSessionTraceEvents[0].content.meta[TEST_STATUS], 'fail')
                assert.strictEqual(testSessionTraceEvents[0].content.error, 1)
                assert.match(testSessionTraceEvents[0].content.meta[ERROR_MESSAGE], new RegExp(errorMessage))
              }
              if (lifecycle === 'afterRun') {
                const testSuite = events.find(event => event.type === 'test_suite_end')
                assert.ok(testSuite, 'expected test_suite_end event')
                assert.strictEqual(testSuite.content.meta[TEST_STATUS], 'pass')
                assert.strictEqual(testSuite.content.error, 0)
              }

              const testEvent = events.find(event =>
                event.type === 'test' &&
                event.content.resource === 'cypress/e2e/basic-pass.js.basic pass suite can pass'
              )
              assert.ok(testEvent, 'expected completed test event')
              assert.strictEqual(testEvent.content.meta[TEST_STATUS], 'pass')
            },
            { hardTimeout: 60000 }
          )

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            receiverPromise,
          ])

          assert.notStrictEqual(exitCode, 0, `cypress process should fail\n${testOutput}`)
          assert.doesNotMatch(testOutput, /Multiple attempts to register the following task/)
        } finally {
          restoreLifecycleHelpers()
          fs.rmSync(path.dirname(path.dirname(externalPackageDir)), { recursive: true, force: true })
        }
      })
    }

    over10It('reports real test statuses when supportFile is false', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)
      const getSupportWrappers = () => fs.readdirSync(cwd)
        .filter(filename => filename.startsWith('dd-cypress-support-'))
        .sort()
      const supportWrappersBefore = getSupportWrappers()

      childProcess = exec(
        './node_modules/.bin/cypress run --config-file cypress-support-file-false.config.js',
        { cwd, env: envVars }
      )
      const receiverPromise = receiver
        .gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          (payloads) => {
            const testEvents = payloads
              .flatMap(({ payload }) => payload.events)
              .filter(event => event.type === 'test')

            assert.strictEqual(testEvents.length, 2)
            const statuses = Object.fromEntries(testEvents.map(event => [
              event.content.resource,
              event.content.meta[TEST_STATUS],
            ]))
            assert.deepStrictEqual(statuses, {
              'cypress/e2e/support-file-false.cy.js.support file false suite passes without a user support file':
                'pass',
              'cypress/e2e/support-file-false.cy.js.support file false suite skips without a user support file':
                'skip',
            })
          }, { hardTimeout: 60000 })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
      assert.deepStrictEqual(getSupportWrappers(), supportWrappersBefore)
    })

    const readOnlyConfigIt = process.platform === 'win32' ? it.skip : over10It
    readOnlyConfigIt('auto-instruments a plain-object config in a read-only directory', async () => {
      const readOnlyConfigDir = path.join(cwd, 'read-only-config')
      const configExtension = type === 'esm' ? '.mjs' : '.js'
      const sourceConfig = path.join(cwd, `cypress-plain-object-auto.config${configExtension}`)
      const readOnlyConfig = path.join(readOnlyConfigDir, `plain-object${configExtension}`)

      fs.rmSync(readOnlyConfigDir, { recursive: true, force: true })
      fs.mkdirSync(readOnlyConfigDir)
      fs.copyFileSync(sourceConfig, readOnlyConfig)
      fs.chmodSync(readOnlyConfigDir, 0o555)
      const getConfigWrappers = () => fs.readdirSync(cwd)
        .filter(filename => filename.startsWith('.dd-cypress-config-'))
        .sort()
      const configWrappersBefore = getConfigWrappers()

      try {
        const envVars = getCiVisAgentlessConfig(receiver.port)
        childProcess = exec(
          `./node_modules/.bin/cypress run --config-file ${readOnlyConfig}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: webAppBaseUrl,
              SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
            },
          }
        )
        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            (payloads) => {
              const testEvents = payloads
                .flatMap(({ payload }) => payload.events)
                .filter(event => event.type === 'test')
              const passedTest = testEvents.find(event =>
                event.content.resource === 'cypress/e2e/basic-pass.js.basic pass suite can pass'
              )

              assertObjectContains(passedTest?.content, {
                meta: {
                  [TEST_STATUS]: 'pass',
                  [TEST_FRAMEWORK]: 'cypress',
                },
              })
            }, { hardTimeout: 60000 })

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])

        assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
        assert.deepStrictEqual(getConfigWrappers(), configWrappersBefore)
      } finally {
        fs.chmodSync(readOnlyConfigDir, 0o755)
        fs.rmSync(readOnlyConfigDir, { recursive: true, force: true })
      }
    })

    const readOnlyTypeScriptConfigIt = process.platform !== 'win32' &&
      type === 'commonJS' && version === '14.5.4' && NODE_MAJOR > 18
      ? it
      : it.skip
    readOnlyTypeScriptConfigIt(
      'auto-instruments a TypeScript config when the writable fallback has a different module scope',
      async () => {
        const projectRoot = path.join(cwd, 'read-only-typescript-project')
        const configDirectory = path.join(projectRoot, 'config')
        const configFile = path.join(configDirectory, 'cypress.config.ts')
        const specDirectory = path.join(projectRoot, 'cypress', 'e2e')
        fs.rmSync(projectRoot, { recursive: true, force: true })
        fs.mkdirSync(configDirectory, { recursive: true })
        fs.mkdirSync(specDirectory, { recursive: true })
        fs.writeFileSync(path.join(projectRoot, 'package.json'), '{ "type": "module" }')
        fs.writeFileSync(path.join(configDirectory, 'package.json'), '{ "type": "commonjs" }')
        fs.writeFileSync(configFile, [
          'module.exports = {',
          '  e2e: { specPattern: "cypress/e2e/basic-pass.js", supportFile: false },',
          '  video: false,',
          '  screenshotOnRunFailure: false,',
          '}',
          '',
        ].join('\n'))
        fs.copyFileSync(
          path.join(cwd, 'cypress', 'e2e', 'basic-pass.js'),
          path.join(specDirectory, 'basic-pass.js')
        )
        fs.chmodSync(configDirectory, 0o555)

        const getGeneratedFiles = () => fs.readdirSync(projectRoot)
          .filter(file => file.startsWith('.dd-cypress-config-') || file.startsWith('dd-cypress-support-'))
          .sort()
        const generatedFilesBefore = getGeneratedFiles()
        let testOutput = ''

        try {
          childProcess = exec(
            `./node_modules/.bin/cypress run --project ${projectRoot} --config-file ${configFile}`,
            {
              cwd,
              env: {
                ...getCiVisAgentlessConfig(receiver.port),
                CYPRESS_BASE_URL: webAppBaseUrl,
              },
            }
          )
          childProcess.stdout?.on('data', (data) => { testOutput += data })
          childProcess.stderr?.on('data', (data) => { testOutput += data })
          const receiverPromise = receiver
            .gatherPayloadsUntilChildExit(
              childProcess,
              ({ url }) => url.endsWith('/api/v2/citestcycle'),
              (payloads) => {
                const testEvents = payloads
                  .flatMap(({ payload }) => payload.events)
                  .filter(event => event.type === 'test')
                const passedTest = testEvents.find(event =>
                  event.content.resource === 'cypress/e2e/basic-pass.js.basic pass suite can pass'
                )

                assertObjectContains(passedTest?.content, {
                  meta: {
                    [TEST_STATUS]: 'pass',
                    [TEST_FRAMEWORK]: 'cypress',
                  },
                })
              }, { hardTimeout: 60000 })

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            receiverPromise,
          ])

          assert.strictEqual(exitCode, 0, `cypress process should exit successfully\n${testOutput}`)
          assert.deepStrictEqual(getGeneratedFiles(), generatedFilesBefore)
        } finally {
          fs.chmodSync(configDirectory, 0o755)
          fs.rmSync(projectRoot, { recursive: true, force: true })
        }
      }
    )

    const componentIt = type === 'commonJS' && version === 'latest' ? it : it.skip
    componentIt('auto-instruments component tests with the Vite dev server', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)
      const supportDirectory = path.join(cwd, 'cypress', 'support')
      const getSupportWrappers = () => fs.readdirSync(supportDirectory)
        .filter(filename => filename.startsWith('dd-cypress-support-'))
        .sort()
      const supportWrappersBefore = getSupportWrappers()

      childProcess = exec(
        './node_modules/.bin/cypress run --component --config-file cypress-component.config.js',
        { cwd, env: envVars }
      )
      const receiverPromise = receiver
        .gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testEvents = events.filter(event => event.type === 'test')

            assert.strictEqual(events.filter(event => event.type === 'test_session_end').length, 1)
            assert.strictEqual(events.filter(event => event.type === 'test_module_end').length, 1)
            assert.strictEqual(events.filter(event => event.type === 'test_suite_end').length, 1)
            assert.strictEqual(testEvents.length, 1)
            assertObjectContains(testEvents[0].content, {
              meta: {
                [TEST_STATUS]: 'pass',
                [TEST_FRAMEWORK]: 'cypress',
              },
            })
          }, { hardTimeout: 60000 })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
      assert.deepStrictEqual(getSupportWrappers(), supportWrappersBefore)
    })

    // Exercises the manual plugin path without NODE_OPTIONS when users also register
    // custom after:spec and after:run handlers. Without auto-instrumentation, there is
    // no wrappedOn to intercept and chain handlers — the manual plugin's on() calls
    // replace earlier registrations. This test verifies the system does not crash and
    // spans are still correctly reported through the manual plugin's own hooks.
    over10It('manual plugin with custom after hooks works without NODE_OPTIONS', async () => {
      // Strip NODE_OPTIONS — the manual plugin initializes dd-trace itself.
      const { NODE_OPTIONS, ...envVars } = getCiVisEvpProxyConfig(receiver.port)

      const legacyConfigFile = type === 'esm'
        ? 'cypress-legacy-plugin.config.mjs'
        : 'cypress-legacy-plugin.config.js'

      childProcess = exec(
        `./node_modules/.bin/cypress run --config-file ${legacyConfigFile}`,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: webAppBaseUrl,
            CYPRESS_ENABLE_AFTER_RUN_CUSTOM: '1',
            CYPRESS_ENABLE_AFTER_SPEC_CUSTOM: '1',
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        }
      )

      const receiverPromise = receiver
        .gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const sessionEvents = events.filter(event => event.type === 'test_session_end')
            const testEvents = events.filter(event => event.type === 'test')

            assert.strictEqual(sessionEvents.length, 1, 'should have one test session')
            assert.ok(testEvents.length >= 1, 'should have at least one test')

            const passedTest = testEvents.find(event =>
              event.content.resource === 'cypress/e2e/basic-pass.js.basic pass suite can pass'
            )
            assertObjectContains(passedTest?.content, {
              meta: {
                [TEST_STATUS]: 'pass',
                [TEST_FRAMEWORK]: 'cypress',
              },
            })
          }, { hardTimeout: 60000 })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
    })

    over12It('reports source file and line for pre-compiled typescript test files', async function () {
      const envVars = getCiVisAgentlessConfig(receiver.port)

      try {
        cleanupPrecompiledSourceLineDist(cwd)

        // Compile the TypeScript spec to JS + source map so the plugin can resolve
        // the original TypeScript source file and line via the adjacent .js.map file.
        compilePrecompiledTypeScriptSpecs(cwd, envVars)

        const specToRun =
          'cypress/e2e/dist/{spec-source-line,spec-source-line-fallback,spec-source-line-no-match}.cy.js'

        childProcess = exec(testCommand, {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: webAppBaseUrl,
            SPEC_PATTERN: specToRun,
          },
        })

        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            (payloads) => {
              const events = payloads.flatMap(({ payload }) => payload.events)
              const testEvents = events.filter(event => event.type === 'test')
              const tsTestEvents = testEvents.filter(event =>
                event.content.resource.includes('spec-source-line.cy.js.spec source line')
              )

              assert.strictEqual(tsTestEvents.length, 2, 'should have two typescript test events')

              const itTestEvent = tsTestEvents.find(e => e.content.resource.includes('reports correct line number'))
              const testTestEvent = tsTestEvents.find(
                e => e.content.resource.includes('template interpolated string test name')
              )

              assert.ok(itTestEvent, 'it() test event should exist')
              // 'it' is defined at line 11 in the TypeScript source file spec-source-line.cy.ts
              assert.strictEqual(
                itTestEvent.content.metrics[TEST_SOURCE_START],
                11,
                'should report the correct source line for it() test'
              )
              assert.match(
                itTestEvent.content.meta[TEST_SOURCE_FILE],
                /spec-source-line\.cy\.ts$/,
                `TEST_SOURCE_FILE should point to TypeScript source, got: ${itTestEvent.content.meta[TEST_SOURCE_FILE]}`
              )

              // 'specify' with a template literal test name is defined at line 16.
              // The plugin resolves the TS line by scanning the compiled JS for the template literal
              // call (fuzzy-matching ${expr} placeholders) and mapping via the adjacent .js.map.
              assert.ok(testTestEvent, 'specify() with template literal name should exist')
              assert.strictEqual(
                testTestEvent.content.metrics[TEST_SOURCE_START],
                16,
                'should report the correct source line for specify() with template literal name'
              )
              assert.match(
                testTestEvent.content.meta[TEST_SOURCE_FILE],
                /spec-source-line\.cy\.ts$/,
                `TEST_SOURCE_FILE should point to TypeScript source, got: ${
                  testTestEvent.content.meta[TEST_SOURCE_FILE]
                }`
              )

              const fallbackEvent = testEvents.find(event =>
                event.content.resource.includes('spec source line fallback branch') &&
                event.content.resource.includes('fallback branch literal title')
              )

              assert.ok(fallbackEvent, 'fallback-resolution test event should exist')
              assert.strictEqual(
                fallbackEvent.content.metrics[TEST_SOURCE_START],
                7,
                'should report TS source line resolved via declaration scanning fallback'
              )
              assert.match(
                fallbackEvent.content.meta[TEST_SOURCE_FILE],
                /spec-source-line-fallback\.cy\.ts$/,
                `TEST_SOURCE_FILE should point to TypeScript source, got: ${
                  fallbackEvent.content.meta[TEST_SOURCE_FILE]
                }`
              )

              const noMatchEvent = testEvents.find(event =>
                event.content.resource.includes('spec source line no match') &&
                event.content.resource.includes('no match title')
              )

              assert.ok(noMatchEvent, 'no-match test event should exist')
              assert.ok(
                Number.isInteger(noMatchEvent.content.metrics[TEST_SOURCE_START]) &&
                noMatchEvent.content.metrics[TEST_SOURCE_START] > 100,
                `expected unresolved source line to remain a large generated/invocation line, got: ${
                  noMatchEvent.content.metrics[TEST_SOURCE_START]
                }`
              )
              assert.match(
                noMatchEvent.content.meta[TEST_SOURCE_FILE],
                /spec-source-line-no-match\.cy\.ts$/,
                `TEST_SOURCE_FILE should point to TypeScript source, got: ${
                  noMatchEvent.content.meta[TEST_SOURCE_FILE]
                }`
              )
            }, { hardTimeout: 60000 })

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), receiverPromise])
        assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
      } finally {
        cleanupPrecompiledSourceLineDist(cwd)
      }
    })

    over12It('resolves source line from invocationDetails stack before declaration scanning', () => {
      // Covers the algorithm branch that resolves source line from invocationDetails.stack.
      // Current Cypress integration scenarios do not exercise this branch end-to-end,
      // so we keep this deterministic test for regression coverage.
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-cypress-source-map-'))
      const compiledFilePath = path.join(tempDir, 'spec-stack.js')
      const sourceMapPath = `${compiledFilePath}.map`

      try {
        fs.writeFileSync(compiledFilePath, [
          'const title = [\'runtime\', \'title\'].join(\' \')',
          '',
          'beforeEach(() => {})',
          '',
          'const fn = () => {}',
          '',
          'it(title, fn)',
          '',
        ].join('\n'))

        fs.writeFileSync(sourceMapPath, JSON.stringify({
          version: 3,
          file: 'spec-stack.js',
          sourceRoot: '',
          sources: ['spec-stack.ts'],
          names: [],
          mappings: ';;;;;;AAQA',
        }))

        const resolvedLine = resolveSourceLineForTest(
          compiledFilePath,
          'this title does not appear in source',
          'Error\n    at eval (http://localhost:3000/__cypress/tests?p=spec-stack.js:7:1)'
        )

        assert.strictEqual(resolvedLine, 9)
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    })

    over12It('resolves source file when generated first line is unmapped', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-cypress-source-map-'))
      const compiledFilePath = path.join(tempDir, 'spec-prologue.js')
      const sourceMapPath = `${compiledFilePath}.map`

      try {
        fs.writeFileSync(compiledFilePath, [
          '"use strict";',
          'it("source mapped title", () => {})',
          '',
        ].join('\n'))

        fs.writeFileSync(sourceMapPath, JSON.stringify({
          version: 3,
          file: 'spec-prologue.js',
          sourceRoot: '',
          sources: ['spec-prologue.ts'],
          names: [],
          mappings: ';AAEA',
        }))

        assert.strictEqual(resolveOriginalSourceFile(compiledFilePath), path.join(tempDir, 'spec-prologue.ts'))
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    })

    over12It('uses invocationDetails line directly for plain javascript specs without source maps', async function () {
      const envVars = getCiVisAgentlessConfig(receiver.port)

      childProcess = exec(testCommand, {
        cwd,
        env: {
          ...envVars,
          CYPRESS_BASE_URL: webAppBaseUrl,
          SPEC_PATTERN: 'cypress/e2e/spec-source-line-invocation.cy.js',
        },
      })

      const receiverPromise = receiver
        .gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const jsInvocationDetailsEvent = events.find(event =>
              event.type === 'test' &&
            event.content.resource.includes('spec source line invocation details js') &&
            event.content.resource.includes('uses invocation details line as source line')
            )

            assert.ok(jsInvocationDetailsEvent, 'plain-js invocationDetails test event should exist')
            // The exact value is a Cypress-generated bundle line that shifts when support code changes.
            // It should stay as a generated invocationDetails line instead of resolving to the fixture declaration.
            assert.ok(
              jsInvocationDetailsEvent.content.metrics[TEST_SOURCE_START] > 100,
              'should keep generated invocationDetails line directly for plain JS specs without source maps'
            )
            assert.match(
              jsInvocationDetailsEvent.content.meta[TEST_SOURCE_FILE],
              /spec-source-line-invocation\.cy\.js$/,
              `TEST_SOURCE_FILE should point to JS source, got: ${
                jsInvocationDetailsEvent.content.meta[TEST_SOURCE_FILE]
              }`
            )
          }, { hardTimeout: 60000 })

      const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), receiverPromise])
      assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
    })

    over12It('reports correct source file and line for typescript test files compiled by cypress', async function () {
      // Remove any pre-compiled dist files to ensure Cypress compiles the .ts file itself
      cleanupPrecompiledSourceLineDist(cwd)
      configureCypressTypeScriptCompilation(cwd)
      let testOutput = ''

      const envVars = getCiVisAgentlessConfig(receiver.port)

      // Run Cypress directly with the TypeScript spec file — no manual compilation step.
      // Cypress compiles .cy.ts files on the fly via its own preprocessor/bundler.
      childProcess = exec(testCommand, {
        cwd,
        env: {
          ...envVars,
          CYPRESS_BASE_URL: webAppBaseUrl,
          SPEC_PATTERN: 'cypress/e2e/spec-source-line.cy.ts',
        },
      })

      const receiverPromise = receiver
        .gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tsTestEvents = events.filter(event =>
              event.type === 'test' &&
            event.content.resource.includes('spec source line')
            )

            assert.strictEqual(
              tsTestEvents.length,
              2,
            `should have two typescript test events, got events: ${JSON.stringify(events.map(event => ({
              type: event.type,
              resource: event.content.resource,
              sourceFile: event.content.meta?.[TEST_SOURCE_FILE],
              sourceStart: event.content.metrics?.[TEST_SOURCE_START],
              status: event.content.meta?.[TEST_STATUS],
              error: event.content.meta?.[ERROR_MESSAGE],
            })), null, 2)}\nCypress output:\n${testOutput}`
            )

            const itTestEvent = tsTestEvents.find(e => e.content.resource.includes('reports correct line number'))
            const testTestEvent = tsTestEvents.find(
              e => e.content.resource.includes('template interpolated string test name')
            )

            assert.ok(itTestEvent, 'it() test event should exist')
            // 'it' is defined at line 11 in the TypeScript source file spec-source-line.cy.ts
            assert.strictEqual(
              itTestEvent.content.metrics[TEST_SOURCE_START],
              11,
              'should report the correct source line for it() test'
            )
            assert.match(
              itTestEvent.content.meta[TEST_SOURCE_FILE],
              /spec-source-line\.cy\.ts$/,
              `TEST_SOURCE_FILE should point to TypeScript source, got: ${itTestEvent.content.meta[TEST_SOURCE_FILE]}`
            )

            // 'specify' with a template literal test name is defined at line 16.
            // Cypress's webpack preprocessor in headless mode does not resolve eval source maps
            // in Error.stack, so invocationDetails.line is the webpack bundle line rather than
            // the TS source line. Name-scanning cannot match template-literal names (the source
            // contains interpolated variables), so the exact TS line cannot be recovered in this
            // mode. We verify the event exists and that TEST_SOURCE_FILE points to the TS source.
            assert.ok(testTestEvent, 'specify() with template literal name should exist')
            assert.match(
              testTestEvent.content.meta[TEST_SOURCE_FILE],
              /spec-source-line\.cy\.ts$/,
              `TEST_SOURCE_FILE should point to TypeScript source, got: ${testTestEvent.content.meta[TEST_SOURCE_FILE]}`
            )
          }, { hardTimeout: 60000 })
      childProcess.stdout?.on('data', chunk => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', chunk => {
        testOutput += chunk.toString()
      })

      const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), receiverPromise])
      assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
    })

    context('error tags', () => {
      it(
        'tags session and children with _dd.ci.library_configuration_error.settings when settings fails 4xx',
        async () => {
          const envVars = getCiVisAgentlessConfig(receiver.port)
          const specToRun = 'cypress/e2e/basic-pass.js'

          receiver.setSettingsResponseCode(404)
          childProcess = exec(
            getCypressRunCommand(specToRun),
            {
              cwd,
              env: {
                ...envVars,
                CYPRESS_BASE_URL: webAppBaseUrl,
                SPEC_PATTERN: specToRun,
              },
            }
          )

          // TODO: remove this once we have figured out flakiness
          childProcess.stdout?.pipe(process.stdout)
          childProcess.stderr?.pipe(process.stderr)

          const eventsPromise = receiver
            .gatherPayloadsUntilChildExit(
              childProcess,
              ({ url }) => url.endsWith('/api/v2/citestcycle'),
              (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                assertRequestErrorTag(events, DD_CI_LIBRARY_CONFIGURATION_ERROR_SETTINGS)
              })

          await Promise.all([eventsPromise, once(childProcess, 'exit')])
        })

      it(
        'tags session and children when test optimization requests fail',
        async () => {
          const envVars = getCiVisAgentlessConfig(receiver.port)
          const specToRun = 'cypress/e2e/basic-pass.js'

          receiver.setSettings({
            code_coverage: true,
            tests_skipping: true,
            itr_enabled: true,
            known_tests_enabled: true,
            test_management: {
              enabled: true,
            },
          })
          receiver.setSkippableSuitesResponseCode(404)
          receiver.setKnownTestsResponseCode(404)
          receiver.setTestManagementTestsResponseCode(404)
          childProcess = exec(
            getCypressRunCommand(specToRun),
            {
              cwd,
              env: {
                ...envVars,
                CYPRESS_BASE_URL: webAppBaseUrl,
                SPEC_PATTERN: specToRun,
              },
            }
          )

          // TODO: remove this once we have figured out flakiness
          childProcess.stdout?.pipe(process.stdout)
          childProcess.stderr?.pipe(process.stderr)

          const eventsPromise = receiver
            .gatherPayloadsUntilChildExit(
              childProcess,
              ({ url }) => url.endsWith('/api/v2/citestcycle'),
              (payloads) => {
                const events = payloads.flatMap(({ payload }) => payload.events)
                assertRequestErrorTag(events, DD_CI_LIBRARY_CONFIGURATION_ERROR_SKIPPABLE_TESTS)
                assertRequestErrorTag(events, DD_CI_LIBRARY_CONFIGURATION_ERROR_KNOWN_TESTS)
                assertRequestErrorTag(events, DD_CI_LIBRARY_CONFIGURATION_ERROR_TEST_MANAGEMENT_TESTS)
              })

          await Promise.all([eventsPromise, once(childProcess, 'exit')])
        })
    })

    it('does not crash if badly init', async () => {
      const {
        DD_CIVISIBILITY_AGENTLESS_URL,
        ...envVars
      } = getCiVisAgentlessConfig(receiver.port)

      let hasReceivedEvents = false

      const eventsPromise = receiver.assertPayloadReceived(() => {
        hasReceivedEvents = true
      }, ({ url }) => url.endsWith('/api/v2/citestcycle')).catch(() => {})

      let testOutput = ''

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: webAppBaseUrl,
            DD_SITE: '= invalid = url',
            SPEC_PATTERN: 'cypress/e2e/spec.cy.js',
          },
        }
      )
      childProcess.stdout?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', (chunk) => {
        testOutput += chunk.toString()
      })

      await Promise.all([
        once(childProcess.stdout, 'end'),
        once(childProcess.stderr, 'end'),
        once(childProcess, 'exit'),
        eventsPromise,
      ])

      assert.strictEqual(hasReceivedEvents, false)
      // TODO: remove try/catch once we find the source of flakiness
      try {
        assert.doesNotMatch(testOutput, /TypeError/)
        assert.match(testOutput, /1 of 1 failed/)
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log('---- Actual test output -----')
        // eslint-disable-next-line no-console
        console.log(testOutput)
        // eslint-disable-next-line no-console
        console.log('---- finish actual test output -----')
        throw e
      }
    })

    it('can run and report tests', async () => {
      const envVars = getCiVisEvpProxyConfig(receiver.port)

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: webAppBaseUrl,
            DD_TAGS: 'test.customtag:customvalue,test.customtag2:customvalue2',
            DD_TEST_SESSION_NAME: 'my-test-session',
            DD_SERVICE: undefined,
            SPEC_PATTERN: 'cypress/e2e/{spec,other,hook-describe-error,hook-test-error}.cy.js',
          },
        }
      )

      // TODO: remove this once we have figured out flakiness
      childProcess.stdout?.pipe(process.stdout)
      childProcess.stderr?.pipe(process.stderr)

      const receiverPromise = receiver
        .gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          payloads => {
            const ciVisPayloads = payloads.filter(({ payload }) => payload.metadata?.test)
            const ciVisMetadataDicts = ciVisPayloads.flatMap(({ payload }) => payload.metadata)

            ciVisMetadataDicts.forEach(metadata => {
              assert.strictEqual(metadata.test_levels[TEST_SESSION_NAME], 'my-test-session')
              assert.ok(metadata.test_levels[TEST_COMMAND])
            })
            const events = ciVisPayloads.flatMap(({ payload }) => payload.events)

            const testSessionEvent = events.find(event => event.type === 'test_session_end')
            const testModuleEvent = events.find(event => event.type === 'test_module_end')
            const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
            const testEvents = events.filter(event => event.type === 'test')

            const { content: testSessionEventContent } = testSessionEvent
            const { content: testModuleEventContent } = testModuleEvent

            assert.ok(testSessionEventContent.test_session_id)
            assert.ok(testSessionEventContent.meta[TEST_TOOLCHAIN])
            assert.strictEqual(testSessionEventContent.resource.startsWith('test_session.'), true)
            assert.strictEqual(testSessionEventContent.meta[TEST_STATUS], 'fail')

            assert.ok(testModuleEventContent.test_session_id)
            assert.ok(testModuleEventContent.test_module_id)
            assert.ok(testModuleEventContent.meta[TEST_MODULE])
            assert.strictEqual(testModuleEventContent.resource.startsWith('test_module.'), true)
            assert.strictEqual(testModuleEventContent.meta[TEST_STATUS], 'fail')
            assert.strictEqual(
              testModuleEventContent.test_session_id.toString(10),
              testSessionEventContent.test_session_id.toString(10)
            )
            assert.ok(testModuleEventContent.meta[TEST_FRAMEWORK_VERSION])

            assert.deepStrictEqual(
              testSuiteEvents.map(suite => suite.content.resource).sort(),
              [
                'test_suite.cypress/e2e/hook-describe-error.cy.js',
                'test_suite.cypress/e2e/hook-test-error.cy.js',
                'test_suite.cypress/e2e/other.cy.js',
                'test_suite.cypress/e2e/spec.cy.js',
              ]
            )

            assertObjectContains(
              testSuiteEvents.map(suite => suite.content.meta[TEST_STATUS]).sort(),
              ['fail', 'fail', 'fail', 'pass']
            )

            testSuiteEvents.forEach(({
              content: {
                meta,
                metrics,
                test_suite_id: testSuiteId,
                test_module_id: testModuleId,
                test_session_id: testSessionId,
              },
            }) => {
              assert.ok(meta[TEST_MODULE])
              assert.ok(testSuiteId)
              assert.strictEqual(testModuleId.toString(10), testModuleEventContent.test_module_id.toString(10))
              assert.strictEqual(testSessionId.toString(10), testSessionEventContent.test_session_id.toString(10))
              assert.strictEqual(meta[TEST_SOURCE_FILE].startsWith('cypress/e2e/'), true)
              assert.strictEqual(metrics[TEST_SOURCE_START], 1)
              assert.ok(metrics[DD_HOST_CPU_COUNT])
            })

            assertObjectContains(testEvents.map(test => test.content.resource).sort(), [
              'cypress/e2e/other.cy.js.context passes',
              'cypress/e2e/spec.cy.js.context passes',
              'cypress/e2e/spec.cy.js.other context fails',
            ])

            testEvents.forEach(({
              content: {
                meta,
                metrics,
                test_suite_id: testSuiteId,
                test_module_id: testModuleId,
                test_session_id: testSessionId,
              },
            }) => {
              assert.ok(meta[TEST_MODULE])
              assert.ok(testSuiteId)
              assert.strictEqual(testModuleId.toString(10), testModuleEventContent.test_module_id.toString(10))
              assert.strictEqual(testSessionId.toString(10), testSessionEventContent.test_session_id.toString(10))
              assert.strictEqual(meta[TEST_SOURCE_FILE].startsWith('cypress/e2e/'), true)
              // Can read DD_TAGS
              assert.strictEqual(meta[DD_TEST_IS_USER_PROVIDED_SERVICE], 'false')
              assert.strictEqual(meta['test.customtag'], 'customvalue')
              assert.strictEqual(meta['test.customtag2'], 'customvalue2')
              assert.ok(metrics[DD_HOST_CPU_COUNT])
            })

            // Verify hook errors are caught correctly
            // test level hooks
            const testHookSuite = events.find(
              event => event.content.resource === 'test_suite.cypress/e2e/hook-test-error.cy.js'
            )
            const passedTest = events.find(
              event => event.content.resource === 'cypress/e2e/hook-test-error.cy.js.hook-test-error tests passes'
            )
            const failedTest = events.find(
              event => event.content.resource ===
            'cypress/e2e/hook-test-error.cy.js.hook-test-error tests will fail because afterEach fails'
            )
            const skippedTest = events.find(
              event => event.content.resource ===
            'cypress/e2e/hook-test-error.cy.js.hook-test-error tests does not run because earlier afterEach fails'
            )
            assert.strictEqual(passedTest.content.meta[TEST_STATUS], 'pass')
            assert.strictEqual(failedTest.content.meta[TEST_STATUS], 'fail')
            assert.match(failedTest.content.meta[ERROR_MESSAGE], /error in after each hook/)
            assert.strictEqual(skippedTest.content.meta[TEST_STATUS], 'skip')
            assert.strictEqual(testHookSuite.content.meta[TEST_STATUS], 'fail')
            assert.match(testHookSuite.content.meta[ERROR_MESSAGE], /error in after each hook/)

            // describe level hooks
            const describeHookSuite = events.find(
              event => event.content.resource === 'test_suite.cypress/e2e/hook-describe-error.cy.js'
            )
            const passedTestDescribe = events.find(
              event => event.content.resource === 'cypress/e2e/hook-describe-error.cy.js.after passes'
            )
            const failedTestDescribe = events.find(
              event => event.content.resource === 'cypress/e2e/hook-describe-error.cy.js.after will be marked as failed'
            )
            const skippedTestDescribe = events.find(
              event => event.content.resource === 'cypress/e2e/hook-describe-error.cy.js.before will be skipped'
            )
            assert.strictEqual(passedTestDescribe.content.meta[TEST_STATUS], 'pass')
            assert.strictEqual(failedTestDescribe.content.meta[TEST_STATUS], 'fail')
            assert.match(failedTestDescribe.content.meta[ERROR_MESSAGE], /error in after hook/)
            assert.strictEqual(skippedTestDescribe.content.meta[TEST_STATUS], 'skip')
            assert.strictEqual(describeHookSuite.content.meta[TEST_STATUS], 'fail')
            assert.match(describeHookSuite.content.meta[ERROR_MESSAGE], /error in after hook/)
          }, { hardTimeout: 25000 })

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])
    })
  })
})
