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
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { createWebAppServer } = require('../ci-visibility/web-app-server')
const coverageFixture = require('../ci-visibility/fixtures/istanbul-map-fixture.json')
const {
  TEST_STATUS,
  TEST_COMMAND,
  TEST_MODULE,
  TEST_FRAMEWORK,
  TEST_FRAMEWORK_VERSION,
  TEST_TYPE,
  TEST_TOOLCHAIN,
  TEST_SOURCE_FILE,
  TEST_SOURCE_START,
  TEST_SUITE,
  TEST_CODE_OWNERS,
  TEST_SESSION_NAME,
  TEST_LEVEL_EVENT_TYPES,
  DD_TEST_IS_USER_PROVIDED_SERVICE,
  TEST_NAME,
  DD_CI_LIBRARY_CONFIGURATION_ERROR,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { DD_HOST_CPU_COUNT } = require('../../packages/dd-trace/src/plugins/util/env')
const { ERROR_MESSAGE, ERROR_TYPE, COMPONENT } = require('../../packages/dd-trace/src/constants')
const { DD_MAJOR, NODE_MAJOR } = require('../../version')
const {
  resolveOriginalSourceFile,
  resolveSourceLineForTest,
} = require('../../packages/datadog-plugin-cypress/src/source-map-utils')

const RECEIVER_STOP_TIMEOUT = 20000
const version = process.env.CYPRESS_VERSION
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
  const tsconfig = {
    compilerOptions: {
      rootDir: '.',
      target: 'ES2020',
      module: 'commonjs',
      sourceMap: true,
      skipLibCheck: true,
    },
  }

  const typescriptVersion = require(path.join(cwd, 'node_modules/typescript/package.json')).version
  if (semver.gte(typescriptVersion, '6.0.0')) {
    tsconfig.compilerOptions.ignoreDeprecations = '6.0'
  }

  fs.writeFileSync(path.join(cwd, 'cypress/e2e/tsconfig.json'), JSON.stringify(tsconfig, null, 2))
}

