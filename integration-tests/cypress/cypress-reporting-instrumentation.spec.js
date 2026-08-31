'use strict'

const assert = require('node:assert/strict')
const { exec, execFileSync, execSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { format } = require('node:util')

const proxyquire = require('proxyquire').noPreserveCache()
const semver = require('semver')
const sinon = require('sinon')
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
  TEST_FAILURE_VIDEO_UPLOADED,
  TEST_FAILURE_VIDEO_UPLOAD_ERROR,
  TEST_FAILURE_VIDEO_SCOPE,
} = require('../../packages/dd-trace/src/plugins/util/test')
const {
  VIDEO_UPLOAD_RESULT_UPLOADED,
  VIDEO_UPLOAD_SCOPE_TEST_SUITE,
} = require('../../packages/dd-trace/src/ci-visibility/test-video')
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

function getGeneratedSupportFiles (directory) {
  return fs.readdirSync(directory)
    .filter(filename => filename.startsWith('dd-cypress-support-'))
    .sort()
}

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
 * @returns {void}
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
 * @returns {void}
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
        '@vitejs/plugin-react@4.3.4',
        'react@18.3.1',
        'react-dom@18.3.1',
        'vite@6.1.0'
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

    // Regression guard: when OTEL_TRACES_EXPORTER=otlp is set in the
    // environment (e.g. by an unrelated OpenTelemetry-instrumented shell),
    // the tracer must still ship Test Optimization spans to
    // /api/v2/citestcycle instead of silently replacing the Test
    // Optimization exporter with OtlpHttpTraceExporter and dropping all
    // test_session / test_module / test_suite / test spans.
    over10It('keeps Test Optimization exporter when OTEL_TRACES_EXPORTER=otlp is set', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...envVars,
            // Simulates a user shell that already exports OTEL_* vars for
            // a separate OTEL collector. The Test Optimization exporter
            // must win inside isCiVisibility mode.
            OTEL_TRACES_EXPORTER: 'otlp',
            CYPRESS_BASE_URL: webAppBaseUrl,
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
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
          (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            const sessionEvents = events.filter(event => event.type === 'test_session_end')
            const testEvents = events.filter(event => event.type === 'test')

            assert.strictEqual(sessionEvents.length, 1, 'one test_session span must reach citestcycle')

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

    over10It('does not modify the user support file and cleans up the injected wrapper', async () => {
      const supportFilePath = path.join(cwd, 'cypress/support/e2e.js')
      const originalSupportContent = fs.readFileSync(supportFilePath, 'utf8')
      const supportContentWithoutDdTrace = originalSupportContent
        .split('\n')
        .filter(line => !line.includes("require('dd-trace/ci/cypress/support')"))
        .join('\n')

      const getSupportWrappers = () => fs.readdirSync(path.dirname(supportFilePath))
        .filter(filename => filename.startsWith('dd-cypress-support-'))
        .sort()

      fs.writeFileSync(supportFilePath, supportContentWithoutDdTrace)

      const envVars = getCiVisAgentlessConfig(receiver.port)
      const wrapperFilesBefore = getSupportWrappers()

      try {
        childProcess = exec(testCommand, {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: webAppBaseUrl,
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        })

        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            (payloads) => {
              const events = payloads
                .flatMap(({ payload }) => payload.events)
                .filter(event => event.type === 'test')
              const passedTest = events.find(event =>
                event.content.resource === 'cypress/e2e/basic-pass.js.basic pass suite can pass'
              )

              assertObjectContains(passedTest?.content, {
                meta: {
                  [TEST_STATUS]: 'pass',
                  [TEST_FRAMEWORK]: 'cypress',
                },
              })
            },
            { hardTimeout: 60000 }
          )

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])

        assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
        assert.strictEqual(fs.readFileSync(supportFilePath, 'utf8'), supportContentWithoutDdTrace)
        assert.doesNotMatch(fs.readFileSync(supportFilePath, 'utf8'), /dd-trace\/ci\/cypress\/support/)
        assert.deepStrictEqual(getSupportWrappers(), wrapperFilesBefore)
      } finally {
        fs.writeFileSync(supportFilePath, originalSupportContent)
      }
    })

    over10It('retries when dd:beforeEach returns no result once', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)
      let testOutput = ''

      childProcess = exec(testCommand, {
        cwd,
        env: {
          ...envVars,
          CYPRESS_BASE_URL: webAppBaseUrl,
          CYPRESS_DD_BEFORE_EACH_NO_RESULT_ONCE: '1',
          SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
        },
      })
      childProcess.stdout?.on('data', (data) => { testOutput += data })
      childProcess.stderr?.on('data', (data) => { testOutput += data })

      const receiverPromise = receiver
        .gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          (payloads) => {
            const events = payloads
              .flatMap(({ payload }) => payload.events)
              .filter(event => event.type === 'test')
            const passedTest = events.find(event =>
              event.content.resource === 'cypress/e2e/basic-pass.js.basic pass suite can pass'
            )

            assertObjectContains(passedTest?.content, {
              meta: {
                [TEST_STATUS]: 'pass',
                [TEST_FRAMEWORK]: 'cypress',
              },
            })
          },
          { hardTimeout: 60000 }
        )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
      assert.match(testOutput, /\[datadog:test\] dd:beforeEach call 1/)
      assert.match(testOutput, /\[datadog:test\] dd:beforeEach call 2/)
    })

    over10It('preserves config returned from setupNodeEvents', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)

      const returnConfigFile = type === 'esm'
        ? 'cypress-return-config.config.mjs'
        : 'cypress-return-config.config.js'

      childProcess = exec(
        `./node_modules/.bin/cypress run --config-file ${returnConfigFile}`,
        {
          cwd,
          env: envVars,
        }
      )

      const receiverPromise = receiver
        .gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          (payloads) => {
            const events = payloads
              .flatMap(({ payload }) => payload.events)
              .filter(event => event.type === 'test')
            const passedTest = events.find(event =>
              event.content.resource ===
              'cypress/e2e/returned-config.cy.js.returned config uses env from setupNodeEvents return value'
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

    over10It('custom after:spec and after:run handlers are chained with dd-trace instrumentation', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)

      let testOutput = ''
      const customHooksConfigFile = type === 'esm'
        ? 'cypress-custom-after-hooks.config.mjs'
        : 'cypress-custom-after-hooks.config.js'

      childProcess = exec(
        `./node_modules/.bin/cypress run --config-file ${customHooksConfigFile}`,
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
            const events = payloads
              .flatMap(({ payload }) => payload.events)
              .filter(event => event.type === 'test')
            const passedTest = events.find(event =>
              event.content.resource === 'cypress/e2e/basic-pass.js.basic pass suite can pass'
            )
            assertObjectContains(passedTest?.content, {
              meta: {
                [TEST_STATUS]: 'pass',
                [TEST_FRAMEWORK]: 'cypress',
              },
            })
          }, { hardTimeout: 60000 })
      childProcess.stdout?.on('data', (d) => { testOutput += d })
      childProcess.stderr?.on('data', (d) => { testOutput += d })

      await Promise.all([
        once(childProcess, 'exit'),
        once(childProcess.stdout, 'end'),
        once(childProcess.stderr, 'end'),
        receiverPromise,
      ])

      // Verify both dd-trace spans AND the custom handlers ran (including their async resolutions)
      assert.match(testOutput, /\[custom:after:spec\]/)
      assert.match(testOutput, /\[custom:after:spec:resolved\]/)
      assert.match(testOutput, /\[custom:after:run\]/)
      assert.match(testOutput, /\[custom:after:run:resolved\]/)
    })

    for (const { testName, rejectionVariable, expectedError } of [
      {
        testName: 'reports the session when a custom after:run handler rejects',
        rejectionVariable: 'CYPRESS_REJECT_AFTER_RUN',
        expectedError: /custom after:run failed/,
      },
      {
        testName: 'reports a string rejection from a custom after:run handler',
        rejectionVariable: 'CYPRESS_REJECT_AFTER_RUN_WITH_STRING',
        expectedError: /custom after:run string rejection/,
      },
    ]) {
      over10It(testName, async () => {
        const envVars = getCiVisAgentlessConfig(receiver.port)
        const customHooksConfigFile = type === 'esm'
          ? 'cypress-custom-after-hooks.config.mjs'
          : 'cypress-custom-after-hooks.config.js'

        childProcess = exec(
          `./node_modules/.bin/cypress run --config-file ${customHooksConfigFile}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: webAppBaseUrl,
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
            for (const eventType of ['test_session_end', 'test_module_end']) {
              const event = events.find(event => event.type === eventType)
              assert.ok(event, `expected ${eventType} event`)
              assert.strictEqual(event.content.meta[TEST_STATUS], 'fail')
              assert.strictEqual(event.content.error, 1)
              assert.match(event.content.meta[ERROR_MESSAGE], expectedError)
            }
            const testSuite = events.find(event => event.type === 'test_suite_end')
            assert.ok(testSuite, 'expected test_suite_end event')
            assert.strictEqual(testSuite.content.meta[TEST_STATUS], 'pass')
            assert.strictEqual(testSuite.content.error, 0)
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

    over10It('keeps completed suites passing when a later after:spec handler rejects', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)
      const customHooksConfigFile = type === 'esm'
        ? 'cypress-custom-after-hooks.config.mjs'
        : 'cypress-custom-after-hooks.config.js'

      childProcess = exec(
        `./node_modules/.bin/cypress run --config-file ${customHooksConfigFile}`,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: webAppBaseUrl,
            CYPRESS_REJECT_SECOND_AFTER_SPEC: '1',
            SPEC_PATTERN: 'cypress/e2e/{basic-pass,other.cy}.js',
          },
        }
      )
      let testOutput = ''
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

      const receiverPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const suiteEvents = events.filter(event => event.type === 'test_suite_end')
          const completedSuite = suiteEvents.find(event => event.content.meta[TEST_STATUS] === 'pass')
          const failedSuite = suiteEvents.find(event => event.content.meta[TEST_STATUS] === 'fail')

          assert.strictEqual(suiteEvents.length, 2)
          assert.deepStrictEqual(suiteEvents.map(event => event.content.resource).sort(), [
            'test_suite.cypress/e2e/basic-pass.js',
            'test_suite.cypress/e2e/other.cy.js',
          ])
          assert.ok(completedSuite, `expected the completed suite event\n${testOutput}`)
          assert.strictEqual(completedSuite.content.meta[TEST_STATUS], 'pass')
          assert.strictEqual(completedSuite.content.error, 0)
          assert.ok(failedSuite, 'expected the failed suite event')
          assert.strictEqual(failedSuite.content.meta[TEST_STATUS], 'fail')
          assert.strictEqual(failedSuite.content.error, 1)
          assert.match(failedSuite.content.meta[ERROR_MESSAGE], /custom after:spec failed/)

          for (const eventType of ['test_session_end', 'test_module_end']) {
            const event = events.find(event => event.type === eventType)
            assert.ok(event, `expected ${eventType} event`)
            assert.strictEqual(event.content.meta[TEST_STATUS], 'fail')
            assert.strictEqual(event.content.error, 1)
            assert.match(event.content.meta[ERROR_MESSAGE], /custom after:spec failed/)
          }
        },
        { hardTimeout: 60000 }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.notStrictEqual(exitCode, 0)
    })

    for (const { testName, rejectionVariable, expectedError } of [
      {
        testName: 'reports a failed test session trace when after:spec prevents Cypress after:run',
        rejectionVariable: 'CYPRESS_REJECT_AFTER_SPEC',
        expectedError: /custom after:spec failed/,
      },
      {
        testName: 'reports a failed test session trace when after:spec rejects without a reason',
        rejectionVariable: 'CYPRESS_REJECT_AFTER_SPEC_WITHOUT_REASON',
        expectedError: /Cypress user handler rejected without an error/,
      },
    ]) {
      over10It(testName, async () => {
        const envVars = getCiVisAgentlessConfig(receiver.port)
        const customHooksConfigFile = type === 'esm'
          ? 'cypress-custom-after-hooks.config.mjs'
          : 'cypress-custom-after-hooks.config.js'
        const startedAt = Date.now()
        const supportDirectory = path.join(cwd, 'cypress', 'support')
        const supportWrappersBefore = getGeneratedSupportFiles(supportDirectory)

        childProcess = exec(
          `./node_modules/.bin/cypress run --config-file ${customHooksConfigFile}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: webAppBaseUrl,
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
              assert.match(testSessionTraceEvents[0].content.meta[ERROR_MESSAGE], expectedError)
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
        assert.ok(Date.now() - startedAt < 20_000, 'final writer flush should remain bounded')
        assert.deepStrictEqual(getGeneratedSupportFiles(supportDirectory), supportWrappersBefore)
      })
    }

    over10It('bounds after:spec error finalization while a screenshot upload is pending', async () => {
      receiver.setMediaResponsesPending()
      const envVars = getCiVisAgentlessConfig(receiver.port)
      const customHooksConfigFile = type === 'esm'
        ? 'cypress-custom-after-hooks.config.mjs'
        : 'cypress-custom-after-hooks.config.js'
      const startedAt = Date.now()
      let testOutput = ''

      childProcess = exec(
        `./node_modules/.bin/cypress run --config-file ${customHooksConfigFile} ` +
        '--config screenshotOnRunFailure=true',
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: webAppBaseUrl,
            CYPRESS_REJECT_AFTER_SPEC: '1',
            DD_TEST_FAILURE_SCREENSHOTS_ENABLED: 'true',
            SPEC_PATTERN: 'cypress/e2e/basic-fail.js',
          },
        }
      )
      childProcess.stdout?.on('data', chunk => { testOutput += chunk.toString() })
      childProcess.stderr?.on('data', chunk => { testOutput += chunk.toString() })

      const receiverPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          for (const eventType of ['test_suite_end', 'test']) {
            const event = events.find(event => event.type === eventType)
            assert.ok(event, `expected ${eventType} event\n${testOutput}`)
            assert.strictEqual(event.content.meta[TEST_STATUS], 'fail')
          }
          const suiteEvent = events.find(event => event.type === 'test_suite_end')
          assert.match(suiteEvent.content.meta[ERROR_MESSAGE], /custom after:spec failed/)
        },
        { hardTimeout: 30_000 }
      ).catch((error) => {
        error.message += `\nCypress output:\n${testOutput}`
        throw error
      })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.notStrictEqual(exitCode, 0)
      assert.ok(Date.now() - startedAt < 20_000, 'final writer flush should remain bounded')
    })

    // Tests the old manual API: dd-trace/ci/cypress/after-run and after-spec
    // used alongside the manual plugin, without NODE_OPTIONS auto-instrumentation.
    over10It('works if after:run and after:spec are explicitly used with the manual plugin', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: webAppBaseUrl,
            CYPRESS_ENABLE_AFTER_RUN_CUSTOM: '1',
            CYPRESS_ENABLE_AFTER_SPEC_CUSTOM: '1',
            CYPRESS_ENABLE_MANUAL_PLUGIN: '1',
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
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
          (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const testSessionEvent = events.find(event => event.type === 'test_session_end')
            assert.ok(testSessionEvent)
            const testEvents = events.filter(event => event.type === 'test')
            assert.ok(testEvents.length > 0, `Expected ${testEvents.length} > 0`)
          }, { hardTimeout: 30000 })

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])
    })

    // Exercises the _isInit=true channel path: NODE_OPTIONS activates auto-instrumentation
    // (wrapSetupNodeEvents), the manual plugin sets _isInit=true, and the channel subscriber
    // chains the after:spec/after:run handlers intercepted by wrappedOn.
    // Differs from the backwards-compat test (APM protocol, single pass) by validating
    // the full citestcycle test session trace through the channel's _isInit=true branch.
    over10It('correctly chains hooks when auto-instrumentation and manual plugin are both active', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)
      let testOutput = ''

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
            CYPRESS_ENABLE_AFTER_SPEC_USER: '1',
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
        once(childProcess.stdout, 'end'),
        once(childProcess.stderr, 'end'),
        receiverPromise,
      ])

      assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
      assert.match(testOutput, /\[custom:after:spec:manual\]/)
    })

    over10It('keeps same-copy manual tasks when an adapter wraps its lifecycle handlers', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)
      const legacyConfigFile = type === 'esm'
        ? 'cypress-legacy-plugin.config.mjs'
        : 'cypress-legacy-plugin.config.js'
      let testOutput = ''

      childProcess = exec(
        `./node_modules/.bin/cypress run --config-file ${legacyConfigFile}`,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: webAppBaseUrl,
            CYPRESS_SIMULATE_OLD_MANUAL_PLUGIN: '1',
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
          assert.strictEqual(events.filter(event => event.type === 'test_session_end').length, 1)
          assert.strictEqual(events.filter(event => event.type === 'test_module_end').length, 1)
          assert.strictEqual(events.filter(event => event.type === 'test_suite_end').length, 1)
          assert.strictEqual(events.filter(event => event.type === 'test').length, 1)
        },
        { hardTimeout: 60000 }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.strictEqual(exitCode, 0, `cypress process should exit successfully\n${testOutput}`)
      assert.doesNotMatch(testOutput, /The task 'dd:/)
      assert.doesNotMatch(testOutput, /Multiple attempts to register the following task/)
    })

    over10It('reports a failed test session trace when a handler after the manual plugin rejects', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)
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
            CYPRESS_REJECT_AFTER_RUN_AFTER_PLUGIN: '1',
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        }
      )

      const receiverPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          for (const eventType of ['test_session_end', 'test_module_end']) {
            const event = events.find(event => event.type === eventType)
            assert.ok(event, `expected ${eventType} event`)
            assert.strictEqual(event.content.meta[TEST_STATUS], 'fail')
            assert.strictEqual(event.content.error, 1)
            assert.match(event.content.meta[ERROR_MESSAGE], /manual after:run failed after Datadog/)
          }
          const testSuite = events.find(event => event.type === 'test_suite_end')
          assert.ok(testSuite, 'expected test_suite_end event')
          assert.strictEqual(testSuite.content.meta[TEST_STATUS], 'pass')
          assert.strictEqual(testSuite.content.error, 0)
        },
        { hardTimeout: 60000 }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.notStrictEqual(exitCode, 0)
    })

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

