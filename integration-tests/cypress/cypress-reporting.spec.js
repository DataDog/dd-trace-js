'use strict'

const assert = require('node:assert/strict')
const { exec } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
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
  TEST_FRAMEWORK,
  TEST_FRAMEWORK_VERSION,
  TEST_TYPE,
  TEST_SOURCE_FILE,
  TEST_SOURCE_START,
  TEST_SUITE,
  TEST_CODE_OWNERS,
  TEST_NAME,
} = require('../../packages/dd-trace/src/plugins/util/test')
const { ERROR_MESSAGE, ERROR_TYPE, COMPONENT } = require('../../packages/dd-trace/src/constants')
const { DD_MAJOR, NODE_MAJOR } = require('../../version')

const requestedVersion = process.env.CYPRESS_VERSION
const oldestVersion = DD_MAJOR >= 6 ? '12.0.0' : '6.7.0'
const version = requestedVersion === 'oldest' ? oldestVersion : requestedVersion
const hookFile = 'dd-trace/loader-hook.mjs'

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

    it('instruments tests with the APM protocol (old agents)', async () => {
      receiver.setInfoResponse({ endpoints: [] })

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
            CYPRESS_BASE_URL: webAppBaseUrl,
            SPEC_PATTERN: specToRun,
          },
        }
      )

      const receiverPromise = receiver
        .gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url === '/v0.4/traces',
          (payloads) => {
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
          }, { hardTimeout: 60000 })

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])
    })

    if (DD_MAJOR < 6 && version !== 'latest' && semver.lt(version, '12.0.0')) {
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
              CYPRESS_BASE_URL: webAppBaseUrl,
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
          /WARNING: dd-trace support for Cypress<12.0.0 is deprecated/
        )
      })
    }

    it('creates cypress.step spans for each command', async () => {
      const envVars = getCiVisEvpProxyConfig(receiver.port)
      const specToRun = 'cypress/e2e/commands.cy.js'

      const command = version === '6.7.0'
        ? `./node_modules/.bin/cypress run --config-file cypress-config.json --spec "${specToRun}"`
        : testCommand

      childProcess = exec(
        command,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: webAppBaseUrl,
            SPEC_PATTERN: specToRun,
          },
        }
      )

      const receiverPromise = receiver.gatherPayloadsUntilChildExit(
        childProcess,
        ({ url }) => url.endsWith('/api/v2/citestcycle'),
        (payloads) => {
          const events = payloads.flatMap(({ payload }) => payload.events)

          const passTestEvent = events.find(
            event => event.type === 'test' && event.content.resource.includes('runs well-known commands')
          )
          const failTestEvent = events.find(
            event => event.type === 'test' && event.content.resource.includes('fails on a step')
          )
          assert.ok(passTestEvent, 'passing cypress.test event exists')
          assert.ok(failTestEvent, 'failing cypress.test event exists')

          const stepEvents = events.filter(event => event.type === 'span' && event.content.name === 'cypress.step')
          assert.ok(stepEvents.length > 0, 'cypress.step spans exist')

          const visitStep = stepEvents.find(event => event.content.meta['cypress.command'] === 'visit')
          assert.ok(visitStep, 'visit step span exists')
          assertObjectContains(visitStep.content, {
            name: 'cypress.step',
            resource: 'visit',
            meta: { 'cypress.command': 'visit' },
          })

          const getStep = stepEvents.find(event => event.content.meta['cypress.command'] === 'get')
          assert.ok(getStep, 'get step span exists')
          assertObjectContains(getStep.content, {
            name: 'cypress.step',
            resource: 'get',
            meta: { 'cypress.command': 'get' },
          })

          const containsStep = stepEvents.find(event => event.content.meta['cypress.command'] === 'contains')
          assert.ok(containsStep, 'contains step span exists')

          for (const stepEvent of stepEvents) {
            const matchesPass = stepEvent.content.trace_id.toString() === passTestEvent.content.trace_id.toString()
            const matchesFail = stepEvent.content.trace_id.toString() === failTestEvent.content.trace_id.toString()
            assert.ok(matchesPass || matchesFail, 'step span trace_id matches one of the test trace_ids')
          }

          const failedStep = stepEvents.find(event =>
            event.content.trace_id.toString() === failTestEvent.content.trace_id.toString() &&
            event.content.meta[ERROR_MESSAGE]
          )
          assert.ok(failedStep, 'failed step span with error exists')
          assert.ok(failedStep.content.meta[ERROR_MESSAGE], 'failed step has error message')
          assert.ok(failedStep.content.meta[ERROR_TYPE], 'failed step has error type')
        },
        { hardTimeout: 60000 }
      )

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])
    })

    // These tests require Cypress >=10 features (defineConfig, setupNodeEvents)
    const over10It = (version !== '6.7.0') ? it : it.skip
    // Cypress <14 shipped an older ts-node ESM loader that doesn't implement the
    // current Node.js ESM hooks chain (ERR_LOADER_CHAIN_INCOMPLETE), so TS configs
    // under `"type": "module"` can't be loaded at all, regardless of dd-trace.
    const over14It = (version === 'latest' || semver.gte(version, '14.0.0')) ? it : it.skip
    over10It('is backwards compatible with the old manual plugin approach', async () => {
      receiver.setInfoResponse({ endpoints: [] })

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
            CYPRESS_BASE_URL: webAppBaseUrl,
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        }
      )

      const receiverPromise = receiver
        .gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url === '/v0.4/traces',
          (payloads) => {
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
          }, { hardTimeout: 60000 })

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])
    })

    over10It('reports tests with old manual plugin approach without NODE_OPTIONS', async () => {
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
            CYPRESS_BASE_URL: webAppBaseUrl,
            SPEC_PATTERN: 'cypress/e2e/basic-*.js',
          },
        }
      )

      const receiverPromise = receiver
        .gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.endsWith('/api/v2/citestcycle'),
          (payloads) => {
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
          }, { hardTimeout: 60000 })

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])
    })

    over10It('reports tests when using cypress.config.mjs with NODE_OPTIONS', async () => {
      let testOutput = ''
      const envVars = getCiVisAgentlessConfig(receiver.port)

      childProcess = exec(
        './node_modules/.bin/cypress run --config-file cypress-auto-esm.config.mjs',
        {
          cwd,
          env: {
            ...envVars,
            NODE_OPTIONS: '-r dd-trace/ci/init',
            CYPRESS_BASE_URL: webAppBaseUrl,
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        }
      )

      childProcess.stdout?.on('data', (d) => {
        testOutput += d.toString()
        process.stdout.write(d)
      })
      childProcess.stderr?.on('data', (d) => {
        testOutput += d.toString()
        process.stderr.write(d)
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
          }, { hardTimeout: 20000 })
      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.strictEqual(exitCode, 0, `cypress process should exit successfully\n${testOutput}`)
    })

    over10It('reports tests when cypress.run is called twice (multi-run state reset)', async () => {
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
          }, { hardTimeout: 60000 })

      const [[exitCode]] = await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])

      assert.strictEqual(exitCode, 0, 'cypress process should exit successfully')
    })

    over10It(
      'reports tests with a plain-object config when dd-trace is manually configured',
      async () => {
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
            }, { hardTimeout: 20000 })

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
          const envVars = getCiVisAgentlessConfig(receiver.port)

          childProcess = exec(
            './node_modules/.bin/cypress run',
            {
              cwd,
              env: {
                ...envVars,
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
              }, { hardTimeout: 20000 })

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
      const envVars = getCiVisAgentlessConfig(receiver.port)

      childProcess = exec(
        './node_modules/.bin/cypress run --config-file cypress-typescript.config.ts',
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: webAppBaseUrl,
            SPEC_PATTERN: 'cypress/e2e/basic-pass.js',
          },
        }
      )

      childProcess.stdout?.on('data', chunk => {
        testOutput += chunk.toString()
        process.stdout.write(chunk)
      })
      childProcess.stderr?.on('data', chunk => {
        testOutput += chunk.toString()
        process.stderr.write(chunk)
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
            }, `got events: ${JSON.stringify(events.map(event => ({
            resource: event.content.resource,
            sourceFile: event.content.meta?.[TEST_SOURCE_FILE],
            status: event.content.meta?.[TEST_STATUS],
            framework: event.content.meta?.[TEST_FRAMEWORK],
            error: event.content.meta?.[ERROR_MESSAGE],
          })), null, 2)}\nCypress output:\n${testOutput}`)
          }, { hardTimeout: 20000 })
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
              CYPRESS_BASE_URL: webAppBaseUrl,
            },
          }
        )

        childProcess.stdout?.on('data', (d) => {
          testOutput += d.toString()
          process.stdout.write(d)
        })
        childProcess.stderr?.on('data', (d) => {
          testOutput += d.toString()
          process.stderr.write(d)
        })

        const receiverPromise = receiver
          .gatherPayloadsUntilChildExit(
            childProcess,
            ({ url }) => url.endsWith('/api/v2/citestcycle'),
            (payloads) => {
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
            }, { hardTimeout: 20000 })
        const [[exitCode]] = await Promise.all([
          once(childProcess, 'exit'),
          receiverPromise,
        ])

        assert.strictEqual(exitCode, 0, `cypress process should exit successfully\n${testOutput}`)
      } finally {
        fs.rmSync(subprojectDir, { recursive: true, force: true })
      }
    })

    it('uploads failure screenshots and the spec video to the v2 media endpoint', async function () {
      const envVars = getCiVisAgentlessConfig(receiver.port)
      const specToRun = 'cypress/e2e/basic-fail.js'
      // Failure media is disabled by default in the sandbox config, so enable both the
      // failure screenshot and the per-spec video for this run.
      const command = version === '6.7.0'
        ? './node_modules/.bin/cypress run ' +
          '--config-file cypress-config.json ' +
          `--config screenshotOnRunFailure=true,video=true --spec "${specToRun}"`
        : `${testCommand} --config screenshotOnRunFailure=true,video=true`
      let testOutput = ''

      childProcess = exec(
        command,
        {
          cwd,
          env: {
            ...envVars,
            CYPRESS_BASE_URL: webAppBaseUrl,
            SPEC_PATTERN: specToRun,
          },
        }
      )
      childProcess.stdout?.on('data', (d) => { testOutput += d.toString() })
      childProcess.stderr?.on('data', (d) => { testOutput += d.toString() })

      const receiverPromise = receiver
        .gatherPayloadsUntilChildExit(
          childProcess,
          ({ url }) => url.startsWith('/api/unstable/ci/test-runs/') || url.endsWith('/api/v2/citestcycle'),
          (payloads) => {
            const mediaPayloads = payloads.filter(({ url }) => url.startsWith('/api/unstable/ci/test-runs/'))
            const failedTest = payloads
              .filter(({ url }) => url.endsWith('/api/v2/citestcycle'))
              .flatMap(({ payload }) => payload.events)
              .filter(event => event.type === 'test')
              .find(event => event.content.resource === 'cypress/e2e/basic-fail.js.basic fail suite can fail')

            assert.ok(failedTest, `failed test event should be reported\n${testOutput}`)
            const expectedTraceId = failedTest.content.trace_id.toString()

            const expectedUrl = `/api/unstable/ci/test-runs/${expectedTraceId}/media`
            const screenshotPayload = mediaPayloads.find(({ media }) => media.contentType === 'image/png')
            const videoPayload = mediaPayloads.find(({ media }) => media.contentType === 'video/mp4')

            assert.ok(screenshotPayload, `a screenshot should be uploaded to the v2 media endpoint\n${testOutput}`)
            assert.ok(videoPayload, `the spec video should be uploaded to the v2 media endpoint\n${testOutput}`)

            for (const mediaPayload of [screenshotPayload, videoPayload]) {
              assert.strictEqual(mediaPayload.url, expectedUrl)
              assert.strictEqual(mediaPayload.media.traceId, expectedTraceId)
              assert.strictEqual(mediaPayload.headers['dd-api-key'], '1')

              // v2 idempotency key is `<traceId>:<filename>`, reused on retry so the
              // media service overwrites instead of duplicating the stored object.
              const idempotencyKey = mediaPayload.headers['x-dd-idempotency-key']
              assert.ok(idempotencyKey, 'media upload should send an X-Dd-Idempotency-Key header')
              assert.strictEqual(mediaPayload.media.idempotencyKey, idempotencyKey)
              assert.ok(
                idempotencyKey.startsWith(`${expectedTraceId}:`),
                `idempotency key ${idempotencyKey} should start with the trace id`
              )

              // Capture time (epoch ms) is part of the stored object key and must be a positive integer.
              const capturedAtHeader = mediaPayload.headers['x-dd-media-captured-at']
              const capturedAt = Number(capturedAtHeader)
              assert.ok(
                Number.isInteger(capturedAt) && capturedAt > 0,
                `X-Dd-Media-Captured-At should be a positive integer, got ${capturedAtHeader}`
              )

              // The v1 PoC sent this routing header; v2 must not.
              assert.ok(
                !('test-drive-test-failure-media-bucket' in mediaPayload.headers),
                'v2 must not send the v1 test-drive-test-failure-media-bucket header'
              )
            }

            // The screenshot body is a real PNG (magic bytes), not an empty/placeholder upload.
            assert.deepStrictEqual(
              [...screenshotPayload.media.content.subarray(0, 8)],
              [137, 80, 78, 71, 13, 10, 26, 10]
            )
          }, { hardTimeout: 60000 })
        .catch((error) => {
          error.message += `\nCypress output:\n${testOutput}`
          throw error
        })

      await Promise.all([
        once(childProcess, 'exit'),
        receiverPromise,
      ])
    })
  })
})
