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

const requestedVersion = process.env.CYPRESS_VERSION
const oldestVersion = DD_MAJOR >= 6 ? '12.0.0' : '6.7.0'
const version = requestedVersion === 'oldest' ? oldestVersion : requestedVersion
const hookFile = 'dd-trace/loader-hook.mjs'
const CYPRESS_PRECOMPILED_SPEC_DIST_DIR = 'cypress/e2e/dist'
const over12It = (version === 'latest' || semver.gte(version, '12.0.0')) ? it : it.skip

function cleanupPrecompiledSourceLineDist (cwd) {
  fs.rmSync(path.join(cwd, CYPRESS_PRECOMPILED_SPEC_DIST_DIR), { recursive: true, force: true })
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
        return version === '12.0.0' || version === '14.5.4'
      }
      return version === '12.0.0' || version === '14.5.4' || version === 'latest'
    }
  }
  if (DD_MAJOR === 6) {
    if (NODE_MAJOR <= 16) {
      return false
    }
    if (NODE_MAJOR > 16) {
      // Cypress 15.0.0 has removed support for Node 18
      if (NODE_MAJOR <= 18) {
        return version === '12.0.0' || version === '14.5.4'
      }
      return version === '12.0.0' || version === '14.5.4' || version === 'latest'
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
    testCommand: `node --loader=${hookFile} ./cypress-esm-config.mjs`,
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

    // cypress-fail-fast is required as an incompatible plugin.
    // typescript is required to compile .cy.ts spec files in the pre-compiled JS tests.
    useSandbox([`cypress@${version}`, 'cypress-fail-fast@7.1.0', 'typescript'], true)

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
          }, { hardTimeout: 20000 })

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

      const getSupportWrappers = () => fs.readdirSync(os.tmpdir())
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
    // the full citestcycle span hierarchy through the channel's _isInit=true branch.
    over10It('correctly chains hooks when auto-instrumentation and manual plugin are both active', async () => {
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
              assert.strictEqual(metadata['*'][TEST_SESSION_NAME], 'my-test-session')
              assert.ok(metadata['*'][TEST_COMMAND])
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