// These plugin lifecycle and filesystem tests do not depend on a Cypress version. Run them in one existing
// integration matrix cell instead of repeating them for every supported version and module type.
{
  const matrixSuite = requestedVersion === 'latest' &&
    (!process.env.CYPRESS_MODULE_TYPE || process.env.CYPRESS_MODULE_TYPE === 'commonJS')
    ? describe
    : describe.skip
  matrixSuite('Cypress plugin run lifecycle', () => {
    const cypressPlugin = require('../../packages/datadog-plugin-cypress/src/cypress-plugin')
    const originalState = {
      cypressConfig: cypressPlugin.cypressConfig,
      isInit: cypressPlugin._isInit,
      libraryConfigurationPromise: cypressPlugin.libraryConfigurationPromise,
      hasOriginalCypressRetries: cypressPlugin.hasOriginalCypressRetries,
      originalCypressRetries: cypressPlugin.originalCypressRetries,
      tracer: cypressPlugin.tracer,
      finishedTestsByFile: cypressPlugin.finishedTestsByFile,
      testsToSkip: cypressPlugin.testsToSkip,
      testSessionSpan: cypressPlugin.testSessionSpan,
      testModuleSpan: cypressPlugin.testModuleSpan,
      testSuiteSpan: cypressPlugin.testSuiteSpan,
      pendingScreenshotUploads: cypressPlugin.pendingScreenshotUploads,
      pendingVideoUploads: cypressPlugin.pendingVideoUploads,
      uploadedVideoPaths: cypressPlugin.uploadedVideoPaths,
      screenshotUploadAbortControllers: cypressPlugin.screenshotUploadAbortControllers,
    }

    afterEach(() => {
      cypressPlugin.cypressConfig = originalState.cypressConfig
      cypressPlugin._isInit = originalState.isInit
      cypressPlugin.libraryConfigurationPromise = originalState.libraryConfigurationPromise
      cypressPlugin.hasOriginalCypressRetries = originalState.hasOriginalCypressRetries
      cypressPlugin.originalCypressRetries = originalState.originalCypressRetries
      cypressPlugin.tracer = originalState.tracer
      cypressPlugin.finishedTestsByFile = originalState.finishedTestsByFile
      cypressPlugin.testsToSkip = originalState.testsToSkip
      cypressPlugin.testSessionSpan = originalState.testSessionSpan
      cypressPlugin.testModuleSpan = originalState.testModuleSpan
      cypressPlugin.testSuiteSpan = originalState.testSuiteSpan
      cypressPlugin.pendingScreenshotUploads = originalState.pendingScreenshotUploads
      cypressPlugin.pendingVideoUploads = originalState.pendingVideoUploads
      cypressPlugin.uploadedVideoPaths = originalState.uploadedVideoPaths
      cypressPlugin.screenshotUploadAbortControllers = originalState.screenshotUploadAbortControllers
      sinon.restore()
    })

    it('waits for the existing initialization before the first run', async () => {
      const initializationError = new Error('stop after existing initialization')
      cypressPlugin._isInit = true
      cypressPlugin.libraryConfigurationPromise = Promise.reject(initializationError)
      const init = sinon.stub(cypressPlugin, 'init')

      await assert.rejects(cypressPlugin.beforeRun({}), error => {
        assert.strictEqual(error, initializationError)
        return true
      })

      sinon.assert.notCalled(init)
    })

    it('reinitializes before a subsequent interactive run', async () => {
      const initializationError = new Error('stop after reinitialization')
      const tracer = {}
      const cypressConfig = {}
      cypressPlugin._isInit = false
      cypressPlugin.tracer = tracer
      cypressPlugin.cypressConfig = cypressConfig
      const init = sinon.stub(cypressPlugin, 'init').rejects(initializationError)

      await assert.rejects(cypressPlugin.beforeRun({}), error => {
        assert.strictEqual(error, initializationError)
        return true
      })

      sinon.assert.calledOnceWithExactly(init, tracer, cypressConfig)
    })

    for (const [description, cypressConfig] of [
      ['finishes completed suites without an after:run boundary', {
        isTextTerminal: false,
        isInteractive: true,
        experimentalInteractiveRunEvents: false,
      }],
      ['finishes completed suites in terminal runs', {
        isTextTerminal: true,
        // Cypress 12 can leave this true during `cypress run`.
        isInteractive: true,
        experimentalInteractiveRunEvents: false,
      }],
      ['finishes completed suites when interactive run events are enabled', {
        isTextTerminal: false,
        isInteractive: true,
        experimentalInteractiveRunEvents: true,
      }],
    ]) {
      it(description, () => {
        const testSuiteSpan = {
          finish: sinon.stub(),
          setTag: sinon.stub(),
        }
        cypressPlugin.cypressConfig = cypressConfig
        cypressPlugin.finishedTestsByFile = {}
        cypressPlugin.testsToSkip = []
        cypressPlugin.testSuiteSpan = testSuiteSpan
        cypressPlugin.tracer = { _tracer: { _exporter: {} } }
        sinon.stub(cypressPlugin, 'ciVisEvent')

        cypressPlugin.afterSpec({ relative: 'cypress/e2e/basic-pass.js' }, { stats: { tests: 1 } })

        sinon.assert.calledOnce(testSuiteSpan.finish)
      })
    }

    it('starts a suite video upload from after:run after Cypress video processing', async () => {
      const testSuiteSpan = {
        context: () => ({ toSpanId: () => '456' }),
        finish: sinon.stub(),
        setTag: sinon.stub(),
      }
      cypressPlugin.cypressConfig = { isTextTerminal: true }
      cypressPlugin.finishedTestsByFile = {}
      cypressPlugin.testsToSkip = []
      cypressPlugin.pendingScreenshotUploads = []
      cypressPlugin.pendingVideoUploads = []
      cypressPlugin._isInit = true
      cypressPlugin.testSessionSpan = { context: () => ({ toTraceId: () => '123' }) }
      cypressPlugin.testSuiteSpan = testSuiteSpan
      cypressPlugin.tracer = {
        _tracer: {
          _exporter: {
            canUploadTestVideos: () => true,
            uploadTestSuiteVideo: sinon.stub(),
          },
        },
      }
      cypressPlugin.uploadedVideoPaths = new Set()
      sinon.stub(cypressPlugin, 'ciVisEvent')
      const upload = sinon.stub(cypressPlugin, 'uploadTestSuiteVideo').resolves(VIDEO_UPLOAD_RESULT_UPLOADED)

      const result = cypressPlugin.afterSpec(
        { relative: 'cypress/e2e/basic-fail.js' },
        { stats: { failures: 1, tests: 1 }, video: '/tmp/basic-fail.mp4' }
      )

      assert.strictEqual(result, undefined)
      sinon.assert.notCalled(upload)
      sinon.assert.notCalled(testSuiteSpan.finish)

      await cypressPlugin.afterRun({})

      sinon.assert.calledOnceWithExactly(upload, {
        filePath: '/tmp/basic-fail.mp4',
        testSessionId: '123',
        testSuiteId: '456',
      })
      sinon.assert.calledOnce(testSuiteSpan.finish)
      sinon.assert.calledWith(testSuiteSpan.setTag, TEST_FAILURE_VIDEO_UPLOADED, 'true')
      sinon.assert.calledWith(testSuiteSpan.setTag, TEST_FAILURE_VIDEO_SCOPE, VIDEO_UPLOAD_SCOPE_TEST_SUITE)
    })

    it('defers a failed suite video to after:run when a user after:spec handler fails', async () => {
      const userError = new Error('user after:spec failed')
      const testSuiteSpan = {
        context: () => ({ toSpanId: () => '456' }),
        finish: sinon.stub(),
        setTag: sinon.stub(),
      }
      cypressPlugin.cypressConfig = { isTextTerminal: true }
      cypressPlugin.finishedTestsByFile = {}
      cypressPlugin.testsToSkip = []
      cypressPlugin.pendingScreenshotUploads = []
      cypressPlugin.pendingVideoUploads = []
      cypressPlugin._isInit = true
      cypressPlugin.testSessionSpan = {
        context: () => ({
          toTraceId: () => '123',
          _trace: { started: [testSuiteSpan] },
        }),
      }
      cypressPlugin.testModuleSpan = null
      cypressPlugin.testSuiteSpan = testSuiteSpan
      cypressPlugin.tracer = {
        _tracer: {
          _exporter: {
            canUploadTestVideos: () => true,
            uploadTestSuiteVideo: sinon.stub(),
          },
        },
      }
      cypressPlugin.uploadedVideoPaths = new Set()
      sinon.stub(cypressPlugin, 'ciVisEvent')
      const upload = sinon.stub(cypressPlugin, 'uploadTestSuiteVideo').resolves(VIDEO_UPLOAD_RESULT_UPLOADED)

      await cypressPlugin.afterSpec(
        { relative: 'cypress/e2e/basic-fail.js' },
        { stats: { passes: 1, tests: 1 }, video: '/tmp/basic-fail.mp4' },
        userError
      )

      sinon.assert.notCalled(upload)
      assert.strictEqual(cypressPlugin.pendingVideoUploads.length, 1)
      assertObjectContains(cypressPlugin.pendingVideoUploads[0], {
        filePath: '/tmp/basic-fail.mp4',
        testSessionId: '123',
        testSuiteId: '456',
        testSuiteSpan,
      })
      sinon.assert.notCalled(testSuiteSpan.finish)

      await cypressPlugin.afterRun({})

      sinon.assert.calledOnceWithExactly(upload, {
        filePath: '/tmp/basic-fail.mp4',
        testSessionId: '123',
        testSuiteId: '456',
      })
      assert.deepStrictEqual(cypressPlugin.pendingVideoUploads, [])
      sinon.assert.calledOnce(testSuiteSpan.finish)
    })

    it('keeps suite video uploads out of screenshot cancellation', async () => {
      const uploadTestSuiteVideo = sinon.stub().callsFake((options, callback) => callback())
      cypressPlugin.uploadedVideoPaths = new Set()
      cypressPlugin.screenshotUploadAbortControllers = new Set()
      cypressPlugin.tracer = {
        _tracer: {
          _exporter: {
            canUploadTestVideos: () => true,
            uploadTestSuiteVideo,
          },
        },
      }

      const result = cypressPlugin.uploadTestSuiteVideo({
        filePath: '/tmp/basic-fail.mp4',
        testSessionId: '123',
        testSuiteId: '456',
      })

      assert.strictEqual(await result, VIDEO_UPLOAD_RESULT_UPLOADED)
      sinon.assert.calledOnce(uploadTestSuiteVideo)
      assert.strictEqual(uploadTestSuiteVideo.firstCall.args[0].signal, undefined)
      assert.strictEqual(typeof uploadTestSuiteVideo.firstCall.args[1], 'function')
      const screenshotController = new AbortController()
      cypressPlugin.screenshotUploadAbortControllers.add(screenshotController)
      const laterSpecError = new Error('later spec failed')

      cypressPlugin.abortPendingScreenshotUploads(laterSpecError)

      assert.strictEqual(screenshotController.signal.reason, laterSpecError)
      assert.strictEqual(cypressPlugin.screenshotUploadAbortControllers.size, 0)
    })

    for (const [description, uploadError, expectedTag, unexpectedTag] of [
      [
        'tags every test and the suite when a suite video is uploaded',
        undefined,
        TEST_FAILURE_VIDEO_UPLOADED,
        TEST_FAILURE_VIDEO_UPLOAD_ERROR,
      ],
      [
        'tags every test and the suite when a suite video upload fails',
        new Error('upload failed'),
        TEST_FAILURE_VIDEO_UPLOAD_ERROR,
        TEST_FAILURE_VIDEO_UPLOADED,
      ],
    ]) {
      it(description, async () => {
        const makeSpan = () => ({
          finish: sinon.stub(),
          setTag: sinon.stub(),
        })
        const firstTestSpan = makeSpan()
        const secondTestSpan = makeSpan()
        const testSuiteSpan = makeSpan()
        const uploadTestSuiteVideo = sinon.stub().callsFake((options, callback) => callback(uploadError))
        cypressPlugin.uploadedVideoPaths = new Set()
        cypressPlugin.pendingVideoUploads = [{
          filePath: '/tmp/basic-fail.mp4',
          testSessionId: '123',
          testSuiteId: '456',
          testSpanFinishes: [{ testSpan: firstTestSpan }, { testSpan: secondTestSpan }],
          testSuiteSpan,
        }]
        cypressPlugin.tracer = {
          _tracer: {
            _exporter: {
              canUploadTestVideos: () => true,
              uploadTestSuiteVideo,
            },
          },
        }
        sinon.stub(cypressPlugin, 'ciVisEvent')

        await cypressPlugin.uploadPendingTestSuiteVideos()

        for (const span of [firstTestSpan, secondTestSpan, testSuiteSpan]) {
          sinon.assert.calledWith(span.setTag, expectedTag, 'true')
          sinon.assert.calledWith(span.setTag, TEST_FAILURE_VIDEO_SCOPE, VIDEO_UPLOAD_SCOPE_TEST_SUITE)
          sinon.assert.neverCalledWith(span.setTag, unexpectedTag, 'true')
          sinon.assert.calledOnce(span.finish)
        }
      })
    }

    it('does not add video tags when no suite video upload is configured', () => {
      const testSpan = {
        finish: sinon.stub(),
        setTag: sinon.stub(),
      }

      cypressPlugin.finishTestSpans([{ testSpan }])

      sinon.assert.neverCalledWith(testSpan.setTag, TEST_FAILURE_VIDEO_UPLOADED, 'true')
      sinon.assert.neverCalledWith(testSpan.setTag, TEST_FAILURE_VIDEO_UPLOAD_ERROR, 'true')
      sinon.assert.neverCalledWith(testSpan.setTag, TEST_FAILURE_VIDEO_SCOPE, VIDEO_UPLOAD_SCOPE_TEST_SUITE)
      sinon.assert.calledOnce(testSpan.finish)
    })

    it('restores user retries before requesting configuration for a subsequent run', async () => {
      const cypressConfig = { retries: { openMode: 1, runMode: 2 }, version: '12.0.0' }
      cypressPlugin.cypressConfig = cypressConfig
      cypressPlugin.hasOriginalCypressRetries = true
      cypressPlugin.originalCypressRetries = { openMode: 1, runMode: 2 }
      cypressConfig.retries.runMode = 5

      const tracer = {
        _tracer: {
          _config: { isServiceUserProvided: false },
        },
      }

      const result = await cypressPlugin.init(tracer, cypressConfig)

      assert.strictEqual(result.retries.openMode, 1)
      assert.strictEqual(result.retries.runMode, 2)
    })
  })

  matrixSuite('cypress config instrumentation', () => {
    const temporaryDirectories = []
    let errors

    beforeEach(() => {
      errors = []
      sinon.stub(console, 'error').callsFake((...args) => errors.push(format(...args)))
    })

    afterEach(() => {
      sinon.restore()
      for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { force: true, recursive: true })
      }
    })

    /**
     * @param {string} code filesystem error code
     * @param {string} filePath affected path
     * @param {string} [syscall] failed system call
     * @returns {Error & { code: string, path: string, syscall: string }} filesystem error
     */
    function createFileError (code, filePath, syscall = 'open') {
      return Object.assign(new Error(`${code}: ${syscall} ${filePath}`), {
        code,
        path: filePath,
        syscall,
      })
    }

    /**
     * @returns {string} temporary Cypress project root
     */
    function createProjectRoot () {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-cypress-config-'))
      temporaryDirectories.push(projectRoot)
      return projectRoot
    }

    /**
     * @param {object} [fsStub] filesystem overrides
     * @param {() => string} [randomUUID] UUID generator
     * @param {object} [setupNodeEventsChannel] setup-node-events diagnostic channel
     * @returns {{
     *   cypressConfig: object,
     *   errors: string[],
     *   manualPluginOwner: object,
     *   warnings: string[]
     * }} loaded instrumentation and logs
     */
    function loadCypressConfig (fsStub, randomUUID, setupNodeEventsChannel) {
      const warnings = []
      let uuid = 0
      const log = {
        error: (...args) => errors.push(format(...args)),
        warn: (...args) => warnings.push(format(...args)),
      }
      const finalization = proxyquire('../../packages/datadog-plugin-cypress/src/finalization', {
        '../../dd-trace/src/log': log,
      })
      const stubs = {
        crypto: {
          randomUUID: randomUUID || (() => `uuid-${++uuid}`),
        },
        '../../datadog-plugin-cypress/src/finalization': finalization,
        '../../dd-trace/src/log': log,
        './helpers/instrument': {
          channel: () => setupNodeEventsChannel || { hasSubscribers: false, publish: () => {} },
        },
      }

      if (fsStub) stubs.fs = fsStub

      return {
        cypressConfig: proxyquire('../../packages/datadog-instrumentations/src/cypress-config', stubs),
        errors,
        manualPluginOwner: finalization.manualPluginOwner,
        warnings,
      }
    }

    /**
     * @param {object} cypressConfig Cypress config instrumentation
     * @param {object} resolvedConfig resolved Cypress config
     * @returns {{ handlers: Record<string, Function>, result: object }} registered handlers and returned config
     */
    function injectSupportFile (cypressConfig, resolvedConfig) {
      const configFile = { e2e: {} }
      const handlers = {}
      cypressConfig.wrapConfig(configFile)

      const result = configFile.e2e.setupNodeEvents((event, handler) => {
        handlers[event] = handler
      }, resolvedConfig)

      return { handlers, result }
    }

    /**
     * @param {string} directory directory to inspect
     * @returns {string[]} generated Cypress files
     */
    function getGeneratedFiles (directory) {
      return fs.readdirSync(directory)
        .filter(file => file.startsWith('dd-cypress-support-') || file.startsWith('.dd-cypress-config-'))
    }

    /**
     * @param {string} code error code raised after a partial write
     * @param {(writeNumber: number) => boolean} [shouldFail] selects the write that fails
     * @returns {object} filesystem stub
     */
    function createPartialWriteFailure (code, shouldFail = () => true) {
      const pathsByDescriptor = new Map()
      let writeNumber = 0

      return {
        openSync (filePath, flags) {
          const descriptor = fs.openSync(filePath, flags)
          pathsByDescriptor.set(descriptor, filePath)
          return descriptor
        },
        writeFileSync (file, content, ...args) {
          if (typeof file === 'number' && pathsByDescriptor.has(file)) {
            writeNumber++
            if (!shouldFail(writeNumber)) return fs.writeFileSync(file, content, ...args)

            const filePath = pathsByDescriptor.get(file)
            fs.writeFileSync(file, 'partial')
            throw createFileError(code, filePath, 'write')
          }
          return fs.writeFileSync(file, content, ...args)
        },
        closeSync (descriptor) {
          pathsByDescriptor.delete(descriptor)
          return fs.closeSync(descriptor)
        },
      }
    }

    describe('support wrapper', () => {
      it('does not enable interactive run events when Test Optimization does not register', () => {
        const projectRoot = createProjectRoot()
        const { cypressConfig, warnings } = loadCypressConfig()
        const resolvedConfig = {
          projectRoot,
          supportFile: false,
          isInteractive: true,
          experimentalInteractiveRunEvents: false,
        }

        injectSupportFile(cypressConfig, resolvedConfig)

        assert.strictEqual(resolvedConfig.experimentalInteractiveRunEvents, false)
        assert.deepStrictEqual(warnings, [])
      })

      it('enables interactive run events after Test Optimization registers', () => {
        const projectRoot = createProjectRoot()
        const setupNodeEventsChannel = {
          hasSubscribers: true,
          publish (payload) {
            payload.registered = true
          },
        }
        const { cypressConfig, warnings } = loadCypressConfig(undefined, undefined, setupNodeEventsChannel)
        const resolvedConfig = {
          projectRoot,
          supportFile: false,
          isInteractive: true,
          experimentalInteractiveRunEvents: false,
        }

        injectSupportFile(cypressConfig, resolvedConfig)

        assert.strictEqual(resolvedConfig.experimentalInteractiveRunEvents, true)
        assert.deepStrictEqual(warnings, [
          'Datadog enabled Cypress experimentalInteractiveRunEvents so Test Optimization can finish the test session.',
        ])
      })

      it('falls back to the project root when the support directory is not writable', async () => {
        const projectRoot = createProjectRoot()
        const supportDirectory = path.join(projectRoot, 'cypress', 'support')
        const supportFile = path.join(supportDirectory, 'e2e.js')
        fs.mkdirSync(supportDirectory, { recursive: true })
        fs.writeFileSync(supportFile, '// user support\n')

        const { cypressConfig, warnings } = loadCypressConfig({
          openSync (filePath, flags) {
            if (path.dirname(filePath) === supportDirectory) {
              throw createFileError('EACCES', filePath)
            }
            return fs.openSync(filePath, flags)
          },
        })
        const resolvedConfig = { projectRoot, supportFile }
        const { handlers } = injectSupportFile(cypressConfig, resolvedConfig)

        assert.strictEqual(path.dirname(resolvedConfig.supportFile), projectRoot)
        assert.deepStrictEqual(warnings, [])
        assert.strictEqual(getGeneratedFiles(projectRoot).length, 2)

        await handlers['after:run']({})
        assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
      })

      it('removes generated support files when the config process exits without after:run', () => {
        const projectRoot = createProjectRoot()
        const generatedCountFile = path.join(projectRoot, 'generated-count')
        const cypressConfigPath = require.resolve('../../packages/datadog-instrumentations/src/cypress-config')
        const script = [
          'const fs = require("node:fs")',
          `const cypressConfig = require(${JSON.stringify(cypressConfigPath)})`,
          `const projectRoot = ${JSON.stringify(projectRoot)}`,
          'const config = { e2e: {} }',
          'cypressConfig.wrapConfig(config)',
          'config.e2e.setupNodeEvents(() => {}, { projectRoot, supportFile: false })',
          'const generatedCount = fs.readdirSync(projectRoot)',
          '  .filter(file => file.startsWith("dd-cypress-support-")).length',
          `fs.writeFileSync(${JSON.stringify(generatedCountFile)}, String(generatedCount))`,
          'process.exit(0)',
        ].join('\n')

        execFileSync(process.execPath, ['-e', script], {
          env: { ...process.env, NODE_OPTIONS: '' },
        })

        assert.strictEqual(fs.readFileSync(generatedCountFile, 'utf8'), '2')
        assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
      })

      it('logs an error with every failed location when no directory is writable', () => {
        const projectRoot = createProjectRoot()
        const supportDirectory = path.join(projectRoot, 'cypress', 'support')
        const supportFile = path.join(supportDirectory, 'e2e.js')
        fs.mkdirSync(supportDirectory, { recursive: true })
        fs.writeFileSync(supportFile, '// user support\n')

        const { cypressConfig, errors, warnings } = loadCypressConfig({
          openSync (filePath) {
            throw createFileError('EROFS', filePath)
          },
        })
        const resolvedConfig = { projectRoot, supportFile }
        injectSupportFile(cypressConfig, resolvedConfig)

        assert.strictEqual(resolvedConfig.supportFile, supportFile)
        assert.strictEqual(errors.length, 1)
        assert.deepStrictEqual(warnings, [])
        assert.match(errors[0], /^ERROR: Datadog could not create the Cypress support wrapper/)
        assert.strictEqual(errors[0].match(/EROFS during open/g).length, 2)
        assert.match(errors[0], new RegExp(supportDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        assert.match(errors[0], new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      })

      it('logs an error when the original support file cannot be read', () => {
        const projectRoot = createProjectRoot()
        const supportFile = path.join(projectRoot, 'e2e.js')
        fs.writeFileSync(supportFile, '// user support\n')

        const { cypressConfig, errors } = loadCypressConfig({
          readFileSync (filePath, ...args) {
            if (filePath === supportFile) throw createFileError('EACCES', filePath, 'read')
            return fs.readFileSync(filePath, ...args)
          },
        })
        const resolvedConfig = { projectRoot, supportFile }
        injectSupportFile(cypressConfig, resolvedConfig)

        assert.strictEqual(resolvedConfig.supportFile, supportFile)
        assert.strictEqual(errors.length, 1)
        assert.match(errors[0], /^ERROR: Datadog could not read the Cypress support file/)
        assert.match(errors[0], /EACCES during read/)
      })

      it('logs an error when the Datadog browser hooks cannot be read', () => {
        const projectRoot = createProjectRoot()
        const browserHooksPath = require.resolve('../../packages/datadog-plugin-cypress/src/support')

        const { cypressConfig, errors } = loadCypressConfig({
          readFileSync (filePath, ...args) {
            if (filePath === browserHooksPath) throw createFileError('EACCES', filePath, 'read')
            return fs.readFileSync(filePath, ...args)
          },
        })
        const resolvedConfig = { projectRoot, supportFile: false }
        injectSupportFile(cypressConfig, resolvedConfig)

        assert.strictEqual(resolvedConfig.supportFile, false)
        assert.strictEqual(errors.length, 1)
        assert.match(errors[0], /^ERROR: Datadog could not read its Cypress browser support hooks/)
        assert.match(errors[0], /EACCES during read/)
      })

      it('logs an error when no project directory is available for the support wrapper', () => {
        const { cypressConfig, errors } = loadCypressConfig()
        const resolvedConfig = { supportFile: false }
        injectSupportFile(cypressConfig, resolvedConfig)

        assert.strictEqual(resolvedConfig.supportFile, false)
        assert.strictEqual(errors.length, 1)
        assert.match(errors[0], /^ERROR: Datadog could not create the Cypress support wrapper/)
        assert.match(errors[0], /no project directory was available/)
      })

      it('removes partial support files when the filesystem runs out of space', () => {
        const projectRoot = createProjectRoot()
        const supportDirectory = path.join(projectRoot, 'cypress', 'support')
        const supportFile = path.join(supportDirectory, 'e2e.js')
        fs.mkdirSync(supportDirectory, { recursive: true })
        fs.writeFileSync(supportFile, '// user support\n')

        const { cypressConfig, errors } = loadCypressConfig(createPartialWriteFailure('ENOSPC'))
        injectSupportFile(cypressConfig, { projectRoot, supportFile })

        assert.strictEqual(errors.length, 1)
        assert.match(errors[0], /ENOSPC during write/)
        assert.deepStrictEqual(getGeneratedFiles(supportDirectory), [])
        assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
      })

      it('removes the browser hooks when writing the support wrapper fails', () => {
        const projectRoot = createProjectRoot()
        const supportDirectory = path.join(projectRoot, 'cypress', 'support')
        const supportFile = path.join(supportDirectory, 'e2e.js')
        fs.mkdirSync(supportDirectory, { recursive: true })
        fs.writeFileSync(supportFile, '// user support\n')

        const failWrapperWrites = writeNumber => writeNumber % 2 === 0
        const { cypressConfig, errors } = loadCypressConfig(
          createPartialWriteFailure('ENOSPC', failWrapperWrites)
        )
        injectSupportFile(cypressConfig, { projectRoot, supportFile })

        assert.strictEqual(errors.length, 1)
        assert.strictEqual(errors[0].match(/ENOSPC during write/g).length, 2)
        assert.deepStrictEqual(getGeneratedFiles(supportDirectory), [])
        assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
      })

      it('removes partial support files when closing them fails', () => {
        const projectRoot = createProjectRoot()
        const supportDirectory = path.join(projectRoot, 'cypress', 'support')
        const supportFile = path.join(supportDirectory, 'e2e.js')
        const pathsByDescriptor = new Map()
        fs.mkdirSync(supportDirectory, { recursive: true })
        fs.writeFileSync(supportFile, '// user support\n')

        const { cypressConfig, errors } = loadCypressConfig({
          openSync (filePath, flags) {
            const descriptor = fs.openSync(filePath, flags)
            pathsByDescriptor.set(descriptor, filePath)
            return descriptor
          },
          closeSync (descriptor) {
            const filePath = pathsByDescriptor.get(descriptor)
            pathsByDescriptor.delete(descriptor)
            fs.closeSync(descriptor)
            throw createFileError('EIO', filePath, 'close')
          },
        })
        injectSupportFile(cypressConfig, { projectRoot, supportFile })

        assert.strictEqual(errors.length, 1)
        assert.strictEqual(errors[0].match(/EIO during close/g).length, 2)
        assert.deepStrictEqual(getGeneratedFiles(supportDirectory), [])
        assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
      })

      it('warns when generated support files cannot be removed', async () => {
        const projectRoot = createProjectRoot()

        const { cypressConfig, errors, warnings } = loadCypressConfig({
          unlinkSync (filePath) {
            throw createFileError('EACCES', filePath, 'unlink')
          },
        })
        const { handlers } = injectSupportFile(cypressConfig, { projectRoot, supportFile: false })

        await handlers['after:run']({})

        assert.deepStrictEqual(errors, [])
        assert.strictEqual(warnings.length, 2)
        assert.ok(warnings.every(warning => warning.includes('could not remove generated Cypress file')))
        assert.ok(warnings.every(warning => warning.includes('EACCES during unlink')))
        assert.strictEqual(getGeneratedFiles(projectRoot).length, 2)
      })
    })

    describe('manual plugin', () => {
      it('keeps interactive run events enabled when setupNodeEvents returns a partial config', async () => {
        const projectRoot = createProjectRoot()
        const datadogAfterSpecHandler = sinon.stub()
        datadogAfterSpecHandler[Symbol.for('dd-trace.cypress.after-spec.handler')] = true
        const datadogAfterRunHandler = sinon.stub()
        datadogAfterRunHandler[Symbol.for('dd-trace.cypress.after-run.handler')] = true
        const setupNodeEventsChannel = {
          hasSubscribers: true,
          publish: sinon.stub(),
        }
        const { cypressConfig, manualPluginOwner, warnings } = loadCypressConfig(
          undefined,
          undefined,
          setupNodeEventsChannel
        )
        const taskHandler = {
          'dd:testSuiteStart': sinon.stub(),
          'dd:beforeEach': sinon.stub(),
          'dd:afterEach': sinon.stub(),
          'dd:addTags': sinon.stub(),
          [Symbol.for('dd-trace.cypress.task.handler')]: manualPluginOwner,
        }
        const config = {
          e2e: {
            setupNodeEvents (on) {
              on('after:spec', datadogAfterSpecHandler)
              on('after:run', datadogAfterRunHandler)
              on('task', taskHandler)
              return { env: { returned: true } }
            },
          },
        }
        const handlers = {}
        const initialConfig = {
          projectRoot,
          supportFile: false,
          isInteractive: true,
          experimentalInteractiveRunEvents: false,
        }
        setupNodeEventsChannel.publish.resetHistory()

        cypressConfig.wrapConfig(config)
        const returnedConfig = config.e2e.setupNodeEvents((event, handler) => {
          handlers[event] = handler
        }, initialConfig)

        assert.notStrictEqual(returnedConfig, initialConfig)
        assert.deepStrictEqual(returnedConfig.env, { returned: true })
        assert.strictEqual(returnedConfig.experimentalInteractiveRunEvents, true)
        assert.strictEqual(initialConfig.experimentalInteractiveRunEvents, true)
        assert.deepStrictEqual(warnings, [
          'Datadog enabled Cypress experimentalInteractiveRunEvents so Test Optimization can finish the test session.',
        ])
        sinon.assert.notCalled(setupNodeEventsChannel.publish)
        await handlers['after:run']({})
      })

      it('removes a pre-screenshot manual before:run handler when current instrumentation takes ownership', () => {
        const projectRoot = createProjectRoot()
        const legacyBeforeRunHandler = sinon.stub()
        const currentBeforeRunHandler = sinon.stub()
        const registrations = []
        const setupNodeEventsChannel = {
          hasSubscribers: true,
          publish: sinon.stub().callsFake((payload) => {
            if (!payload.on) return
            payload.on('before:run', currentBeforeRunHandler)
            payload.registered = true
            payload.cleanupWrapper()
          }),
        }
        const taskHandler = {
          'dd:testSuiteStart': sinon.stub(),
          'dd:beforeEach': sinon.stub(),
          'dd:afterEach': sinon.stub(),
          'dd:addTags': sinon.stub(),
        }
        const config = {
          e2e: {
            /**
             * @param {Function} on Cypress event registration function
             * @returns {void}
             */
            setupNodeEvents (on) {
              on('before:run', legacyBeforeRunHandler)
              on('after:spec', sinon.stub())
              on('after:run', sinon.stub())
              on('task', taskHandler)
            },
          },
        }
        const { cypressConfig } = loadCypressConfig(undefined, undefined, setupNodeEventsChannel)

        cypressConfig.wrapConfig(config)
        config.e2e.setupNodeEvents((event, handler) => {
          registrations.push([event, handler])
        }, { projectRoot, supportFile: false, isInteractive: false })

        assert.deepStrictEqual(
          registrations.filter(([event]) => event === 'before:run'),
          [['before:run', currentBeforeRunHandler]]
        )
      })

      it('retains current manual handlers and tasks when an adapter strips lifecycle markers', async () => {
        const projectRoot = createProjectRoot()
        const userError = new Error('user after:spec failed')
        const userHandler = sinon.stub().rejects(userError)
        const datadogAfterSpecHandler = sinon.stub()
        const datadogAfterRunHandler = sinon.stub()
        const setupNodeEventsChannel = {
          hasSubscribers: true,
          publish: sinon.stub(),
        }
        const { cypressConfig, manualPluginOwner } = loadCypressConfig(
          undefined,
          undefined,
          setupNodeEventsChannel
        )
        const taskHandler = {
          'dd:testSuiteStart': sinon.stub(),
          'dd:beforeEach': sinon.stub(),
          'dd:afterEach': sinon.stub(),
          'dd:addTags': sinon.stub(),
          [Symbol.for('dd-trace.cypress.task.handler')]: manualPluginOwner,
        }
        const config = {
          e2e: {
            /**
             * @param {Function} on Cypress event registration function
             * @returns {void}
             */
            setupNodeEvents (on) {
              on('before:run', sinon.stub())
              on('after:screenshot', sinon.stub())
              on('after:spec', (...args) => datadogAfterSpecHandler(...args))
              on('after:run', (...args) => datadogAfterRunHandler(...args))
              on('task', taskHandler)
              on('after:spec', userHandler)
            },
          },
        }
        const handlers = {}
        const spec = { relative: 'cypress/e2e/basic-pass.js' }
        const results = { stats: { passes: 1 } }
        setupNodeEventsChannel.publish.resetHistory()

        cypressConfig.wrapConfig(config)
        config.e2e.setupNodeEvents((event, handler) => {
          handlers[event] = handler
        }, { projectRoot, supportFile: false, isInteractive: false })

        await assert.rejects(handlers['after:spec'](spec, results), error => error === userError)
        sinon.assert.calledOnceWithExactly(datadogAfterSpecHandler, spec, results, userError)
        assert.strictEqual(handlers.task, taskHandler)
        sinon.assert.notCalled(setupNodeEventsChannel.publish)
        await handlers['after:run']({ totalPassed: 1 })
      })

      it('preserves user handlers when a no-op manual plugin only registers tasks', async () => {
        const projectRoot = createProjectRoot()
        const userBeforeRunHandler = sinon.stub()
        const userAfterSpecHandler = sinon.stub()
        const userAfterRunHandler = sinon.stub()
        const userAfterScreenshotHandler = sinon.stub().returns({ path: 'renamed.png' })
        const noopTaskHandler = {
          'dd:testSuiteStart': sinon.stub(),
          'dd:beforeEach': sinon.stub(),
          'dd:afterEach': sinon.stub(),
          'dd:addTags': sinon.stub(),
          [Symbol.for('dd-trace.cypress.noop-task.handler')]: true,
        }
        const setupNodeEventsChannel = {
          hasSubscribers: true,
          publish: sinon.stub(),
        }
        const config = {
          e2e: {
            /**
             * @param {Function} on Cypress event registration function
             * @returns {void}
             */
            setupNodeEvents (on) {
              on('after:screenshot', userAfterScreenshotHandler)
              on('before:run', userBeforeRunHandler)
              on('after:spec', userAfterSpecHandler)
              on('after:run', userAfterRunHandler)
              on('task', noopTaskHandler)
            },
          },
        }
        const handlers = {}
        const { cypressConfig, warnings } = loadCypressConfig(undefined, undefined, setupNodeEventsChannel)
        const spec = { relative: 'cypress/e2e/basic-pass.js' }
        const results = { stats: { passes: 1 } }
        const screenshot = { path: 'original.png' }
        const resolvedConfig = {
          projectRoot,
          supportFile: false,
          isInteractive: true,
          experimentalInteractiveRunEvents: false,
        }
        setupNodeEventsChannel.publish.resetHistory()

        cypressConfig.wrapConfig(config)
        config.e2e.setupNodeEvents((event, handler) => {
          handlers[event] = handler
        }, resolvedConfig)

        await handlers['before:run']({})
        await handlers['after:spec'](spec, results)
        assert.deepStrictEqual(await handlers['after:screenshot'](screenshot), { path: 'renamed.png' })
        await handlers['after:run']({ totalPassed: 1 })

        sinon.assert.calledOnce(userBeforeRunHandler)
        sinon.assert.calledOnceWithExactly(userAfterSpecHandler, spec, results)
        sinon.assert.calledOnceWithExactly(userAfterScreenshotHandler, screenshot)
        sinon.assert.calledOnce(userAfterRunHandler)
        sinon.assert.notCalled(setupNodeEventsChannel.publish)
        assert.strictEqual(resolvedConfig.experimentalInteractiveRunEvents, false)
        assert.deepStrictEqual(warnings, [])
      })

      for (const event of ['after:run', 'after:spec']) {
        for (const position of ['before', 'after']) {
          it(`supports an older manual ${event} handler registered ${position} the user handler`, async () => {
            const projectRoot = createProjectRoot()
            const userError = new Error(`user ${event} failed`)
            const userHandler = sinon.stub().rejects(userError)
            const datadogAfterSpecHandler = sinon.stub()
            const datadogAfterRunHandler = sinon.stub()
            const taskHandler = {
              'dd:testSuiteStart': sinon.stub(),
              'dd:beforeEach': sinon.stub(),
              'dd:afterEach': sinon.stub(),
              'dd:addTags': sinon.stub(),
            }
            const config = {
              e2e: {
                /**
                 * @param {Function} on Cypress event registration function
                 * @returns {void}
                 */
                setupNodeEvents (on) {
                  if (position === 'before') on(event, userHandler)
                  on('before:run', sinon.stub())
                  on('after:screenshot', sinon.stub())
                  on('after:spec', datadogAfterSpecHandler)
                  on('after:run', datadogAfterRunHandler)
                  on('task', taskHandler)
                  if (position === 'after') on(event, userHandler)
                },
              },
            }
            const handlers = {}
            const { cypressConfig } = loadCypressConfig()
            const eventArguments = event === 'after:run'
              ? [{ totalPassed: 1 }]
              : [{ relative: 'cypress/e2e/basic-pass.js' }, { stats: { passes: 1 } }]

            cypressConfig.wrapConfig(config)
            config.e2e.setupNodeEvents((registeredEvent, handler) => {
              handlers[registeredEvent] = handler
            }, { projectRoot, supportFile: false, isInteractive: false })

            assert.strictEqual(getGeneratedFiles(projectRoot).length, 2)
            await assert.rejects(handlers[event](...eventArguments), error => error === userError)
            sinon.assert.callOrder(userHandler, event === 'after:run'
              ? datadogAfterRunHandler
              : datadogAfterSpecHandler)
            const finalizer = event === 'after:run' ? datadogAfterRunHandler : datadogAfterSpecHandler
            const finalizerError = finalizer.lastCall.args.at(-1)
            assert.ok(finalizerError instanceof Error)
            assert.strictEqual(finalizerError.message, userError.message)
            assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
          })
        }
      }

      it('cleans generated support files when an older manual after:spec finalizer rejects', async () => {
        const projectRoot = createProjectRoot()
        const finalizationError = new Error('older manual after:spec failed')
        const datadogAfterSpecHandler = sinon.stub().rejects(finalizationError)
        const taskHandler = {
          'dd:testSuiteStart': sinon.stub(),
          'dd:beforeEach': sinon.stub(),
          'dd:afterEach': sinon.stub(),
          'dd:addTags': sinon.stub(),
        }
        const config = {
          e2e: {
            /**
             * @param {Function} on Cypress event registration function
             * @returns {void}
             */
            setupNodeEvents (on) {
              on('before:run', sinon.stub())
              on('after:screenshot', sinon.stub())
              on('after:spec', datadogAfterSpecHandler)
              on('after:run', sinon.stub())
              on('task', taskHandler)
            },
          },
        }
        const handlers = {}
        const { cypressConfig } = loadCypressConfig()

        cypressConfig.wrapConfig(config)
        config.e2e.setupNodeEvents((event, handler) => {
          handlers[event] = handler
        }, { projectRoot, supportFile: false, isInteractive: false })

        assert.strictEqual(getGeneratedFiles(projectRoot).length, 2)
        await assert.rejects(handlers['after:spec']({}, {}), finalizationError)
        assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
      })

      for (const event of ['after:run', 'after:spec']) {
        it(`defers a wrapped legacy ${event} helper to the manual plugin finalizer`, async () => {
          const projectRoot = createProjectRoot()
          const legacyFinalizer = sinon.stub()
          const legacyHelper = proxyquire(`../../packages/datadog-plugin-cypress/src/${event.replace(':', '-')}`, {
            './cypress-plugin': {
              [event === 'after:run' ? 'afterRun' : 'afterSpec']: legacyFinalizer,
            },
          })
          const datadogHandler = sinon.stub()
          datadogHandler[Symbol.for(`dd-trace.cypress.${event.replace(':', '-')}.handler`)] = true
          const rejection = `${event} string rejection`
          const userHandler = sinon.stub().callsFake(() => Promise.reject(rejection))
          const taskHandler = {
            'dd:testSuiteStart': sinon.stub(),
            'dd:beforeEach': sinon.stub(),
            'dd:afterEach': sinon.stub(),
            'dd:addTags': sinon.stub(),
          }
          const config = {
            e2e: {
              /**
               * @param {Function} on Cypress event registration function
               * @returns {void}
               */
              setupNodeEvents (on) {
                on(event, (...args) => legacyHelper(...args))
                on(event, datadogHandler)
                on(event, userHandler)
                on('task', taskHandler)
              },
            },
          }
          const handlers = {}
          const { cypressConfig } = loadCypressConfig()
          const eventArguments = event === 'after:run'
            ? [{ totalPassed: 1 }]
            : [{ relative: 'cypress/e2e/basic-pass.js' }, { stats: { passes: 1 } }]

          cypressConfig.wrapConfig(config)
          config.e2e.setupNodeEvents((registeredEvent, handler) => {
            handlers[registeredEvent] = handler
          }, { projectRoot, supportFile: false, isInteractive: false })

          await assert.rejects(handlers[event](...eventArguments), error => error === rejection)
          sinon.assert.notCalled(legacyFinalizer)
          sinon.assert.calledOnce(userHandler)
          sinon.assert.calledOnce(datadogHandler)
          const finalizerError = datadogHandler.lastCall.args.at(-1)
          assert.ok(finalizerError instanceof Error)
          assert.strictEqual(finalizerError.message, rejection)

          if (event === 'after:spec') await handlers['after:run']({})
        })
      }

      for (const { position, finalization } of [
        { position: 'before', finalization: 'rejects' },
        { position: 'before', finalization: 'throws' },
        { position: 'after' },
      ]) {
        const finalizationDescription = finalization ? ` when finalization ${finalization}` : ''
        const testName =
          `finalizes with the original error from a handler registered ${position} Datadog${finalizationDescription}`
        it(testName, async () => {
          const projectRoot = createProjectRoot()
          const userError = new Error(`user handler ${position} Datadog failed`)
          const userHandler = sinon.stub().rejects(userError)
          const finalizationError = new Error('Datadog finalization failed')
          const datadogHandler = finalization
            ? sinon.stub()[finalization](finalizationError)
            : sinon.stub()
          datadogHandler[Symbol.for('dd-trace.cypress.after-run.handler')] = true
          const taskHandler = {
            'dd:testSuiteStart': sinon.stub(),
            'dd:beforeEach': sinon.stub(),
            'dd:afterEach': sinon.stub(),
            'dd:addTags': sinon.stub(),
          }
          const config = {
            e2e: {
              /**
               * @param {Function} on Cypress event registration function
               * @returns {void}
               */
              setupNodeEvents (on) {
                if (position === 'before') on('after:run', userHandler)
                on('after:run', datadogHandler)
                if (position === 'after') on('after:run', userHandler)
                on('task', taskHandler)
              },
            },
          }
          const handlers = {}
          const { cypressConfig, errors } = loadCypressConfig()
          const results = { totalPassed: 1 }

          cypressConfig.wrapConfig(config)
          config.e2e.setupNodeEvents((event, handler) => {
            handlers[event] = handler
          }, { projectRoot, supportFile: false, isInteractive: false })

          await assert.rejects(handlers['after:run'](results), error => {
            assert.strictEqual(error, userError)
            return true
          })
          sinon.assert.calledOnceWithExactly(userHandler, results)
          sinon.assert.calledOnceWithExactly(datadogHandler, results, userError)
          if (finalization) {
            assert.strictEqual(errors.length, 1)
            assert.match(errors[0], /Datadog finalization failed/)
          } else {
            assert.deepStrictEqual(errors, [])
          }
        })
      }

      for (const position of ['before', 'after']) {
        it(`runs manual Datadog after:spec finalization after a user handler registered ${position}`, async () => {
          const projectRoot = createProjectRoot()
          const userError = new Error(`user handler ${position} Datadog failed`)
          const userHandler = sinon.stub().rejects(userError)
          const datadogHandler = sinon.stub()
          datadogHandler[Symbol.for('dd-trace.cypress.after-spec.handler')] = true
          const taskHandler = {
            'dd:testSuiteStart': sinon.stub(),
            'dd:beforeEach': sinon.stub(),
            'dd:afterEach': sinon.stub(),
            'dd:addTags': sinon.stub(),
          }
          const config = {
            e2e: {
              /**
               * @param {Function} on Cypress event registration function
               * @returns {void}
               */
              setupNodeEvents (on) {
                if (position === 'before') on('after:spec', userHandler)
                on('after:spec', datadogHandler)
                if (position === 'after') on('after:spec', userHandler)
                on('task', taskHandler)
              },
            },
          }
          const handlers = {}
          const { cypressConfig } = loadCypressConfig()
          const spec = { relative: 'cypress/e2e/basic-pass.js' }
          const results = { stats: { passes: 1 } }

          cypressConfig.wrapConfig(config)
          config.e2e.setupNodeEvents((event, handler) => {
            handlers[event] = handler
          }, { projectRoot, supportFile: false, isInteractive: false })

          try {
            await assert.rejects(handlers['after:spec'](spec, results), error => {
              assert.strictEqual(error, userError)
              return true
            })
            sinon.assert.callOrder(userHandler, datadogHandler)
            sinon.assert.calledOnceWithExactly(userHandler, spec, results)
            sinon.assert.calledOnceWithExactly(datadogHandler, spec, results, userError)
          } finally {
            await handlers['after:run']({})
          }
        })
      }

      it('runs the latest after:screenshot handler after user handlers', async () => {
        const projectRoot = createProjectRoot()
        const userHandler = sinon.stub().returns({ path: 'updated.png' })
        const datadogHandler = sinon.stub()
        const datadogAfterRunHandler = sinon.stub()
        datadogAfterRunHandler[Symbol.for('dd-trace.cypress.after-run.handler')] = true
        const taskHandler = {
          'dd:testSuiteStart': sinon.stub(),
          'dd:beforeEach': sinon.stub(),
          'dd:afterEach': sinon.stub(),
          'dd:addTags': sinon.stub(),
        }
        const config = {
          e2e: {
            /**
             * @param {Function} on Cypress event registration function
             * @returns {void}
             */
            setupNodeEvents (on) {
              on('after:screenshot', userHandler)
              on('after:screenshot', datadogHandler)
              on('after:run', datadogAfterRunHandler)
              on('task', taskHandler)
            },
          },
        }
        const handlers = {}
        const { cypressConfig, warnings } = loadCypressConfig()
        const resolvedConfig = {
          projectRoot,
          supportFile: false,
          isInteractive: true,
          experimentalInteractiveRunEvents: false,
        }

        cypressConfig.wrapConfig(config)
        config.e2e.setupNodeEvents(
          /**
           * @param {string} event Cypress event name
           * @param {Function} handler Cypress event handler
           * @returns {void}
           */
          (event, handler) => {
            handlers[event] = handler
          },
          resolvedConfig
        )

        assert.strictEqual(resolvedConfig.experimentalInteractiveRunEvents, true)
        assert.deepStrictEqual(warnings, [
          'Datadog enabled Cypress experimentalInteractiveRunEvents so Test Optimization can finish the test session.',
        ])

        const details = { path: 'original.png' }
        await handlers['after:screenshot'](details)
        await handlers['after:run']({})

        assert.strictEqual(userHandler.calledOnceWithExactly(details), true)
        assert.strictEqual(datadogHandler.calledOnceWithExactly({ path: 'updated.png' }), true)
        sinon.assert.calledOnceWithExactly(datadogAfterRunHandler, {})
      })
    })

    describe('configuration wrapper', () => {
      it('falls back to the project root when the config directory is not writable', () => {
        const projectRoot = createProjectRoot()
        const configDirectory = path.join(projectRoot, 'config')
        const configFile = path.join(configDirectory, 'cypress.config.js')
        fs.mkdirSync(configDirectory)
        fs.writeFileSync(configFile, 'module.exports = {}\n')

        const { cypressConfig, warnings } = loadCypressConfig({
          openSync (filePath, flags) {
            if (path.dirname(filePath) === configDirectory) {
              throw createFileError('EACCES', filePath)
            }
            return fs.openSync(filePath, flags)
          },
        })
        const result = cypressConfig.wrapCliConfigFileOptions({
          configFile,
          project: projectRoot,
        })

        assert.strictEqual(path.dirname(result.options.configFile), projectRoot)
        assert.deepStrictEqual(warnings, [])
        assert.strictEqual(getGeneratedFiles(projectRoot).length, 1)

        result.cleanup()
        assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
      })

      it('uses .cts when a CommonJS TypeScript config falls back into an ESM scope', () => {
        const projectRoot = createProjectRoot()
        const configDirectory = path.join(projectRoot, 'config')
        const configFile = path.join(configDirectory, 'cypress.config.ts')
        fs.mkdirSync(configDirectory)
        fs.writeFileSync(path.join(projectRoot, 'package.json'), '{ "type": "module" }')
        fs.writeFileSync(path.join(configDirectory, 'package.json'), '{ "type": "commonjs" }')
        fs.writeFileSync(configFile, 'module.exports = {}\n')

        const { cypressConfig, warnings } = loadCypressConfig({
          openSync (filePath, flags) {
            if (path.dirname(filePath) === configDirectory) {
              throw createFileError('EACCES', filePath)
            }
            return fs.openSync(filePath, flags)
          },
        })
        const result = cypressConfig.wrapCliConfigFileOptions({
          configFile,
          project: projectRoot,
        })

        assert.strictEqual(path.dirname(result.options.configFile), projectRoot)
        assert.strictEqual(path.extname(result.options.configFile), '.cts')
        assert.match(fs.readFileSync(result.options.configFile, 'utf8'), /module\.exports/)
        assert.deepStrictEqual(warnings, [])

        result.cleanup()
        assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
      })

      it('uses .mts when an ESM TypeScript config falls back into a CommonJS scope', () => {
        const projectRoot = createProjectRoot()
        const configDirectory = path.join(projectRoot, 'config')
        const configFile = path.join(configDirectory, 'cypress.config.ts')
        fs.mkdirSync(configDirectory)
        fs.writeFileSync(path.join(projectRoot, 'package.json'), '{ "type": "commonjs" }')
        fs.writeFileSync(path.join(configDirectory, 'package.json'), '{ "type": "module" }')
        fs.writeFileSync(configFile, 'export default {}\n')

        const { cypressConfig, warnings } = loadCypressConfig({
          openSync (filePath, flags) {
            if (path.dirname(filePath) === configDirectory) {
              throw createFileError('EACCES', filePath)
            }
            return fs.openSync(filePath, flags)
          },
        })
        const result = cypressConfig.wrapCliConfigFileOptions({
          configFile,
          project: projectRoot,
        })

        assert.strictEqual(path.dirname(result.options.configFile), projectRoot)
        assert.strictEqual(path.extname(result.options.configFile), '.mts')
        assert.match(fs.readFileSync(result.options.configFile, 'utf8'), /export default/)
        assert.deepStrictEqual(warnings, [])

        result.cleanup()
        assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
      })

      it('warns with every failed location when no directory is writable', () => {
        const projectRoot = createProjectRoot()
        const configDirectory = path.join(projectRoot, 'config')
        const configFile = path.join(configDirectory, 'cypress.config.js')
        fs.mkdirSync(configDirectory)
        fs.writeFileSync(configFile, 'module.exports = {}\n')

        const { cypressConfig, errors, warnings } = loadCypressConfig({
          openSync (filePath) {
            throw createFileError('EROFS', filePath)
          },
        })
        const options = { configFile, project: projectRoot }
        const result = cypressConfig.wrapCliConfigFileOptions(options)

        assert.strictEqual(result.options, options)
        assert.deepStrictEqual(errors, [])
        assert.strictEqual(warnings.length, 1)
        assert.match(warnings[0], /could not create the Cypress configuration wrapper/)
        assert.strictEqual(warnings[0].match(/EROFS during open/g).length, 2)
        assert.match(warnings[0], new RegExp(configDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        assert.match(warnings[0], new RegExp(projectRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      })

      it('does not overwrite an existing configuration wrapper', () => {
        const projectRoot = createProjectRoot()
        const configFile = path.join(projectRoot, 'cypress.config.js')
        const existingWrapper = path.join(projectRoot, `.dd-cypress-config-${process.pid}-collision.cjs`)
        fs.writeFileSync(configFile, 'module.exports = {}\n')
        fs.writeFileSync(existingWrapper, 'existing content\n')

        const { cypressConfig, warnings } = loadCypressConfig(undefined, () => 'collision')
        const options = { configFile, project: projectRoot }
        const result = cypressConfig.wrapCliConfigFileOptions(options)

        assert.strictEqual(result.options, options)
        assert.strictEqual(fs.readFileSync(existingWrapper, 'utf8'), 'existing content\n')
        assert.strictEqual(warnings.length, 1)
        assert.match(warnings[0], /EEXIST during open/)
      })

      it('removes a partial configuration wrapper when the filesystem runs out of space', () => {
        const projectRoot = createProjectRoot()
        const configFile = path.join(projectRoot, 'cypress.config.js')
        fs.writeFileSync(configFile, 'module.exports = {}\n')

        const { cypressConfig, warnings } = loadCypressConfig(createPartialWriteFailure('ENOSPC'))
        const options = { configFile, project: projectRoot }
        const result = cypressConfig.wrapCliConfigFileOptions(options)

        assert.strictEqual(result.options, options)
        assert.strictEqual(warnings.length, 1)
        assert.match(warnings[0], /ENOSPC during write/)
        assert.deepStrictEqual(getGeneratedFiles(projectRoot), [])
      })
    })
  })
}
