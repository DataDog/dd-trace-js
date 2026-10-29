'use strict'

const assert = require('node:assert/strict')
const { exec, execFileSync } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { format } = require('node:util')
const { runInNewContext } = require('node:vm')

const proxyquire = require('proxyquire').noPreserveCache()
const sinon = require('sinon')
const {
  sandboxCwd,
  useSandbox,
  getCiVisAgentlessConfig,
  assertObjectContains,
  stopCiVisTestEnv,
  warmCypressBinary,
} = require('../helpers')
const { FakeCiVisIntake } = require('../ci-visibility-intake')
const { startWebAppServer, stopWebAppServer } = require('../ci-visibility/web-app-server')
const {
  TEST_STATUS,
  TEST_FINAL_STATUS,
  TEST_IS_RETRY,
  TEST_RETRY_REASON,
  TEST_RETRY_REASON_TYPES,
  TEST_HAS_FAILED_ALL_RETRIES,
  TEST_FRAMEWORK,
  TEST_SESSION_EMPTY_REASON,
  TEST_SKIP_REASON,
  TEST_FAILURE_SCREENSHOT_UPLOADED,
  TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR,
  TEST_FAILURE_VIDEO_UPLOADED,
  TEST_FAILURE_VIDEO_UPLOAD_ERROR,
  TEST_FAILURE_VIDEO_SCOPE,
} = require('../../packages/dd-trace/src/plugins/util/test')
const {
  VIDEO_UPLOAD_RESULT_UPLOADED,
  VIDEO_UPLOAD_SCOPE_TEST_SUITE,
} = require('../../packages/dd-trace/src/ci-visibility/test-video')
const { ERROR_MESSAGE } = require('../../packages/dd-trace/src/constants')
const { DD_MAJOR, NODE_MAJOR } = require('../../version')
const { getCypressDependencies } = require('./dependencies')

const requestedVersion = process.env.CYPRESS_VERSION
const oldestVersion = DD_MAJOR >= 6 ? '12.0.0' : '6.7.0'
const version = requestedVersion === 'oldest' ? oldestVersion : requestedVersion
const cypressVersionsSupportingNode18 = DD_MAJOR === 5
  ? ['10.2.0', '12.0.0', '14.5.4']
  : ['12.0.0', '14.5.4']