function shouldTestsRun (type) {
  if (DD_MAJOR === 5) {
    if (NODE_MAJOR <= 16) {
      return version === '6.7.0' && type === 'commonJS'
    }
    if (NODE_MAJOR > 16) {
      // Cypress 15.0.0 has removed support for Node 18
      return NODE_MAJOR > 18 ? version === 'latest' : version === '14.5.4'
    }
  }
  if (DD_MAJOR === 6) {
    if (NODE_MAJOR <= 16) {
      return false
    }
    if (NODE_MAJOR > 16) {
      // Cypress 15.0.0 has removed support for Node 18
      if (NODE_MAJOR <= 18) {
        return version === '10.2.0' || version === '14.5.4'
      }
      return version === '10.2.0' || version === '14.5.4' || version === 'latest'
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

    this.retries(2)
    this.timeout(80000)
    let cwd, receiver, childProcess, webAppPort, webAppServer

    // cypress-fail-fast is required as an incompatible plugin.
    // typescript is required to compile .cy.ts spec files in the pre-compiled JS tests.
    useSandbox([`cypress@${version}`, 'cypress-fail-fast@7.1.0', 'typescript'], true)

    before(async function () {
      // Note: Cypress binary is already installed during useSandbox() via the postinstall script
      // when the cypress npm package is installed, so no explicit install is needed here
      cwd = sandboxCwd()
    })

    beforeEach(async function () {
      receiver = await new FakeCiVisIntake().start()

      // Create a fresh web server for each test to avoid state issues
      webAppServer = createWebAppServer()
      await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
        webAppServer.once('error', reject)
        webAppServer.listen(0, 'localhost', () => {
          webAppPort = webAppServer.address().port
          webAppServer.removeListener('error', reject)
          resolve()
        })
      }))
    })

    // Cypress child processes can sometimes hang or take longer to
    // terminate. This can cause `FakeCiVisIntake#stop` to be delayed
    // because there are pending connections.
    afterEach(async () => {
      if (childProcess && childProcess.pid) {
        try {
          childProcess.kill('SIGKILL')
        } catch (error) {
          // Process might already be dead - this is fine, ignore error
        }

        // Don't wait for exit - Cypress processes can hang indefinitely in uninterruptible I/O
        // The OS will clean up zombies, and fresh server per test prevents port conflicts
      }

      // Close web server before stopping receiver
      if (webAppServer) {
        await /** @type {Promise<void>} */ (new Promise((resolve) => {
          webAppServer.close((err) => {
            if (err) {
              // eslint-disable-next-line no-console
              console.error('Web server close error:', err)
            }
            resolve()
          })
        }))
      }

      // Add timeout to prevent hanging
      const stopPromise = receiver.stop()
      const timeoutPromise = new Promise((resolve, reject) =>
        setTimeout(() => reject(new Error('Receiver stop timeout')), RECEIVER_STOP_TIMEOUT)
      )

      try {
        await Promise.race([stopPromise, timeoutPromise])
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('Receiver stop timed out:', error.message)
      }

      // Small delay to allow OS to release ports
      await new Promise(resolve => setTimeout(resolve, 100))
    })

    it('instruments tests with the APM protocol (old agents)', async () => {
      receiver.setInfoResponse({ endpoints: [] })

      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/v0.4/traces', (payloads) => {
          const testSpans = payloads.flatMap(({ payload }) => payload.flatMap(trace => trace))

          const passedTestSpan = testSpans.find(span =>
            span.resource === 'cypress/e2e/basic-pass.js.basic pass suite can pass'
          )
          const failedTestSpan = testSpans.find(span =>
            span.resource === 'cypress/e2e/basic-fail.js.basic fail suite can fail'
          )

          assertObjectContains(passedTestSpan, {
            name: 'cypress.test',
            resource: 'cypress/e2e/basic-pass.js.basic pass suite can pass',
            type: 'test',
            meta: {
              [TEST_STATUS]: 'pass',
              [TEST_NAME]: 'basic pass suite can pass',
              [TEST_SUITE]: 'cypress/e2e/basic-pass.js',
              [TEST_FRAMEWORK]: 'cypress',
              [TEST_TYPE]: 'browser',
              [TEST_CODE_OWNERS]: JSON.stringify(['@datadog-dd-trace-js']),
              customTag: 'customValue',
              addTagsBeforeEach: 'customBeforeEach',
              addTagsAfterEach: 'customAfterEach',
            },
          })
          assert.match(passedTestSpan.meta[TEST_SOURCE_FILE], /cypress\/e2e\/basic-pass\.js/)
          assert.ok(passedTestSpan.meta[TEST_FRAMEWORK_VERSION])
          assert.ok(passedTestSpan.meta[COMPONENT])
          assert.ok(passedTestSpan.metrics[TEST_SOURCE_START])

          assertObjectContains(failedTestSpan, {
            name: 'cypress.test',
            resource: 'cypress/e2e/basic-fail.js.basic fail suite can fail',
            type: 'test',
            meta: {
              [TEST_STATUS]: 'fail',
              [TEST_NAME]: 'basic fail suite can fail',
              [TEST_SUITE]: 'cypress/e2e/basic-fail.js',
              [TEST_FRAMEWORK]: 'cypress',
              [TEST_TYPE]: 'browser',
              [TEST_CODE_OWNERS]: JSON.stringify(['@datadog-dd-trace-js']),
              customTag: 'customValue',
              addTagsBeforeEach: 'customBeforeEach',
              addTagsAfterEach: 'customAfterEach',
            },
          })
          assert.match(failedTestSpan.meta[TEST_SOURCE_FILE], /cypress\/e2e\/basic-fail\.js/)
          assert.ok(failedTestSpan.meta[TEST_FRAMEWORK_VERSION])
          assert.ok(failedTestSpan.meta[COMPONENT])
          assert.ok(failedTestSpan.meta[ERROR_MESSAGE])
          assert.match(failedTestSpan.meta[ERROR_MESSAGE], /expected/)
          assert.ok(failedTestSpan.meta[ERROR_TYPE])
          assert.ok(failedTestSpan.metrics[TEST_SOURCE_START])
          // Tags added after failure should not be present because test failed
          assert.ok(!('addTagsAfterFailure' in failedTestSpan.meta))
        }, 60000)

      const envVars = getCiVisEvpProxyConfig(receiver.port)

      const specToRun = 'cypress/e2e/basic-*.js'

      // For Cypress 6.7.0, we need to override the --spec flag that's hardcoded in testCommand
      const command = version === '6.7.0'
        ? `./node_modules/.bin/cypress run --config-file cypress-config.json --spec "${specToRun}"`
        : testCommand

      childProcess = exec(
        command,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            SPEC_PATTERN: specToRun,
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])
    })

    if (version === '6.7.0') {
      it('logs a warning if using a deprecated version of cypress', async () => {
        let stdout = ''
        const {
          NODE_OPTIONS,
          ...restEnvVars
        } = getCiVisEvpProxyConfig(receiver.port)

        childProcess = exec(
          `${testCommand} --spec cypress/e2e/spec.cy.js`,
          {
            cwd,
            env: {
              ...restEnvVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            },
          }
        )

        childProcess.stdout?.on('data', (chunk) => {
          stdout += chunk.toString()
        })

        await Promise.all([
          once(childProcess, 'exit'),
          once(childProcess.stdout, 'end'),
        ])
        assert.match(
          stdout,
          /WARNING: dd-trace support for Cypress<10.2.0 is deprecated/
        )
      })
    }

    // These tests require Cypress >=10 features (defineConfig, setupNodeEvents)
    const over10It = (version !== '6.7.0') ? it : it.skip
    // Cypress <14 shipped an older ts-node ESM loader that doesn't implement the
    // current Node.js ESM hooks chain (ERR_LOADER_CHAIN_INCOMPLETE), so TS configs
    // under `"type": "module"` can't be loaded at all, regardless of dd-trace.
    const over14It = (version === 'latest' || semver.gte(version, '14.0.0')) ? it : it.skip
    over10It('is backwards compatible with the old manual plugin approach', async () => {
      receiver.setInfoResponse({ endpoints: [] })

      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url === '/v0.4/traces', (payloads) => {
          const testSpans = payloads.flatMap(({ payload }) => payload.flatMap(trace => trace))

          const passedTestSpan = testSpans.find(span =>
            span.resource === 'cypress/e2e/basic-pass.js.basic pass suite can pass'
          )

          assertObjectContains(passedTestSpan, {
            name: 'cypress.test',
            type: 'test',
            meta: {
              [TEST_STATUS]: 'pass',
              [TEST_FRAMEWORK]: 'cypress',
            },
          })
        }, 60000)

      const envVars = getCiVisEvpProxyConfig(receiver.port)

      const legacyConfigFile = type === 'esm'
        ? 'cypress-legacy-plugin.config.mjs'
        : 'cypress-legacy-plugin.config.js'

      childProcess = exec(
        `./node_modules/.bin/cypress run --config-file ${legacyConfigFile}`,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])
    })

    over10It('reports tests with old manual plugin approach without NODE_OPTIONS', async () => {
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          // Verify full span hierarchy: session, module, suites, and tests
          const sessionEvents = events.filter(event => event.type === 'test_session_end')
          const moduleEvents = events.filter(event => event.type === 'test_module_end')
          const suiteEvents = events.filter(event => event.type === 'test_suite_end')
          const testEvents = events.filter(event => event.type === 'test')

          assert.strictEqual(sessionEvents.length, 1)
          assert.strictEqual(moduleEvents.length, 1)
          assert.strictEqual(suiteEvents.length, 2, 'one suite per spec file')
          assert.ok(testEvents.length >= 2, 'at least one pass and one fail test')

          const passedTest = testEvents.find(event =>
            event.content.resource === 'cypress/e2e/basic-pass.js.basic pass suite can pass'
          )
          const failedTest = testEvents.find(event =>
            event.content.resource === 'cypress/e2e/basic-fail.js.basic fail suite can fail'
          )

          assertObjectContains(passedTest?.content, {
            meta: {
              [TEST_STATUS]: 'pass',
              [TEST_FRAMEWORK]: 'cypress',
              [TEST_TYPE]: 'browser',
            },
          })
          assert.ok(passedTest?.content.meta[TEST_SOURCE_FILE])
          assert.ok(passedTest?.content.meta[COMPONENT])

          // Sanity-check _now() time tracking: duration should be positive and under 60s
          assert.ok(passedTest.content.duration > 0, 'test duration should be positive')
          assert.ok(passedTest.content.duration < 60_000_000_000, 'test duration should be under 60s')

          assertObjectContains(failedTest?.content, {
            meta: {
              [TEST_STATUS]: 'fail',
              [TEST_FRAMEWORK]: 'cypress',
              [TEST_TYPE]: 'browser',
            },
          })
          assert.ok(failedTest?.content.meta[ERROR_MESSAGE])
        }, 60000)

      // Use EVP proxy config but strip NODE_OPTIONS so the tracer is NOT preloaded.
      // The legacy config file initializes dd-trace itself via require('dd-trace/ci/cypress/plugin').
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
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            SPEC_PATTERN: 'cypress/e2e/basic-*.js',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])
    })

    over10It('reports tests when using cypress.config.mjs with NODE_OPTIONS', async () => {
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
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
        }, 20000)

      let testOutput = ''
      const envVars = getCiVisAgentlessConfig(receiver.port)

      childProcess = exec(
        './node_modules/.bin/cypress run --config-file cypress-auto-esm.config.mjs',
        {
          cwd,
          env: {
            ...envVars,
            NODE_OPTIONS: '-r dd-trace/ci/init',
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        }
      )
      childProcess.stdout?.on('data', (d) => { testOutput += d })
      childProcess.stderr?.on('data', (d) => { testOutput += d })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.strictEqual(exitCode, 0, `cypress process should exit successfully\n${testOutput}`)
    })

    over10It('reports tests when cypress.run is called twice (multi-run state reset)', async () => {
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const passedTests = payloads
            .flatMap(({ payload }) => payload.events)
            .filter(event => event.type === 'test')
            .filter(event => event.content.resource === 'cypress/e2e/basic-pass.js.basic pass suite can pass')

          assert.strictEqual(passedTests.length, 2)
          passedTests.forEach((passedTest) => {
            assertObjectContains(passedTest.content, {
              meta: {
                [TEST_STATUS]: 'pass',
                [TEST_FRAMEWORK]: 'cypress',
              },
            })
          })
        }, 60000)

      const envVars = getCiVisAgentlessConfig(receiver.port)

      const doubleRunScript = type === 'esm'
        ? 'node ./cypress-double-run.mjs'
        : 'node ./cypress-double-run.js'

      childProcess = exec(
        doubleRunScript,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
    })

    over10It(
      'reports tests with a plain-object config when dd-trace is manually configured',
      async () => {
        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
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
          }, 60000)

        const envVars = getCiVisAgentlessConfig(receiver.port)

        const plainObjectConfigFile = type === 'esm'
          ? 'cypress-plain-object-manual.config.mjs'
          : 'cypress-plain-object-manual.config.js'

        childProcess = exec(
          `./node_modules/.bin/cypress run --config-file ${plainObjectConfigFile}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
            },
          }
        )

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])

        assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
      }
    )

    over10It(
      'auto-instruments a plain-object config without defineConfig or manual plugin',
      async () => {
        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
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
          }, 20000)

        const envVars = getCiVisAgentlessConfig(receiver.port)

        const plainObjectAutoConfigFile = type === 'esm'
          ? 'cypress-plain-object-auto.config.mjs'
          : 'cypress-plain-object-auto.config.js'

        childProcess = exec(
          `./node_modules/.bin/cypress run --config-file ${plainObjectAutoConfigFile}`,
          {
            cwd,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
              SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
            },
          }
        )

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])

        assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
      }
    )

    over10It(
      'auto-instruments a plain-object default config (no --config-file)',
      async () => {
        const originalConfig = path.join(cwd, 'cypress.config.js')
        const backupConfig = path.join(cwd, 'cypress.config.js.bak')
        const plainObjectConfig = path.join(cwd, 'cypress-plain-object-auto.config.js')

        // Replace default cypress.config.js with the plain-object config
        fs.renameSync(originalConfig, backupConfig)
        fs.copyFileSync(plainObjectConfig, originalConfig)

        try {
          const receiverPromise = receiver
            .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
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
            }, 20000)

          const envVars = getCiVisAgentlessConfig(receiver.port)

          childProcess = exec(
            './node_modules/.bin/cypress run',
            {
              cwd,
              env: {
                ...envVars,
                CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
                SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
              },
            }
          )

          const [[exitCode]] = await Promise.all([
            once(childProcess, 'exit'),
            receiverPromise,
          ])

          assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
        } finally {
          fs.renameSync(backupConfig, originalConfig)
        }
      }
    )

    over10It('reports tests with a TypeScript config file', async () => {
      let testOutput = ''
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
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
          }, `got events: ${JSON.stringify(events.map(event => ({
            resource: event.content.resource,
            sourceFile: event.content.meta?.[TEST_SOURCE_FILE],
            status: event.content.meta?.[TEST_STATUS],
            framework: event.content.meta?.[TEST_FRAMEWORK],
            error: event.content.meta?.[ERROR_MESSAGE],
          })), null, 2)}\nCypress output:\n${testOutput}`)
        }, 20000)

      const envVars = getCiVisAgentlessConfig(receiver.port)

      childProcess = exec(
        './node_modules/.bin/cypress run --config-file cypress-typescript.config.ts',
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        }
      )
      childProcess.stdout?.on('data', chunk => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', chunk => {
        testOutput += chunk.toString()
      })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
    })

    // Regression guard: when the surrounding package has "type": "module",
    // the .ts config is transpiled and loaded as ESM. Cypress's CJS
    // addHook path cannot intercept the ESM `import 'cypress'`, so the
    // only route to `wrapConfig` is the CLI-wrap path that rewrites
    // --config-file to a wrapper. An earlier version bailed out on `.ts`
    // here and silently skipped instrumentation — no test_session /
    // test_module / test_suite / test spans reached the intake.
    //
    // Set up the ESM project inside a dedicated subdirectory so Cypress
    // resolves `type: module` and the tsconfig only for this test. Using
    // the sandbox root would leak cached ts-node / webpack state into
    // later tests (Cypress caches based on the project root).
    over14It('reports tests with a TypeScript config file under "type": "module"', async () => {
      const subprojectDir = path.join(cwd, 'esm-ts-subproject')
      fs.rmSync(subprojectDir, { recursive: true, force: true })
      fs.mkdirSync(path.join(subprojectDir, 'cypress', 'e2e'), { recursive: true })
      fs.writeFileSync(path.join(subprojectDir, 'package.json'), JSON.stringify({
        name: 'esm-ts-subproject',
        type: 'module',
      }, null, 2))
      // `module: nodenext` so ts-node transpiles the `.ts` as ESM — real-world
      // ESM TS projects already ship this; the default (CommonJS) emit would
      // produce `exports is not defined in ES module scope` at runtime.
      fs.writeFileSync(path.join(subprojectDir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', target: 'ES2022' },
      }, null, 2))
      // Minimal self-contained config so the subproject doesn't depend on
      // anything under the sandbox's `cypress/` tree beyond the support
      // file (which wires dd-trace's browser-side hooks via the shared
      // `dd-trace` package already installed in the sandbox).
      fs.writeFileSync(path.join(subprojectDir, 'cypress.config.ts'), [
        "import { defineConfig } from 'cypress'",
        '',
        'export default defineConfig({',
        '  defaultCommandTimeout: 1000,',
        '  e2e: {',
        "    specPattern: 'cypress/e2e/**/*.cy.js',",
        "    supportFile: 'cypress/support/e2e.js',",
        '  },',
        '  video: false,',
        '  screenshotOnRunFailure: false,',
        '})',
        '',
      ].join('\n'))
      fs.mkdirSync(path.join(subprojectDir, 'cypress', 'support'), { recursive: true })
      fs.copyFileSync(
        path.join(cwd, 'cypress', 'support', 'e2e.js'),
        path.join(subprojectDir, 'cypress', 'support', 'e2e.js')
      )
      // Minimal passing spec so the test is self-contained and doesn't
      // depend on the rest of the sandbox's e2e tree.
      fs.writeFileSync(path.join(subprojectDir, 'cypress', 'e2e', 'basic-pass.cy.js'), [
        '/* eslint-disable */',
        "describe('basic pass suite', () => {",
        "  it('can pass', () => {",
        "    cy.visit('/')",
        "    cy.get('.hello-world').should('have.text', 'Hello World')",
        '  })',
        '})',
        '',
      ].join('\n'))

      let testOutput = ''
      try {
        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)

            // Full span hierarchy must be present — not just a stray telemetry span.
            const sessionEvents = events.filter(event => event.type === 'test_session_end')
            const moduleEvents = events.filter(event => event.type === 'test_module_end')
            const suiteEvents = events.filter(event => event.type === 'test_suite_end')
            const testEvents = events.filter(event => event.type === 'test')

            assert.strictEqual(sessionEvents.length, 1, `one test_session span\n${testOutput}`)
            assert.strictEqual(moduleEvents.length, 1, `one test_module span\n${testOutput}`)
            assert.ok(suiteEvents.length >= 1, `at least one test_suite span\n${testOutput}`)

            const passedTest = testEvents.find(event =>
              event.content.resource === 'cypress/e2e/basic-pass.cy.js.basic pass suite can pass'
            )
            assertObjectContains(passedTest?.content, {
              meta: {
                [TEST_STATUS]: 'pass',
                [TEST_FRAMEWORK]: 'cypress',
              },
            })
          }, 20000)

        const envVars = getCiVisAgentlessConfig(receiver.port)

        // Run Cypress *from* the subproject so its project root is the
        // ESM-configured directory; keeping the original `cwd` would pick
        // up the sandbox's own package.json (no `type: module`).
        childProcess = exec(
          path.join(cwd, 'node_modules/.bin/cypress') + ' run',
          {
            cwd: subprojectDir,
            env: {
              ...envVars,
              CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            },
          }
        )
        childProcess.stdout?.on('data', (d) => { testOutput += d })
        childProcess.stderr?.on('data', (d) => { testOutput += d })

        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])

        assert.strictEqual(exitCode, 0, `cypress process should exit successfully\n${testOutput}`)
      } finally {
        fs.rmSync(subprojectDir, { recursive: true, force: true })
      }
    })

    // Regression guard: when OTEL_TRACES_EXPORTER=otlp is set in the
    // environment (e.g. by an unrelated OpenTelemetry-instrumented shell),
    // the tracer must still ship Test Optimization spans to
    // /api/v2/citestcycle instead of silently replacing the Test
    // Optimization exporter with OtlpHttpTraceExporter and dropping all
    // test_session / test_module / test_suite / test spans.
    over10It('keeps Test Optimization exporter when OTEL_TRACES_EXPORTER=otlp is set', async () => {
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
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
        }, 20000)

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
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        }
      )

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

      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
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
        }, 60000)

      const envVars = getCiVisAgentlessConfig(receiver.port)
      const wrapperFilesBefore = getSupportWrappers()

      try {
        childProcess = exec(testCommand, {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        })

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
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
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
        }, 60000)

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

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
    })

    over10It('custom after:spec and after:run handlers are chained with dd-trace instrumentation', async () => {
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
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
        }, 60000)

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
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        }
      )
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
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSessionEvent = events.find(event => event.type === 'test_session_end')
          assert.ok(testSessionEvent)
          const testEvents = events.filter(event => event.type === 'test')
          assert.ok(testEvents.length > 0)
        }, 30000)

      const envVars = getCiVisAgentlessConfig(receiver.port)

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            CYPRESS_ENABLE_AFTER_RUN_CUSTOM: '1',
            CYPRESS_ENABLE_AFTER_SPEC_CUSTOM: '1',
            CYPRESS_ENABLE_MANUAL_PLUGIN: '1',
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        }
      )

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
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
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
        }, 60000)

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
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        }
      )

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
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
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
        }, 60000)

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
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            CYPRESS_ENABLE_AFTER_RUN_CUSTOM: '1',
            CYPRESS_ENABLE_AFTER_SPEC_CUSTOM: '1',
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        }
      )

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
    })

    over12It('reports correct source file and line for pre-compiled typescript test files', async function () {
      const envVars = getCiVisAgentlessConfig(receiver.port)

      try {
        cleanupPrecompiledSourceLineDist(cwd)

        // Compile the TypeScript spec to JS + source map so the plugin can resolve
        // the original TypeScript source file and line via the adjacent .js.map file.
        compilePrecompiledTypeScriptSpecs(cwd, envVars)

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const tsTestEvents = events.filter(event =>
              event.type === 'test' &&
              event.content.resource.includes('spec source line')
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
            assert.ok(
              itTestEvent.content.meta[TEST_SOURCE_FILE].endsWith('spec-source-line.cy.ts'),
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
            assert.ok(
              testTestEvent.content.meta[TEST_SOURCE_FILE].endsWith('spec-source-line.cy.ts'),
              `TEST_SOURCE_FILE should point to TypeScript source, got: ${testTestEvent.content.meta[TEST_SOURCE_FILE]}`
            )
          }, 60000)

        // Run Cypress with the pre-compiled JS spec (compiled from spec-source-line.cy.ts).
        // Cypress bundles the compiled JS via its own preprocessor; the plugin resolves
        // the original TypeScript source line by scanning the compiled JS and mapping
        // through the adjacent .js.map without needing any custom preprocessor.
        childProcess = exec(testCommand, {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            SPEC_PATTERN: 'cypress/e2e/dist/spec-source-line.cy.js',
          },
        })

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

    over12It('uses declaration scanning fallback when invocationDetails line is invalid', async function () {
      const envVars = getCiVisAgentlessConfig(receiver.port)

      try {
        cleanupPrecompiledSourceLineDist(cwd)

        compilePrecompiledTypeScriptSpecs(cwd, envVars)

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const fallbackEvent = events.find(event =>
              event.type === 'test' &&
              event.content.resource.includes('spec source line fallback branch') &&
              event.content.resource.includes('fallback branch literal title')
            )

            assert.ok(fallbackEvent, 'fallback-resolution test event should exist')
            assert.strictEqual(
              fallbackEvent.content.metrics[TEST_SOURCE_START],
              7,
              'should report TS source line resolved via declaration scanning fallback'
            )
            assert.ok(
              fallbackEvent.content.meta[TEST_SOURCE_FILE].endsWith('spec-source-line-fallback.cy.ts'),
              `TEST_SOURCE_FILE should point to TypeScript source, got: ${fallbackEvent.content.meta[TEST_SOURCE_FILE]}`
            )
          }, 60000)

        childProcess = exec(testCommand, {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            SPEC_PATTERN: 'cypress/e2e/dist/spec-source-line-fallback.cy.js',
          },
        })

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), receiverPromise])
        assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
      } finally {
        cleanupPrecompiledSourceLineDist(cwd)
      }
    })

    over12It('keeps original invocationDetails line when no declaration match is found', async function () {
      this.timeout(140000)
      const envVars = getCiVisAgentlessConfig(receiver.port)

      try {
        cleanupPrecompiledSourceLineDist(cwd)

        compilePrecompiledTypeScriptSpecs(cwd, envVars)

        const receiverPromise = receiver
          .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
            const events = payloads.flatMap(({ payload }) => payload.events)
            const noMatchEvent = events.find(event =>
              event.type === 'test' &&
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
            assert.ok(
              noMatchEvent.content.meta[TEST_SOURCE_FILE].endsWith('spec-source-line-no-match.cy.ts'),
              `TEST_SOURCE_FILE should point to TypeScript source, got: ${noMatchEvent.content.meta[TEST_SOURCE_FILE]}`
            )
          }, 60000)

        childProcess = exec(testCommand, {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            SPEC_PATTERN: 'cypress/e2e/dist/spec-source-line-no-match.cy.js',
          },
        })

        const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), receiverPromise])
        assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
      } finally {
        cleanupPrecompiledSourceLineDist(cwd)
      }
    })

    over12It('uses invocationDetails line directly for plain javascript specs without source maps', async function () {
      const envVars = getCiVisAgentlessConfig(receiver.port)

      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const jsInvocationDetailsEvent = events.find(event =>
            event.type === 'test' &&
            event.content.resource.includes('spec source line invocation details js') &&
            event.content.resource.includes('uses invocation details line as source line')
          )

          assert.ok(jsInvocationDetailsEvent, 'plain-js invocationDetails test event should exist')
          assert.strictEqual(
            jsInvocationDetailsEvent.content.metrics[TEST_SOURCE_START],
            243,
            'should keep invocationDetails line directly for plain JS specs without source maps'
          )
          assert.ok(
            jsInvocationDetailsEvent.content.meta[TEST_SOURCE_FILE].endsWith('spec-source-line-invocation.cy.js'),
            `TEST_SOURCE_FILE should point to JS source, got: ${
              jsInvocationDetailsEvent.content.meta[TEST_SOURCE_FILE]
            }`
          )
        }, 60000)

      childProcess = exec(testCommand, {
        cwd,
        env: {
          ...envVars,
          CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
          SPEC_PATTERN: 'cypress/e2e/spec-source-line-invocation.cy.js',
        },
      })

      const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), receiverPromise])
      assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
    })

    over12It('reports correct source file and line for typescript test files compiled by cypress', async function () {
      // Remove any pre-compiled dist files to ensure Cypress compiles the .ts file itself
      cleanupPrecompiledSourceLineDist(cwd)
      configureCypressTypeScriptCompilation(cwd)
      let testOutput = ''

      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
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
          assert.ok(
            itTestEvent.content.meta[TEST_SOURCE_FILE].endsWith('spec-source-line.cy.ts'),
            `TEST_SOURCE_FILE should point to TypeScript source, got: ${itTestEvent.content.meta[TEST_SOURCE_FILE]}`
          )

          // 'specify' with a template literal test name is defined at line 16.
          // Cypress's webpack preprocessor in headless mode does not resolve eval source maps
          // in Error.stack, so invocationDetails.line is the webpack bundle line rather than
          // the TS source line. Name-scanning cannot match template-literal names (the source
          // contains interpolated variables), so the exact TS line cannot be recovered in this
          // mode. We verify the event exists and that TEST_SOURCE_FILE points to the TS source.
          assert.ok(testTestEvent, 'specify() with template literal name should exist')
          assert.ok(
            testTestEvent.content.meta[TEST_SOURCE_FILE].endsWith('spec-source-line.cy.ts'),
            `TEST_SOURCE_FILE should point to TypeScript source, got: ${testTestEvent.content.meta[TEST_SOURCE_FILE]}`
          )
        }, 60000)

      const envVars = getCiVisAgentlessConfig(receiver.port)

      // Run Cypress directly with the TypeScript spec file — no manual compilation step.
      // Cypress compiles .cy.ts files on the fly via its own preprocessor/bundler.
      childProcess = exec(testCommand, {
        cwd,
        env: {
          ...envVars,
          CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
          SPEC_PATTERN: 'cypress/e2e/spec-source-line.cy.ts',
        },
      })
      childProcess.stdout?.on('data', chunk => {
        testOutput += chunk.toString()
      })
      childProcess.stderr?.on('data', chunk => {
        testOutput += chunk.toString()
      })

      const [[exitCode]] = await Promise.all([once(childProcess, 'exit'), receiverPromise])
      assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
    })

    it('tags session and children with _dd.ci.library_configuration_error when settings fails 4xx', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)

      receiver.setSettingsResponseCode(404)
      const eventsPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)
          const testSession = events.find(event => event.type === 'test_session_end').content
          assert.strictEqual(testSession.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR], 'true',
            'test_session_end should have _dd.ci.library_configuration_error tag')
          const testEvent = events.find(event => event.type === 'test')
          assert.ok(testEvent, 'should have test event')
          assert.strictEqual(testEvent.content.meta[DD_CI_LIBRARY_CONFIGURATION_ERROR], 'true',
            'test event should have _dd.ci.library_configuration_error tag (from getSessionRequestErrorTags)')
        })

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            SPEC_PATTERN: 'cypress/e2e/spec.cy.js',
          },
        }
      )

      await Promise.all([eventsPromise, once(childProcess, 'exit')])
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
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
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
      const receiverPromise = receiver
        .gatherPayloadsMaxTimeout(({ url }) => url.endsWith('/api/v2/citestcycle'), payloads => {
          const ciVisPayloads = payloads.filter(({ payload }) => payload.metadata?.test)
          const ciVisMetadataDicts = ciVisPayloads.flatMap(({ payload }) => payload.metadata)

          ciVisMetadataDicts.forEach(metadata => {
            for (const testLevel of TEST_LEVEL_EVENT_TYPES) {
              assert.strictEqual(metadata[testLevel][TEST_SESSION_NAME], 'my-test-session')
            }
          })
          const events = ciVisPayloads.flatMap(({ payload }) => payload.events)

          const testSessionEvent = events.find(event => event.type === 'test_session_end')
          const testModuleEvent = events.find(event => event.type === 'test_module_end')
          const testSuiteEvents = events.filter(event => event.type === 'test_suite_end')
          const testEvents = events.filter(event => event.type === 'test')

          const { content: testSessionEventContent } = testSessionEvent
          const { content: testModuleEventContent } = testModuleEvent

          assert.ok(testSessionEventContent.test_session_id)
          assert.ok(testSessionEventContent.meta[TEST_COMMAND])
          assert.ok(testSessionEventContent.meta[TEST_TOOLCHAIN])
          assert.strictEqual(testSessionEventContent.resource.startsWith('test_session.'), true)
          assert.strictEqual(testSessionEventContent.meta[TEST_STATUS], 'fail')

          assert.ok(testModuleEventContent.test_session_id)
          assert.ok(testModuleEventContent.test_module_id)
          assert.ok(testModuleEventContent.meta[TEST_COMMAND])
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
            assert.ok(meta[TEST_COMMAND])
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
            assert.ok(meta[TEST_COMMAND])
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
        }, 25000)

      const envVars = getCiVisEvpProxyConfig(receiver.port)

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            DD_TAGS: 'test.customtag:customvalue,test.customtag2:customvalue2',
            DD_TEST_SESSION_NAME: 'my-test-session',
            DD_SERVICE: undefined,
            SPEC_PATTERN: 'cypress/e2e/{spec,other,hook-describe-error,hook-test-error}.cy.js',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])
    })

    it('can report code coverage if it is available', async () => {
      const envVars = getCiVisAgentlessConfig(receiver.port)

      const receiverPromise = receiver.gatherPayloadsMaxTimeout(({ url }) => url === '/api/v2/citestcov', payloads => {
        const [{ payload: coveragePayloads }] = payloads

        const coverages = coveragePayloads.map(coverage => coverage.content)
          .flatMap(content => content.coverages)

        coverages.forEach(coverage => {
          assert.ok(Object.hasOwn(coverage, 'test_session_id'))
          assert.ok(Object.hasOwn(coverage, 'test_suite_id'))
          assert.ok(Object.hasOwn(coverage, 'span_id'))
          assert.ok(Object.hasOwn(coverage, 'files'))
        })

        const fileNames = coverages
          .flatMap(coverageAttachment => coverageAttachment.files)
          .map(file => file.filename)

        assertObjectContains(fileNames, Object.keys(coverageFixture))
      }, 25000)

      childProcess = exec(
        testCommand,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: `http://localhost:${webAppPort}`,
            SPEC_PATTERN: 'cypress/e2e/spec.cy.js',
          },
        }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])
    })
  })
})