function getGeneratedSupportFiles (directory) {
  return fs.readdirSync(directory)
    .filter(filename => filename.startsWith('dd-cypress-support-'))
    .sort()
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

    // These CLI fixtures exercise lifecycle behavior, not module loading. Running them in the ESM cell
    // would repeat the same .js configs; dedicated tests below cover .mjs config loading and hook chaining.
    if (type === 'commonJS') {
      describe('late manual finalization', () => {
        /**
         * Run the fixture and check the event hierarchy shared by all recovery scenarios.
         * @param {{ afterSpec?: 'missing'|'partial'|'forwarded', screenshots?: boolean, video?: boolean }} options
         */
        async function runLateManual ({ afterSpec = 'missing', screenshots = false, video = false }) {
          let output = ''
          const command = './node_modules/.bin/cypress run --config-file ci-visibility/cypress-late-manual/config.js'
          childProcess = exec(command, {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              NODE_OPTIONS: '',
              DD_CYPRESS_AFTER_SPEC_MODE: afterSpec,
              DD_TEST_FAILURE_SCREENSHOTS_ENABLED: String(screenshots),
              DD_TEST_FAILURE_VIDEOS_ENABLED: String(video),
            },
          })
          childProcess.stdout?.on('data', chunk => { output += chunk.toString() })
          childProcess.stderr?.on('data', chunk => { output += chunk.toString() })
          let messages
          const [[exitCode]] = await Promise.all([
            once(childProcess, 'close'),
            receiver.gatherPayloadsUntilChildExit(
              childProcess,
              ({ url, media }) => url.endsWith('/api/v2/citestcycle') || !!media,
              payloads => { messages = payloads }
            ),
          ])
          const events = messages.flatMap(({ payload }) => payload?.events ?? [])
          const uploads = messages.filter(({ media }) => media).map(({ media }) => media)
          assert.strictEqual(exitCode, 1, output)
          assert.match(output, /synthetic late hook failure/)
          const tests = events.filter(event => event.type === 'test').map(({ content }) => content)
          const suites = events.filter(event => event.type === 'test_suite_end').map(({ content }) => content)
          assert.deepStrictEqual(tests.map(({ meta }) => ({
            name: meta['test.name'],
            status: meta[TEST_STATUS],
          })).sort((a, b) => a.name.localeCompare(b.name)), [
            { name: 'first suite is skipped', status: 'skip' },
            { name: 'first suite passes', status: 'pass' },
            { name: 'second suite fails in a late hook', status: 'fail' },
          ], output)
          assert.strictEqual(suites.length, 2)
          assert.strictEqual(new Set(suites.map(suite => String(suite.test_suite_id))).size, 2)
          for (const test of tests) {
            const suite = suites.find(suite => suite.meta['test.suite'] === test.meta['test.suite'])
            assert.ok(suite)
            assert.strictEqual(String(test.test_suite_id), String(suite.test_suite_id))
            // Recovery at after:run must keep tests inside their original suite, not move them to run end.
            // Compare at Cypress run-result precision (milliseconds).
            const testStart = Math.round(Number(test.start) / 1e6)
            const testEnd = Math.round((Number(test.start) + Number(test.duration)) / 1e6)
            const suiteStart = Math.round(Number(suite.start) / 1e6)
            const suiteEnd = Math.round((Number(suite.start) + Number(suite.duration)) / 1e6)
            assert.ok(testStart >= suiteStart && testEnd <= suiteEnd,
              `${test.meta['test.name']}: ${testStart}-${testEnd} must be within suite ${suiteStart}-${suiteEnd}`)
            if (test.meta[TEST_STATUS] === 'skip' && afterSpec === 'missing') {
              assert.strictEqual(Number(test.duration), 0)
              assert.strictEqual(testStart, suiteEnd)
            }
          }
          const firstSuite = suites.find(suite => suite.meta['test.suite'].endsWith('first.cy.js'))
          const secondSuite = suites.find(suite => suite.meta['test.suite'].endsWith('second.cy.js'))
          assert.strictEqual(firstSuite.meta[TEST_STATUS], 'pass')
          assert.strictEqual(secondSuite.meta[TEST_STATUS], 'fail')
          assert.ok(Number(firstSuite.start) + Number(firstSuite.duration) < Number(secondSuite.start),
            `recovered suite duration must not include later specs\n${output}`)
          const failedTest = tests.find(test => test.meta[TEST_STATUS] === 'fail')
          assert.match(failedTest.meta[ERROR_MESSAGE], /synthetic late hook failure/)
          for (const type of ['test_session_end', 'test_module_end']) {
            assert.deepStrictEqual(events.filter(event => event.type === type)
              .map(({ content }) => content.meta[TEST_STATUS]), ['fail'], type)
          }
          return { failedTest, failedSuite: secondSuite, uploads }
        }

        over10It('recovers both specs with screenshots but no video when after:spec is missing', async () => {
          receiver.setMediaResponseDelay(100)
          const { failedTest, failedSuite, uploads } = await runLateManual({ screenshots: true })

          assert.strictEqual(failedTest.meta[TEST_FAILURE_SCREENSHOT_UPLOADED], 'true')
          assert.strictEqual(failedTest.meta[TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR], undefined)
          assert.strictEqual(failedTest.meta[TEST_FAILURE_VIDEO_UPLOADED], undefined)
          assert.strictEqual(failedSuite.meta[TEST_FAILURE_VIDEO_UPLOADED], undefined)
          assert.deepStrictEqual(uploads.map(media => media.contentType), ['image/png'])
          assert.strictEqual(uploads[0].traceId, String(failedTest.trace_id))
        })

        over10It('recovers the second spec with media when after:spec handles only the first', async () => {
          receiver.setMediaResponseDelay(100)
          const { failedTest, failedSuite, uploads } = await runLateManual({
            afterSpec: 'partial', screenshots: true, video: true,
          })

          assert.strictEqual(failedTest.meta[TEST_FAILURE_SCREENSHOT_UPLOADED], 'true')
          assert.strictEqual(failedTest.meta[TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR], undefined)
          assert.strictEqual(failedTest.meta[TEST_FAILURE_VIDEO_UPLOADED], 'true')
          assert.strictEqual(failedSuite.meta[TEST_FAILURE_VIDEO_UPLOADED], 'true')
          assert.deepStrictEqual(uploads.map(media => media.contentType).sort(), ['image/png', 'video/mp4'])
          const screenshot = uploads.find(media => media.contentType === 'image/png')
          const video = uploads.find(media => media.contentType === 'video/mp4')
          assert.strictEqual(screenshot.traceId, String(failedTest.trace_id))
          assert.strictEqual(video.testSuiteId, String(failedSuite.test_suite_id))
        })

        over10It('does not duplicate specs already finalized by after:spec', async () => {
          await runLateManual({ afterSpec: 'forwarded' })
        })
      })

      for (const { manual, reject } of [
        { manual: false, reject: false },
        { manual: true, reject: false },
        { manual: false, reject: true },
        { manual: true, reject: true },
      ]) {
        over10It(`preserves before:run handlers (manual=${manual}, reject=${reject})`, async () => {
          let output = ''
          const events = []
          receiver.on('message', ({ url, payload }) => {
            if (url.endsWith('/api/v2/citestcycle')) events.push(...payload.events)
          })
          childProcess = exec('./node_modules/.bin/cypress run --config-file cypress-before-run.config.js', {
            cwd,
            env: {
              ...getCiVisAgentlessConfig(receiver.port),
              CYPRESS_MANUAL_PLUGIN: manual ? '1' : '',
              CYPRESS_REJECT_BEFORE_RUN: reject ? '1' : '',
            },
          })
          childProcess.stdout?.on('data', chunk => { output += chunk.toString() })
          childProcess.stderr?.on('data', chunk => { output += chunk.toString() })
          const [exitCode] = await once(childProcess, 'close')
          const tests = events.filter(event => event.type === 'test')
          if (reject) {
            assert.strictEqual(events.length, 0)
            assert.notStrictEqual(exitCode, 0)
            assert.match(output, /custom before:run failed/)
          } else {
            assert.strictEqual(exitCode, 0, output)
            assert.deepStrictEqual(tests.map(({ content }) => content.meta[TEST_STATUS]), ['pass'], output)
          }
        })
      }
    }

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

    for (const { testName, rejectionVariable, expectedError, enableFailureVideo } of [
      {
        testName: 'reports a failed test session trace when after:spec prevents Cypress after:run',
        rejectionVariable: 'CYPRESS_REJECT_AFTER_SPEC',
        expectedError: /custom after:spec failed/,
        enableFailureVideo: true,
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
              CYPRESS_ENABLE_FAILURE_VIDEOS: enableFailureVideo ? 'true' : undefined,
              DD_TEST_FAILURE_VIDEOS_ENABLED: enableFailureVideo ? 'true' : undefined,
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
            if (enableFailureVideo) {
              const suiteEvent = events.find(event => event.type === 'test_suite_end')
              for (const event of [testEvent, suiteEvent]) {
                assert.strictEqual(event.content.meta[TEST_FAILURE_VIDEO_UPLOAD_ERROR], 'true')
                assert.strictEqual(event.content.meta[TEST_FAILURE_VIDEO_UPLOADED], undefined)
                assert.strictEqual(event.content.meta[TEST_FAILURE_VIDEO_SCOPE], VIDEO_UPLOAD_SCOPE_TEST_SUITE)
              }
            }
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
      configuredCypressRetries: cypressPlugin.configuredCypressRetries,
      tracer: cypressPlugin.tracer,
      finishedTestsByFile: cypressPlugin.finishedTestsByFile,
      hasTestsReported: cypressPlugin.hasTestsReported,
      testSuiteStatuses: cypressPlugin.testSuiteStatuses,
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
      cypressPlugin.configuredCypressRetries = originalState.configuredCypressRetries
      cypressPlugin.tracer = originalState.tracer
      cypressPlugin.finishedTestsByFile = originalState.finishedTestsByFile
      cypressPlugin.hasTestsReported = originalState.hasTestsReported
      cypressPlugin.testSuiteStatuses = originalState.testSuiteStatuses
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

    function prepareRunFinalization () {
      const createSpan = () => {
        const tags = {}
        return {
          tags,
          context: () => ({
            _trace: { started: [] },
            toTraceId: () => '123',
            toSpanId: () => '456',
            getTag: name => tags[name],
            getTags: () => tags,
          }),
          finish: sinon.stub(),
          setTag: sinon.stub().callsFake((name, value) => { tags[name] = value }),
        }
      }
      const testSessionSpan = createSpan()
      const testModuleSpan = createSpan()

      cypressPlugin.resetRunState()
      cypressPlugin._isInit = true
      cypressPlugin.testSessionSpan = testSessionSpan
      cypressPlugin.testModuleSpan = testModuleSpan
      cypressPlugin.tracer = {
        startSpan: sinon.stub().callsFake(createSpan),
        _tracer: {
          _exporter: {
            flush: callback => callback(),
          },
        },
      }
      sinon.stub(cypressPlugin, 'applySkippedCoverageToTestSessionCoverage').returns(false)
      sinon.stub(cypressPlugin, 'getTestCodeCoverageLinesTotal').returns(undefined)
      sinon.stub(cypressPlugin, 'reportTestSessionCoverage')
      sinon.stub(cypressPlugin, 'ciVisEvent')

      return { testModuleSpan, testSessionSpan, createSpan }
    }

    for (const uploadFails of [false, true]) {
      it(`waits for recovered screenshot-only spans before closing the run (uploadFails=${uploadFails})`, async () => {
        const { testSessionSpan, createSpan } = prepareRunFinalization()
        const testSpan = createSpan()
        testSpan.finish.callsFake(() => { testSpan._duration = 0 })
        const context = testSessionSpan.context()
        context._trace.started.push(testSpan)
        sinon.stub(testSessionSpan, 'context').returns(context)
        const spec = { relative: 'cypress/e2e/failure.cy.js' }
        cypressPlugin.getTestSuiteSpan({ testSuite: spec.relative })
        cypressPlugin.finishedTestsByFile[spec.relative] = [{
          testName: 'fails', testStatus: 'fail', testSpan, finishTime: 900,
        }]
        let completeUpload
        const exporter = cypressPlugin.tracer._tracer._exporter
        exporter.canUploadTestScreenshots = () => true
        exporter.uploadTestScreenshot = sinon.stub().callsFake((options, callback) => { completeUpload = callback })
        const flush = sinon.spy(exporter, 'flush')
        const afterRunPromise = cypressPlugin.afterRun({
          totalFailed: 1,
          totalTests: 1,
          runs: [{
            spec,
            stats: { failures: 1, tests: 1, endedAt: new Date(1000).toISOString() },
            tests: [{
              title: ['fails'],
              state: 'failed',
              attempts: [{ state: 'failed', screenshots: [{ path: '/tmp/failure.png', testFailure: true }] }],
            }],
          }],
        })
        try {
          sinon.assert.calledOnce(exporter.uploadTestScreenshot)
          sinon.assert.notCalled(testSpan.finish)
          sinon.assert.notCalled(testSessionSpan.finish)
          sinon.assert.notCalled(flush)
        } finally {
          completeUpload(uploadFails ? new Error('synthetic upload failure') : undefined)
          await afterRunPromise
        }
        sinon.assert.calledOnceWithExactly(testSpan.finish, 900)
        assert.strictEqual(testSpan.tags[TEST_FAILURE_SCREENSHOT_UPLOADED], uploadFails ? undefined : 'true')
        assert.strictEqual(testSpan.tags[TEST_FAILURE_SCREENSHOT_UPLOAD_ERROR], uploadFails ? 'true' : undefined)
        sinon.assert.calledOnce(testSessionSpan.finish)
        assert.strictEqual(testSessionSpan.tags[TEST_STATUS], 'fail')
      })
    }

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

    for (const [summary, status, reason] of [
      [{ totalTests: 2, totalPassed: 0, totalFailed: 0, totalPending: 2, totalSkipped: 0 },
        'skip', 'all_tests_skipped'],
      [{ totalTests: 2, totalPassed: 0, totalFailed: 0, totalPending: 1, totalSkipped: 1 },
        'skip', 'all_tests_skipped'],
      [{ totalTests: 2, totalPassed: 1, totalFailed: 0, totalPending: 1, totalSkipped: 0 },
        'pass', undefined],
      [{ totalTests: 0, totalPassed: 0, totalFailed: 0, totalPending: 0, totalSkipped: 0 },
        'skip', 'zero_tests'],
    ]) {
      it(`reports zero-execution sessions from Cypress statistics: ${JSON.stringify(summary)}`, async () => {
        const { testModuleSpan, testSessionSpan } = prepareRunFinalization()
        await cypressPlugin.afterRun(summary)
        for (const span of [testSessionSpan, testModuleSpan]) {
          assert.strictEqual(span.tags[TEST_STATUS], status)
          assert.strictEqual(span.tags[TEST_SESSION_EMPTY_REASON], reason)
          assert.strictEqual(span.tags[TEST_SKIP_REASON], reason === 'all_tests_skipped'
            ? 'All tests were skipped'
            : reason === 'zero_tests' ? 'No tests were detected' : undefined)
        }
      })
    }

    it('preserves a failed Cypress run that reports zero tests', async () => {
      const { testModuleSpan, testSessionSpan } = prepareRunFinalization()

      await cypressPlugin.afterRun({ totalFailed: 1, totalSkipped: 0, totalTests: 0 })

      for (const span of [testSessionSpan, testModuleSpan]) {
        assert.strictEqual(span.tags[TEST_STATUS], 'fail')
        assert.strictEqual(span.tags[TEST_SKIP_REASON], undefined)
        assert.strictEqual(span.tags[TEST_SESSION_EMPTY_REASON], undefined)
      }
    })

    it('preserves a Cypress failed-run result that reports no tests', async () => {
      const { testModuleSpan, testSessionSpan } = prepareRunFinalization()

      await cypressPlugin.afterRun({ status: 'failed', failures: 1, message: 'Cypress failed to run' })

      for (const span of [testSessionSpan, testModuleSpan]) {
        assert.strictEqual(span.tags[TEST_STATUS], 'fail')
        assert.strictEqual(span.tags[TEST_SKIP_REASON], undefined)
        assert.strictEqual(span.tags[TEST_SESSION_EMPTY_REASON], undefined)
      }
    })

    it('marks an interactive Cypress run with no statistics or tests as empty', async () => {
      const { testModuleSpan, testSessionSpan } = prepareRunFinalization()

      await cypressPlugin.afterRun()

      for (const span of [testSessionSpan, testModuleSpan]) {
        assert.strictEqual(span.tags[TEST_STATUS], 'skip')
        assert.strictEqual(span.tags[TEST_SKIP_REASON], 'No tests were detected')
        assert.strictEqual(span.tags[TEST_SESSION_EMPTY_REASON], 'zero_tests')
      }
    })

    it('does not mark an interactive Cypress run as empty after receiving a test', async () => {
      const { testModuleSpan, testSessionSpan } = prepareRunFinalization()
      cypressPlugin.testsToSkip = [{ name: 'test name', suite: 'test suite' }]

      cypressPlugin.getTasks()['dd:beforeEach']({
        testId: 'test-id',
        testName: 'test name',
        testSuite: 'test suite',
      })
      await cypressPlugin.afterRun()

      for (const span of [testSessionSpan, testModuleSpan]) {
        assert.strictEqual(span.tags[TEST_STATUS], 'pass')
        assert.strictEqual(span.tags[TEST_SKIP_REASON], undefined)
        assert.strictEqual(span.tags[TEST_SESSION_EMPTY_REASON], undefined)
      }
    })

    it('preserves a failed interactive Cypress run without summary statistics', async () => {
      const { testModuleSpan, testSessionSpan } = prepareRunFinalization()
      cypressPlugin.hasTestsReported = true
      cypressPlugin.testSuiteStatuses.add('fail')

      await cypressPlugin.afterRun()

      for (const span of [testSessionSpan, testModuleSpan]) {
        assert.strictEqual(span.tags[TEST_STATUS], 'fail')
        assert.strictEqual(span.tags[TEST_SKIP_REASON], undefined)
        assert.strictEqual(span.tags[TEST_SESSION_EMPTY_REASON], undefined)
      }
    })

    it('preserves an all-skipped interactive Cypress run without summary statistics', async () => {
      const { testModuleSpan, testSessionSpan } = prepareRunFinalization()
      cypressPlugin.hasTestsReported = true
      cypressPlugin.testSuiteSpan = { finish: sinon.stub(), setTag: sinon.stub() }

      cypressPlugin.afterSpec(
        { relative: 'cypress/e2e/skipped-test.js' },
        { stats: { tests: 1, pending: 1 } }
      )
      await cypressPlugin.afterRun()

      for (const span of [testSessionSpan, testModuleSpan]) {
        assert.strictEqual(span.tags[TEST_STATUS], 'skip')
        assert.strictEqual(span.tags[TEST_SKIP_REASON], 'All tests were skipped')
        assert.strictEqual(span.tags[TEST_SESSION_EMPTY_REASON], 'all_tests_skipped')
      }
    })

    it('preserves a Cypress result error without summary statistics', async () => {
      const { testModuleSpan, testSessionSpan } = prepareRunFinalization()
      const resultError = new Error('Cypress failed to load the spec')
      cypressPlugin.testSuiteSpan = { finish: sinon.stub(), setTag: sinon.stub() }

      cypressPlugin.afterSpec(
        { relative: 'cypress/e2e/load-error.js' },
        { error: resultError }
      )
      await cypressPlugin.afterRun()

      for (const span of [testSessionSpan, testModuleSpan]) {
        assert.strictEqual(span.tags[TEST_STATUS], 'fail')
        assert.strictEqual(span.tags[TEST_SKIP_REASON], undefined)
        assert.strictEqual(span.tags[TEST_SESSION_EMPTY_REASON], undefined)
      }
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
      sinon.stub(cypressPlugin, '_now').returns(789)
      cypressPlugin.testSessionSpan = { context: () => ({ toTraceId: () => '123' }) }
      cypressPlugin.testSuiteSpan = testSuiteSpan
      const flush = sinon.stub().callsFake(callback => callback())
      cypressPlugin.tracer = {
        _tracer: {
          _exporter: {
            canUploadTestVideos: () => true,
            flush,
            uploadTestSuiteVideo: sinon.stub(),
          },
        },
      }
      cypressPlugin.uploadedVideoPaths = new Set()
      sinon.stub(cypressPlugin, 'ciVisEvent')
      let finishUpload
      const upload = sinon.stub(cypressPlugin, 'uploadTestSuiteVideo').returns(new Promise(resolve => {
        finishUpload = resolve
      }))

      const result = cypressPlugin.afterSpec(
        { relative: 'cypress/e2e/basic-fail.js' },
        { stats: { failures: 1, tests: 1 }, video: '/tmp/basic-fail.mp4' }
      )

      assert.strictEqual(result, undefined)
      sinon.assert.notCalled(upload)
      sinon.assert.notCalled(testSuiteSpan.finish)

      const afterRunPromise = cypressPlugin.afterRun({})

      sinon.assert.calledOnceWithExactly(upload, {
        filePath: '/tmp/basic-fail.mp4',
        testSessionId: '123',
        testSuiteId: '456',
      })
      sinon.assert.calledOnce(flush)
      sinon.assert.notCalled(testSuiteSpan.finish)

      finishUpload(VIDEO_UPLOAD_RESULT_UPLOADED)
      await afterRunPromise

      sinon.assert.calledTwice(flush)
      sinon.assert.calledOnceWithExactly(testSuiteSpan.finish, 789)
      sinon.assert.calledWith(testSuiteSpan.setTag, TEST_FAILURE_VIDEO_UPLOADED, 'true')
      sinon.assert.calledWith(testSuiteSpan.setTag, TEST_FAILURE_VIDEO_SCOPE, VIDEO_UPLOAD_SCOPE_TEST_SUITE)
    })

    it('finalizes a failed suite video when a user after:spec handler prevents after:run', async () => {
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
      assert.deepStrictEqual(cypressPlugin.pendingVideoUploads, [])
      sinon.assert.calledOnce(testSuiteSpan.finish)
      sinon.assert.calledWith(testSuiteSpan.setTag, TEST_FAILURE_VIDEO_UPLOAD_ERROR, 'true')
      sinon.assert.calledWith(testSuiteSpan.setTag, TEST_FAILURE_VIDEO_SCOPE, VIDEO_UPLOAD_SCOPE_TEST_SUITE)
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

    for (const [isTextTerminal, pluginMode] of [[false, false], [true, true], [false], [true]]) {
      for (const retries of [0, 2]) {
        const configDescription = `terminal=${isTextTerminal}, plugin=${pluginMode}, retries=${retries}`
        it(`only applies dynamic ATR in terminal mode (${configDescription})`, async () => {
          prepareRunFinalization()
          cypressPlugin.cypressConfig = { isTextTerminal: pluginMode, isInteractive: true }
          sinon.stub(cypressPlugin, 'isDynamicAtrEnabled').value(true)
          const tasks = cypressPlugin.getTasks()
          const hooks = {}
          const events = {}
          const currentTest = {
            id: 'test-1',
            title: 'fails',
            fullTitle: () => 'fails',
            state: 'failed',
            duration: 1,
            _retries: retries,
          }
          const runner = { runTests () {}, suite: { ctx: { currentTest } } }
          const task = sinon.stub().callsFake((name, args) => {
            const result = name === 'dd:testSuiteStart'
              ? tasks[name](args)
              : name === 'dd:afterEach' ? { dynamicAtrRetryCount: 3 } : {}
            return Promise.resolve(result)
          })

          runInNewContext(fs.readFileSync(
            path.join(__dirname, '../../packages/datadog-plugin-cypress/src/support.js'), 'utf8'
          ), {
            Cypress: {
              config: name => {
                if (name === 'retries') return retries
                assert.strictEqual(name, 'isTextTerminal')
                return isTextTerminal
              },
              on: (name, callback) => { events[name] = callback },
              mocha: {
                getRunner: () => runner,
                getRootSuite: () => ({ file: 'test.cy.js', eachTest: callback => callback(currentTest) }),
              },
            },
            cy: { task, on () {} },
            before: callback => { hooks.before = callback },
            beforeEach: callback => { hooks.beforeEach = callback },
            afterEach: callback => { hooks.afterEach = callback },
            after: callback => { hooks.after = callback },
          })

          await hooks.before()
          assert.strictEqual(currentTest._retries, isTextTerminal ? Math.max(1, retries) : retries)
          const entryPoints = [
            () => events['test:before:run']({}, currentTest),
            () => events['test:before:run:async']({}, currentTest),
            () => hooks.beforeEach.call({ currentTest }),
          ]
          for (const startTest of entryPoints) {
            currentTest._retries = retries
            await startTest()
            assert.strictEqual(currentTest._retries, isTextTerminal ? Math.max(1, retries) : retries)
          }

          await hooks.afterEach()
          for (const startTest of entryPoints) {
            currentTest._retries = retries
            await startTest()
            assert.strictEqual(currentTest._retries, isTextTerminal ? 3 : retries)
          }
          await hooks.after()
        })
      }

      for (const isDynamicAtrEnabled of [false, true]) {
        const configDescription = `terminal=${isTextTerminal}, plugin=${pluginMode}, dynamic=${isDynamicAtrEnabled}`
        it(`only accounts for ATR in terminal mode (${configDescription})`, () => {
          const { createSpan } = prepareRunFinalization()
          cypressPlugin.cypressConfig = { isTextTerminal: pluginMode, isInteractive: true }
          sinon.stub(cypressPlugin, 'isFlakyTestRetriesEnabled').value(true)
          sinon.stub(cypressPlugin, 'flakyTestRetriesCount').value(1)
          sinon.stub(cypressPlugin, 'isDynamicAtrEnabled').value(isDynamicAtrEnabled)
          sinon.stub(cypressPlugin, 'dynamicAtrBuckets').value([1, 1, 1, 1, 1])
          sinon.stub(cypressPlugin, 'getTestSpan').callsFake(createSpan)
          sinon.stub(cypressPlugin, '_now').returns(123)

          const testSuite = 'cypress/e2e/retries.js'
          const tasks = cypressPlugin.getTasks()
          tasks['dd:testSuiteStart']({ testSuite, isTextTerminal })
          const records = []
          const tests = []
          for (const state of ['failed', 'passed']) {
            const attempts = [{ state: 'failed' }, { state }]
            tests.push({ title: [state], state, attempts })
            for (const [attemptIndex, attempt] of attempts.entries()) {
              const test = { testSuite, testId: state, testName: state, state: attempt.state, duration: 1 }
              tasks['dd:beforeEach'](test)
              const span = cypressPlugin.activeTestSpan
              const result = tasks['dd:afterEach']({ test })
              records.push({ span, result, attemptIndex, state: attempt.state, tagsAfterEach: { ...span.tags } })
            }
          }

          cypressPlugin.afterSpec({ relative: testSuite }, { tests, stats: { tests: 2, failures: 1, passes: 1 } })

          for (const { span, result, attemptIndex, state, tagsAfterEach } of records) {
            const isRetry = attemptIndex > 0
            const hasFailedAllRetries = isTextTerminal && isRetry && state === 'failed' ? 'true' : undefined
            assert.strictEqual(span.tags[TEST_IS_RETRY], isRetry ? 'true' : undefined)
            assert.strictEqual(span.tags[TEST_RETRY_REASON], isRetry
              ? TEST_RETRY_REASON_TYPES[isTextTerminal ? 'atr' : 'ext']
              : undefined)
            assert.strictEqual(tagsAfterEach[TEST_HAS_FAILED_ALL_RETRIES], hasFailedAllRetries)
            assert.strictEqual(span.tags[TEST_HAS_FAILED_ALL_RETRIES], hasFailedAllRetries)
            const finalStatus = state === 'passed' ? 'pass' : 'fail'
            assert.strictEqual(span.tags[TEST_FINAL_STATUS], isRetry ? finalStatus : undefined)
            assert.deepStrictEqual(result, isTextTerminal && isDynamicAtrEnabled ? { dynamicAtrRetryCount: 1 } : null)
            sinon.assert.calledOnce(span.finish)
          }
        })
      }
    }

    for (const screenshot of [undefined, false, true]) {
      for (const video of [undefined, false, true]) {
        for (const captureEnabled of [false, true]) {
          const description = `screenshots=${screenshot}, videos=${video}, capture=${captureEnabled}`
          it(`only enables failure media capture for explicit flags (${description})`, async () => {
            const env = { ...process.env }
            delete env.DD_TEST_FAILURE_SCREENSHOTS_ENABLED
            delete env.DD_TEST_FAILURE_VIDEOS_ENABLED
            if (screenshot !== undefined) env.DD_TEST_FAILURE_SCREENSHOTS_ENABLED = String(screenshot)
            if (video !== undefined) env.DD_TEST_FAILURE_VIDEOS_ENABLED = String(video)
            sinon.stub(process, 'env').value(env)
            const config = {
              screenshotOnRunFailure: captureEnabled,
              video: captureEnabled,
              retries: { openMode: 0, runMode: 0 },
              version: '12.0.0',
            }
            const tracer = { _tracer: { _config: { isServiceUserProvided: false } } }

            const result = await cypressPlugin.init(tracer, config)

            assert.strictEqual(result.screenshotOnRunFailure, screenshot === true || captureEnabled)
            assert.strictEqual(result.video, video === true || captureEnabled)
          })
        }
      }
    }

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
